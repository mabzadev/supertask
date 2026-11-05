# Supertask

Supertask est une plateforme collaborative de bases de données, documents,
tableaux blancs, tableaux de bord et automatisations. Elle est adaptée à partir
de Baserow et déployée entièrement sur Cloudflare.

## Architecture

- **Frontend** : Nuxt 3 statique sur Cloudflare Pages (`supertask-web`)
- **API** : Hono sur Cloudflare Workers (`supertask`)
- **Données** : D1, R2, KV, Queues, Vectorize et Durable Objects
- **Collaboration** : Yjs/Hocuspocus via Durable Objects et WebSocket

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

Le Worker `supertask` est directement connecté à ce dépôt par Cloudflare Workers
Builds. Chaque push sur `main` déclenche dans Cloudflare :

1. l’installation figée des dépendances ;
2. les contrôles TypeScript, de parité et la suite Vitest ;
3. les migrations D1 distantes ;
4. le déploiement du Worker, uniquement si les contrôles ont réussi.

Le projet Pages `supertask-web` est lui aussi connecté directement à ce dépôt.
Chaque push sur `main` installe les dépendances frontend, exécute les suites
Core, Premium et Enterprise, génère le site puis le publie
sur le domaine de production.

GitHub Actions conserve une validation indépendante du backend et du frontend
sur les pull requests et les pushs, mais ne déploie plus directement sur
Cloudflare. Les deux projets Cloudflare suivent donc le même dépôt sans double
déploiement. Les secrets applicatifs restent exclusivement dans Cloudflare.
