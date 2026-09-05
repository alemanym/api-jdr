# api-jdr

API JSON statique générée automatiquement à partir de fiches de personnages en Markdown.

## Comment ça marche

1. Chaque fiche est un fichier `characters/<id>.md` avec un en-tête YAML (données) et un corps Markdown (texte libre).
2. À chaque push sur `main`, GitHub Actions exécute `scripts/build-api.js` qui génère des fichiers JSON dans `dist/api/`.
3. Le dossier `dist/` est publié sur GitHub Pages.

## Endpoints

| URL | Contenu |
|---|---|
| `/api/index.json` | Métadonnées (date de génération, liste des campagnes) |
| `/api/characters.json` | Liste de tous les personnages (sans le corps Markdown) |
| `/api/characters/{id}.json` | Fiche complète, avec `body` (Markdown) |
| `/api/campaigns/{campaign}.json` | Personnages d'une campagne |

Base : `https://alemanym.github.io/api-jdr`

## Ajouter ou modifier une fiche

Éditez ou créez un fichier dans `characters/` (directement sur GitHub via le bouton ✏️, ou en local puis `git push`). Le build échoue si un champ obligatoire manque (`name`, `class`, `level`, `hp`, `stats`).

Modèle minimal :

```markdown
---
id: mon-perso
name: Mon Perso
owner: pseudo-du-joueur
campaign: nom-de-campagne
class: Mage
level: 1
hp: { current: 10, max: 10 }
stats: { for: 8, dex: 12, con: 10, int: 17, sag: 13, cha: 11 }
inventory: []
tags: [pj]
---

## Background
...
```

## Développement local

```bash
npm install
npm run build      # génère dist/
npx serve dist     # optionnel : servir en local
```
