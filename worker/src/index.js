// Worker Cloudflare : édition des fiches via commit GitHub.
//
//   GET  /sheet/{id}          → { id, path, content, sha }   (Markdown brut + sha du fichier)
//   PUT  /sheet/{id}          → { ok, commit, sha }          (nécessite l'en-tête X-Player-Key)
//        body JSON : { content: "...markdown...", sha: "...", message?: "..." }
//   GET  /whoami              → { player }                   (teste un mot de passe)
//
// Variables (wrangler.jsonc) : REPO, BRANCH, SHEETS_DIR, ALLOWED_ORIGIN
// Secrets (wrangler secret put) : GITHUB_TOKEN, PLAYERS

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
        if (request.method === "GET") return json(await readSheet(id, env), 200, cors);
        if (request.method === "PUT") {
          const player = authenticate(request, env);
          const body = await request.json().catch(() => ({}));
          return json(await writeSheet(id, body, player, env), 200, cors);
        }
      }

      return json({ error: "Route inconnue" }, 404, cors);
    } catch (err) {
      const status = err.status ?? 500;
      return json({ error: err.message ?? "Erreur interne" }, status, cors);
    }
  },
};

// ---------- authentification ----------

function authenticate(request, env) {
  const key = request.headers.get("X-Player-Key") ?? "";
  let players = {};
  try {
    players = JSON.parse(env.PLAYERS ?? "{}");
  } catch {
    throw httpError(500, "Le secret PLAYERS n'est pas un JSON valide");
  }
  const player = players[key];
  if (!key || !player) throw httpError(401, "Mot de passe joueur invalide");
  return player;
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

async function readSheet(id, env) {
  const path = sheetPath(id, env);
  const res = await fetch(
    `https://api.github.com/repos/${env.REPO}/contents/${path}?ref=${env.BRANCH}`,
    { headers: ghHeaders(env) }
  );
  if (res.status === 404) throw httpError(404, `Fiche « ${id} » introuvable`);
  if (!res.ok) throw httpError(502, `GitHub a répondu ${res.status}`);
  const data = await res.json();
  return { id, path, content: decodeBase64(data.content), sha: data.sha };
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

  if (res.status === 409 || res.status === 422) {
    throw httpError(409, "La fiche a été modifiée entre-temps. Rechargez-la avant d'enregistrer.");
  }
  if (!res.ok) throw httpError(502, `GitHub a refusé l'écriture (${res.status})`);

  const data = await res.json();
  return { ok: true, commit: data.commit?.sha, sha: data.content?.sha, player };
}

// ---------- utilitaires ----------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Player-Key",
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
