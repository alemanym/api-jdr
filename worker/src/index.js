// Worker Cloudflare : édition des fiches via commit GitHub.
//
//   GET  /sheet/{id}          → { id, path, content, sha }   (Markdown brut + sha du fichier)
//        Renvoie un en-tête ETag. Si le client renvoie If-None-Match avec cet ETag et que la fiche
//        n'a pas changé, réponse 304 sans corps — et GitHub ne décompte pas la requête de son quota.
//   PUT  /sheet/{id}          → { ok, commit, sha }          (en-têtes X-Player-Name + X-Player-Key)
//        body JSON : { content: "...markdown...", sha: "...", message?: "..." }
//   GET  /whoami              → { player }                   (teste un couple nom / mot de passe)
//
// Variables (wrangler.jsonc) : REPO, BRANCH, SHEETS_DIR, ALLOWED_ORIGIN
// Secrets (wrangler secret put) : GITHUB_TOKEN, PLAYERS = { "Nom du joueur": "mot de passe", ... }
// Plusieurs joueurs peuvent partager le même mot de passe.

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      if (parts[0] === "whoami" && request.method === "GET") {
        const player = authenticate(request, env);
        return json({ player }, 200, cors);
      }

      if (parts[0] === "sheet" && parts[1]) {
        const id = safeId(parts[1]);
        if (request.method === "GET") {
          const ifNoneMatch = request.headers.get("If-None-Match");
          const result = await readSheet(id, env, ifNoneMatch);
          if (result === null) return new Response(null, { status: 304, headers: { ...cors, ETag: ifNoneMatch } });
          return json(result.data, 200, { ...cors, ETag: result.etag, "Cache-Control": "no-cache" });
        }
        if (request.method === "PUT") {
          const player = authenticate(request, env);
          const body = await request.json().catch(() => ({}));
          return json(await writeSheet(id, body, player, env), 200, cors);
        }
      }

      return json({ error: "Route inconnue" }, 404, cors);
    } catch (err) {
      const status = err.status ?? 500;
      const headers = { ...cors };
      if (err.retryAfter) headers["Retry-After"] = String(err.retryAfter);
      return json({ error: err.message ?? "Erreur interne", retryAfter: err.retryAfter }, status, headers);
    }
  },
};

// ---------- authentification ----------

function authenticate(request, env) {
  const name = decodeURIComponent(request.headers.get("X-Player-Name") ?? "").trim();
  const key = request.headers.get("X-Player-Key") ?? "";
  let players = {};
  try {
    players = JSON.parse(env.PLAYERS ?? "{}");
  } catch {
    throw httpError(500, "Le secret PLAYERS n'est pas un JSON valide");
  }
  // Comparaison insensible à la casse sur le nom, stricte sur le mot de passe.
  const entry = Object.entries(players).find(([n]) => n.toLowerCase() === name.toLowerCase());
  if (!name || !key || !entry || entry[1] !== key) {
    throw httpError(401, "Nom de joueur ou mot de passe invalide");
  }
  return entry[0];
}

// ---------- GitHub ----------

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "api-jdr-worker",
  };
}

function sheetPath(id, env) {
  return `${env.SHEETS_DIR}/${id}.md`;
}

// Cache mémoire très court : absorbe les rafales (plusieurs joueurs ouvrant la même fiche).
// Il vit le temps de l'instance du Worker ; ce n'est qu'une optimisation, jamais une garantie.
const CACHE_TTL_MS = 10_000;
const memCache = new Map(); // path → { data, etag, at }

async function readSheet(id, env, ifNoneMatch) {
  const path = sheetPath(id, env);

  const cached = memCache.get(path);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    if (ifNoneMatch && ifNoneMatch === cached.etag) return null;
    return cached;
  }

  const headers = ghHeaders(env);
  // On transmet l'ETag du client, ou celui du cache expiré : une réponse 304 est gratuite côté GitHub.
  const etagToSend = ifNoneMatch ?? cached?.etag;
  if (etagToSend) headers["If-None-Match"] = etagToSend;

  const res = await fetch(
    `https://api.github.com/repos/${env.REPO}/contents/${path}?ref=${env.BRANCH}`,
    { headers }
  );

  if (res.status === 304) {
    if (cached) { cached.at = Date.now(); return ifNoneMatch === cached.etag ? null : cached; }
    return null;
  }
  if (res.status === 404) throw httpError(404, `Fiche « ${id} » introuvable`);
  checkRateLimit(res);
  if (!res.ok) throw httpError(502, `GitHub a répondu ${res.status}`);

  const gh = await res.json();
  const entry = {
    data: { id, path, content: decodeBase64(gh.content), sha: gh.sha },
    etag: res.headers.get("ETag") ?? `"${gh.sha}"`,
    at: Date.now(),
  };
  memCache.set(path, entry);
  return entry;
}

// GitHub répond 403 ou 429 avec X-RateLimit-Remaining: 0 quand le quota horaire est épuisé.
function checkRateLimit(res) {
  if ((res.status === 403 || res.status === 429) && res.headers.get("X-RateLimit-Remaining") === "0") {
    const reset = Number(res.headers.get("X-RateLimit-Reset")) * 1000;
    const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    const e = httpError(429, `Quota GitHub épuisé — réessayez dans ${Math.ceil(retryAfter / 60)} min`);
    e.retryAfter = retryAfter;
    throw e;
  }
}

async function writeSheet(id, body, player, env) {
  if (typeof body.content !== "string" || !body.content.trim()) {
    throw httpError(400, "Le champ « content » est requis");
  }
  if (typeof body.sha !== "string") {
    throw httpError(400, "Le champ « sha » est requis (rechargez la fiche)");
  }
  if (body.content.length > 500_000) throw httpError(413, "Fiche trop volumineuse");

  const path = sheetPath(id, env);
  const message = (body.message?.trim() || `Mise à jour de ${id}`) + ` (par ${player})`;

  const res = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: encodeBase64(body.content),
      sha: body.sha,
      branch: env.BRANCH,
      committer: { name: player, email: `${slug(player)}@players.api-jdr.local` },
    }),
  });

  memCache.delete(path); // la prochaine lecture doit refléter le commit
  if (res.status === 409 || res.status === 422) {
    throw httpError(409, "La fiche a été modifiée entre-temps. Rechargez-la avant d'enregistrer.");
  }
  checkRateLimit(res);
  if (!res.ok) throw httpError(502, `GitHub a refusé l'écriture (${res.status})`);

  const data = await res.json();
  return { ok: true, commit: data.commit?.sha, sha: data.content?.sha, player };
}

// ---------- utilitaires ----------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Player-Name, X-Player-Key, If-None-Match",
    "Access-Control-Expose-Headers": "ETag, Retry-After",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// N'accepte que des identifiants du type "ling-hao" (pas de "../", pas de "/").
function safeId(raw) {
  const id = decodeURIComponent(raw);
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(id) || id.includes("..")) {
    throw httpError(400, "Identifiant de fiche invalide");
  }
  return id;
}

const slug = (s) =>
  String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

// GitHub renvoie le contenu en base64 (avec retours à la ligne) ; on gère l'UTF-8 correctement.
function decodeBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
