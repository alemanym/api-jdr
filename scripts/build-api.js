// Génère une API JSON statique à partir de fiches Markdown, sans imposer de format.
//
// Pour chaque fiche characters/*.md :
//   - le frontmatter YAML (s'il existe) est exposé tel quel, quels que soient les champs ;
//   - le corps Markdown est découpé par titres (#, ##, ###...) en `sections` ;
//   - dans chaque section, les tableaux Markdown deviennent des données (`tables`),
//     les listes `- **Clé** : valeur` deviennent `fields`, les autres puces `items` ;
//   - le Markdown brut est conservé (`body`, et `raw` par section).
//
// Sortie : dist/api/characters.json, dist/api/characters/{id}.json,
//          dist/api/campaigns/{campagne}.json, dist/api/index.json

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const SRC = "characters";
const OUT = "dist/api";

// Alias reconnus pour construire l'index. Ajoutez les vôtres si besoin.
const NAME_KEYS = ["name", "nom", "title", "titre"];
const CAMPAIGN_KEYS = ["campaign", "campagne", "campaigns", "campagnes"];
const PLAYER_KEYS = ["owner", "player", "joueur"];
const LEVEL_KEYS = ["level", "niveau", "niveau_pj"];

// ---------- utilitaires ----------

const slugify = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";

// Retire la mise en forme inline (**gras**, *italique*, `code`, ~~barré~~, [[liens]]).
const stripInline = (s) =>
  String(s)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[\[(.+?)\]\]/g, "$1")
    .trim();

// "8" → 8, "**10**" → 10, "10 / 10" reste une chaîne.
const coerce = (s) => {
  const v = stripInline(s);
  if (v === "") return null;
  if (/^-?\d+([.,]\d+)?$/.test(v)) return Number(v.replace(",", "."));
  if (/^(true|vrai|oui|yes)$/i.test(v)) return true;
  if (/^(false|faux|non|no)$/i.test(v)) return false;
  return v;
};

const firstOf = (obj, keys) => {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
};

// ---------- parseur Markdown minimal ----------

function parseTable(lines) {
  const rows = lines
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
  if (rows.length < 2) return null;

  const headers = rows[0].map((h, i) => stripInline(h) || `col${i + 1}`);
  const data = rows.slice(1).map((cells) =>
    Object.fromEntries(headers.map((h, i) => [h, coerce(cells[i] ?? "")]))
  );

  const table = { headers, rows: data };

  // Tableau à 2 colonnes (ex. Attribut | Valeur) → aussi une map {clé: valeur}.
  // La clé est raccourcie si elle contient une parenthèse : "FOR (Force)" → "FOR".
  if (headers.length === 2) {
    table.map = {};
    for (const row of data) {
      const rawKey = String(row[headers[0]] ?? "");
      const key = rawKey.replace(/\s*\(.*\)\s*$/, "").trim() || rawKey;
      table.map[key] = row[headers[1]];
    }
  }
  return table;
}

function parseSection(rawLines) {
  const section = { raw: rawLines.join("\n").trim(), fields: {}, items: [], tables: [] };
  let tableBuf = [];

  const flushTable = () => {
    if (tableBuf.length) {
      const t = parseTable(tableBuf);
      if (t) section.tables.push(t);
      tableBuf = [];
    }
  };

  for (const line of rawLines) {
    const l = line.trim();

    if (l.startsWith("|")) {
      tableBuf.push(l);
      continue;
    }
    flushTable();

    // Puce de premier niveau uniquement (les sous-puces restent dans `raw`).
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const text = bullet[1];
      // "- **Clé** : valeur"  ou  "- Clé : valeur"
      const kv = /^\*\*([^*]+?)\*\*\s*:\s+(.+)$/.exec(text) ?? /^([^*:]{1,60}?)\s*:\s+(.+)$/.exec(text);
      if (kv) {
        section.fields[stripInline(kv[1])] = coerce(kv[2]);
      } else {
        section.items.push(stripInline(text));
      }
    }
  }
  flushTable();

  // Nettoyage : n'expose pas les conteneurs vides.
  if (!Object.keys(section.fields).length) delete section.fields;
  if (!section.items.length) delete section.items;
  if (!section.tables.length) delete section.tables;
  return section;
}

function parseBody(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = {};
  const usedSlugs = new Set();
  let title = null;
  let current = null;
  let buffer = [];
  let preamble = [];

  const commit = () => {
    if (current) {
      sections[current.slug] = { ...current, ...parseSection(buffer) };
    } else if (buffer.length) {
      preamble = buffer;
    }
    buffer = [];
  };

  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      commit();
      const level = h[1].length;
      const heading = stripInline(h[2]);
      if (level === 1 && !title) title = heading;
      let slug = slugify(heading);
      let n = 2;
      while (usedSlugs.has(slug)) slug = `${slugify(heading)}-${n++}`;
      usedSlugs.add(slug);
      current = { title: heading, level, slug };
    } else {
      buffer.push(line);
    }
  }
  commit();

  return { title, preamble: preamble.join("\n").trim(), sections };
}

// ---------- build ----------

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync(`${OUT}/characters`, { recursive: true });
fs.mkdirSync(`${OUT}/campaigns`, { recursive: true });

const characters = [];
const warnings = [];

for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".md")).sort()) {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8");
  let data = {};
  let content = raw;
  try {
    ({ data, content } = matter(raw));
  } catch (e) {
    warnings.push(`${file} : frontmatter YAML illisible (${e.message.split("\n")[0]}) — fiche exposée sans métadonnées`);
  }

  const id = data.id ?? slugify(path.parse(file).name);
  const parsed = parseBody(content);
  const name = firstOf(data, NAME_KEYS) ?? parsed.title ?? id;

  let campaigns = firstOf(data, CAMPAIGN_KEYS) ?? [];
  if (!Array.isArray(campaigns)) campaigns = [campaigns];

  const character = {
    id,
    name,
    campaigns,
    player: firstOf(data, PLAYER_KEYS) ?? null,
    level: firstOf(data, LEVEL_KEYS) ?? null,
    meta: data, // frontmatter complet, tel quel
    title: parsed.title,
    preamble: parsed.preamble,
    sections: parsed.sections,
    body: content.trim(),
    file: `${SRC}/${file}`,
  };

  fs.writeFileSync(`${OUT}/characters/${id}.json`, JSON.stringify(character, null, 2));
  characters.push(character);
}

// Index : les champs communs + le frontmatter, sans le corps ni les sections.
const index = characters.map(({ sections, body, preamble, ...c }) => c);
fs.writeFileSync(`${OUT}/characters.json`, JSON.stringify(index, null, 2));

// Regroupement par campagne.
const byCampaign = {};
for (const c of index) {
  const keys = c.campaigns.length ? c.campaigns : ["sans-campagne"];
  for (const k of keys) (byCampaign[slugify(k)] ??= []).push(c);
}
for (const [campaign, list] of Object.entries(byCampaign)) {
  fs.writeFileSync(`${OUT}/campaigns/${campaign}.json`, JSON.stringify(list, null, 2));
}

fs.writeFileSync(
  `${OUT}/index.json`,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      characters: index.map(({ id, name }) => ({ id, name })),
      campaigns: Object.keys(byCampaign),
      endpoints: [
        "/api/characters.json",
        "/api/characters/{id}.json",
        "/api/campaigns/{campaign}.json",
      ],
      warnings,
    },
    null,
    2
  )
);

fs.writeFileSync(
  "dist/index.html",
  `<!doctype html><meta charset="utf-8"><title>api-jdr</title>
<h1>api-jdr</h1><p>API statique générée depuis les fiches Markdown.</p>
<ul><li><a href="api/index.json">api/index.json</a></li>
<li><a href="api/characters.json">api/characters.json</a></li></ul>`
);

if (warnings.length) console.warn("⚠️  " + warnings.join("\n⚠️  "));
console.log(`✅ ${characters.length} fiche(s) → ${OUT}`);
