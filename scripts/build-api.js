// Génère une API JSON statique à partir des fiches Markdown.
// Entrée : characters/*.md (frontmatter YAML + corps Markdown)
// Sortie : dist/api/...

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const SRC = "characters";
const OUT = "dist/api";

// Champs obligatoires dans le frontmatter — le build échoue s'il en manque.
const REQUIRED = ["name", "class", "level", "hp", "stats"];

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync(`${OUT}/characters`, { recursive: true });

const characters = [];
const errors = [];

for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".md"))) {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8");
  const { data, content } = matter(raw);
  const id = data.id ?? path.parse(file).name;

  const missing = REQUIRED.filter((k) => data[k] === undefined);
  if (missing.length) {
    errors.push(`${file} : champs manquants → ${missing.join(", ")}`);
    continue;
  }

  const character = {
    ...data,
    id,
    body: content.trim(),
    source: `${SRC}/${file}`,
  };

  fs.writeFileSync(
    `${OUT}/characters/${id}.json`,
    JSON.stringify(character, null, 2)
  );
  characters.push(character);
}

if (errors.length) {
  console.error("❌ Fiches invalides :\n  " + errors.join("\n  "));
  process.exit(1);
}

// Index allégé : liste des personnages sans le corps Markdown.
const index = characters.map(({ body, ...c }) => c);
fs.writeFileSync(`${OUT}/characters.json`, JSON.stringify(index, null, 2));

// Regroupement par campagne (pratique pour un bot ou un VTT).
const byCampaign = {};
for (const c of index) {
  const key = c.campaign ?? "sans-campagne";
  (byCampaign[key] ??= []).push(c);
}
fs.mkdirSync(`${OUT}/campaigns`, { recursive: true });
for (const [campaign, list] of Object.entries(byCampaign)) {
  fs.writeFileSync(`${OUT}/campaigns/${campaign}.json`, JSON.stringify(list, null, 2));
}

// Métadonnées de l'API.
fs.writeFileSync(
  `${OUT}/index.json`,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      characters: characters.length,
      campaigns: Object.keys(byCampaign),
      endpoints: [
        "/api/characters.json",
        "/api/characters/{id}.json",
        "/api/campaigns/{campaign}.json",
      ],
    },
    null,
    2
  )
);

// Page d'accueil minimale pour GitHub Pages.
fs.writeFileSync(
  "dist/index.html",
  `<!doctype html><meta charset="utf-8"><title>api-jdr</title>
<h1>api-jdr</h1><p>API statique générée depuis les fiches Markdown.</p>
<ul><li><a href="api/index.json">api/index.json</a></li>
<li><a href="api/characters.json">api/characters.json</a></li></ul>`
);

console.log(`✅ ${characters.length} fiche(s) → ${OUT}`);
