# OpenTabl

OpenTabl est une plateforme collaborative de bases de données, documents,
tableaux blancs, tableaux de bord et automatisations. Elle est adaptée à partir
de Baserow et déployée entièrement sur Cloudflare.

## Architecture

- **Frontend** : Nuxt 3 statique sur Cloudflare Pages (`opentabl-web`)
- **API** : Hono sur Cloudflare Workers (`opentabl`)
- **Données** : D1, R2, KV, Queues, Vectorize et Durable Objects
- **Collaboration** : Yjs/Hocuspocus via Durable Objects et WebSocket

Production :

- Application : <https://mbza.dev>
- Worker : <https://opentabl.mbza.workers.dev>
- Pages : <https://opentabl-web.pages.dev>

## Développement local

Prérequis : Node.js 22, npm, Yarn 1 et Wrangler 4.

```bash
npm ci
yarn --cwd frontend install --frozen-lockfile
npm run db:migrate:local
npm run dev
```

Dans un second terminal :

```bash
npm run frontend:dev
```

Les secrets locaux vont dans `.dev.vars` et les variables publiques du frontend
dans `frontend/.env`. Ces fichiers ne doivent jamais être commités.

## Vérifications

```bash
npm run check
npm test
yarn --cwd frontend test
yarn --cwd frontend generate
```

## Déploiement

Le Worker `opentabl` est directement connecté à ce dépôt par Cloudflare Workers
Builds. Chaque push sur `main` déclenche dans Cloudflare :

1. l’installation figée des dépendances ;
2. les contrôles TypeScript, de parité et la suite Vitest ;
3. les migrations D1 distantes ;
4. le déploiement du Worker, uniquement si les contrôles ont réussi.

GitHub Actions vérifie également le backend et le frontend sur les pull requests.
Sur `main`, il publie le build frontend validé sur le projet Direct Upload
`opentabl-web`, puis vérifie `mbza.dev`. Le secret GitHub
`CLOUDFLARE_API_TOKEN` est limité à Cloudflare Pages et la variable
`CLOUDFLARE_ACCOUNT_ID` désigne le compte `Mbza`.

Les deux systèmes suivent donc le même commit, sans double déploiement du
Worker. Les secrets applicatifs restent exclusivement dans Cloudflare.
