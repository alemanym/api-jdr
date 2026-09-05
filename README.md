# api-jdr

API JSON statique générée automatiquement à partir de fiches de personnages en Markdown, **sans format imposé**.

## Comment ça marche

1. Chaque fiche est un fichier `characters/<id>.md`. Le script accepte n'importe quelle fiche Markdown, avec ou sans en-tête YAML.
2. À chaque push sur `main`, GitHub Actions exécute `scripts/build-api.js` qui génère des fichiers JSON dans `dist/api/`.
3. Le dossier `dist/` est publié sur GitHub Pages.

Base : `https://alemanym.github.io/api-jdr`

## Endpoints

| URL | Contenu |
|---|---|
| `/api/index.json` | Métadonnées : liste des personnages, campagnes, avertissements de build |
| `/api/characters.json` | Liste de tous les personnages (index + frontmatter, sans le corps) |
| `/api/characters/{id}.json` | Fiche complète |
| `/api/campaigns/{campagne}.json` | Personnages d'une campagne |

L'`id` est celui du frontmatter s'il existe, sinon le nom du fichier.

## Ce que contient une fiche JSON

```jsonc
{
  "id": "ling-hao",
  "name": "Líng-Hào",          // frontmatter name/nom/title, sinon premier titre "# ..."
  "campaigns": ["mojave-tbd"],  // frontmatter campaign/campagne/campagnes
  "player": "Marc",             // frontmatter owner/player/joueur
  "level": 1,                   // frontmatter level/niveau/niveau_pj
  "meta": { ... },              // TOUT le frontmatter, tel quel
  "title": "Líng-Hào (靈豪)",   // premier titre de niveau 1
  "preamble": "...",            // texte avant le premier titre
  "sections": {                 // une entrée par titre (#, ##, ###...)
    "s-p-e-c-i-a-l": {
      "title": "S.P.E.C.I.A.L.", "level": 2,
      "tables": [{
        "headers": ["Attribut", "Valeur"],
        "rows": [{ "Attribut": "FOR (Force)", "Valeur": 8 }, ...],
        "map": { "FOR": 8, "PER": 5, ... }   // pour les tableaux à 2 colonnes
      }],
      "raw": "..."              // Markdown brut de la section
    },
    "identite": {
      "fields": { "Désignation": "...", "Origine": "..." },  // puces "- **Clé** : valeur"
      "items": ["..."],                                     // autres puces
      "raw": "..."
    }
  },
  "body": "...",                // Markdown complet
  "file": "characters/ling-hao.md"
}
```

Règles de conversion :
- Les **tableaux** Markdown deviennent `tables[].rows` (un objet par ligne, clés = en-têtes). Les tableaux à deux colonnes ont en plus une `map` clé → valeur ; les clés du type `FOR (Force)` sont raccourcies en `FOR`.
- Les **puces** `- **Clé** : valeur` deviennent `fields`, les autres puces `items`.
- Les nombres sont convertis (`"8"` → `8`) ; la mise en forme inline (`**`, `*`, `` ` ``, `~~`, `[[ ]]`) est retirée des valeurs.
- Le Markdown brut est toujours conservé (`raw` par section, `body` global) : rien n'est perdu.

Exemple d'accès côté client :

```js
const r = await fetch("https://alemanym.github.io/api-jdr/api/characters/ling-hao.json");
const pj = await r.json();
pj.sections["s-p-e-c-i-a-l"].tables[0].map.AGI   // 9
pj.sections["etat-courant"].tables[0].map.PV     // "10 / 10 (...)"
pj.meta.pe                                        // 89
```

## Ajouter ou modifier une fiche

Déposez ou éditez un `.md` dans `characters/` (bouton ✏️ sur GitHub, ou `git push`). Un en-tête YAML est recommandé pour `nom`, `joueur`, `campagnes`, mais pas obligatoire. Si le YAML est illisible, la fiche est quand même publiée et un avertissement apparaît dans `/api/index.json`.

## Développement local

```bash
npm install
npm run build      # génère dist/
```
