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

Le workflow GitHub Actions `CI` valide le backend et le frontend sur chaque pull
request et chaque push. GitHub déclenche le workflow, mais ses jobs s’exécutent
sur des runners auto-hébergés portant le label `supertask` : sans runner en
ligne, la CI reste en attente. Sur `main`, une fois les deux validations
réussies, il :

1. applique les migrations D1 distantes ;
2. déploie le Worker `supertask` ;
3. publie le site généré sur le projet Pages `supertask-web`.

Le déploiement utilise les secrets de dépôt `CLOUDFLARE_API_TOKEN` et
`CLOUDFLARE_ACCOUNT_ID`. Les secrets applicatifs du Worker (`SECRET_KEY`,
`JWT_SIGNING_KEY`, SMTP…) restent exclusivement dans Cloudflare.
