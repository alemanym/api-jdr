# Worker d'édition

Petit service Cloudflare Workers qui permet à la page web d'enregistrer une fiche :
il vérifie le mot de passe du joueur puis commite le `.md` sur GitHub avec un token
qu'il est seul à détenir.

## Routes

| Méthode | Route | En-tête | Réponse |
|---|---|---|---|
| GET | `/sheet/{id}` | — | `{ id, path, content, sha }` |
| PUT | `/sheet/{id}` | `X-Player-Key` | `{ ok, commit, sha, player }` — body `{ content, sha, message? }` |
| GET | `/whoami` | `X-Player-Key` | `{ player }` |

Le `sha` renvoyé par GET doit être renvoyé tel quel dans le PUT : si quelqu'un a modifié
la fiche entre-temps, GitHub refuse et le Worker répond 409.

## Déploiement (une fois)

1. Compte Cloudflare gratuit : https://dash.cloudflare.com/sign-up
2. Token GitHub : https://github.com/settings/personal-access-tokens → *Generate new token*
   (fine-grained), repository `api-jdr` uniquement, permission **Contents : Read and write**.
3. Dans ce dossier :
   ```bash
   npm install
   npx wrangler login                 # ouvre le navigateur
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put PLAYERS    # coller : {"mot-de-passe-marc":"Marc","mot-de-passe-alice":"Alice"}
   npx wrangler deploy                # affiche l'URL https://api-jdr-edit.<compte>.workers.dev
   ```
4. Coller cette URL dans `site/index.html` (`const WORKER = "..."`), commit.

Test rapide : `curl https://api-jdr-edit.<compte>.workers.dev/sheet/ling-hao`

## Ajouter ou changer un joueur

`npx wrangler secret put PLAYERS` à nouveau, avec le JSON complet mis à jour.

## Développement local

Créer `worker/.dev.vars` (ignoré par git) :
```
GITHUB_TOKEN=github_pat_...
PLAYERS={"test":"Testeur"}
```
puis `npx wrangler dev` → http://localhost:8787
