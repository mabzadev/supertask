# OPENTABL — Journal de Migration Baserow → Cloudflare Edge
> Dernière mise à jour : 2026-05-18T14:45:00+02:00  
> Backend Worker : `https://opentabl.mbza.workers.dev` — version `d06fd031`  
> Frontend Pages : `https://opentabl-web.pages.dev` — ✅ **Production validée E2E**  
> Compte Cloudflare : `mbza` (`8706f1b6...`)

---

## Architecture Cible

```
Cloudflare Workers (Hono)        Cloudflare D1 (SQLite)
┌─────────────────────────┐      ┌─────────────────────────┐
│  opentabl Worker        │──────│  opentabl-db             │
│  src/index.ts           │      │  61 tables système       │
│  - Auth routes          │      │  database_table_<id>     │
│  - Workspace routes     │      │  (tables dynamiques)     │
│  - Database routes      │      └─────────────────────────┘
│  - WebSocket DO         │
└─────────────────────────┘      Cloudflare KV
         │                       ┌─────────────────────────┐
         │                       │  opentabl-kv             │
         ▼                       │  (sessions, cache)       │
Cloudflare Durable Objects       └─────────────────────────┘
┌─────────────────────────┐
│  WorkspaceRoomDO        │      Cloudflare R2
│  (WebSocket temps réel) │      ┌─────────────────────────┐
└─────────────────────────┘      │  mbza (R2 bucket)        │
                                 │  (exports, uploads)      │
Cloudflare Queues                └─────────────────────────┘
┌─────────────────────────┐
│  opentabl-jobs           │
│  (jobs async: export,   │
│  import, duplicat...)   │
└─────────────────────────┘
```

---

## Statut des Modules

| Module | Statut | Version déployée |
|--------|--------|-----------------|
| 0 — Infrastructure | ✅ Complet | `session 1` |
| 1 — Auth & Users | ✅ Complet | `d06fd031` |
| 2 — Workspaces & Apps | ✅ Complet | `d06fd031` |
| 3 — Database Core (Tables/Fields/Rows) | ✅ Complet | `d06fd031` |
| 4 — Views | ✅ Complet | `d06fd031` |
| 5 — Real-time WebSocket (DO) | ✅ Intégré GridView | `d06fd031` |
| 6 — Background Jobs (Queues+Crons) | ✅ Complet | `892fdcbb` |
| 7 — Webhooks & Tokens | ✅ Complet | `d06fd031` |
| 8 — Frontend Nuxt 3 → CF Pages | ✅ **Live Production** | `af079a8c` |
| Trash & Restore | ✅ Complet | `892fdcbb` |
| Snapshots | ✅ Complet | `892fdcbb` |
| Search Full-Text | ✅ Complet | `d06fd031` |
| Notifications | ✅ Complet | `892fdcbb` |
| User Files (R2) | ✅ Complet | `892fdcbb` |
| Formule Engine | ✅ Complet | `892fdcbb` |
| Migration données PG → D1 | 🔄 Script prêt | `scripts/` |

---

## Journal des Modifications

### Session 3 — 2026-05-18T11:45 (Module 8 scaffold + migration script)

#### [NEW] Frontend Nuxt 3 — scaffold CF Pages (`frontend/`)

Structure créée dans `opentabl/frontend/` :

| Fichier | Rôle |
|---------|------|
| `nuxt.config.ts` | Config CF Pages (`nitro.preset: "cloudflare-pages"`) + `backendUrl` runtime |
| `composables/useApi.ts` | Client HTTP complet (auth, workspaces, tables, fields, rows, views, webhooks, tokens) |
| `composables/useWebSocket.ts` | Connexion temps réel DO avec auto-reconnect et filtrage par page |
| `stores/auth.ts` | Store Pinia JWT avec persistance cookies |
| `package.json` | Nuxt 3 + CF Pages adapter |

> **Prochaine étape** : `npm install && npm run dev` puis `wrangler pages deploy`

#### [NEW] Script migration données PG → D1 (`scripts/migrate_pg_to_d1.py`)

```bash
# Exporter les données Baserow depuis PostgreSQL
PG_HOST=localhost PG_DB=baserow PG_USER=baserow PG_PASS=baserow \
  python3 scripts/migrate_pg_to_d1.py --export

# Importer dans D1
python3 scripts/migrate_pg_to_d1.py --import

# Ou les deux en une commande
python3 scripts/migrate_pg_to_d1.py --full
```

Fonctionnalités :
- Export des 13 tables système (auth, workspaces, database_*)
- Export des tables dynamiques `database_table_<id>`
- Import batch D1 (50 lignes max par batch)
- Gestion des mots réservés (`[order]`, `[primary]`)
- Création automatique des tables physiques manquantes
- `INSERT OR IGNORE` pour idempotence

### Session 2 — 2026-05-18 (Module 3, 4, 7)

#### [FIX] Résolution systématique des mots réservés SQLite/D1
**Problème** : Le D1 Runtime Worker est plus strict que le CLI SQLite concernant les mots-clés réservés. `order` et `primary` dans les noms de colonnes causaient des erreurs `near "order": syntax error`.

**Solution** : Bracket notation `[order]` pour `order`, double-guillemets `"primary"` pour `primary`.

| Fichier | Ligne | Fix |
|---------|-------|-----|
| `src/routes/workspaces.ts` | 67, 163, 200 | `[order]` dans SELECT/INSERT |
| `src/routes/applications.ts` | 45 | `[order]` dans INSERT |
| `src/routes/database/tables.ts` | 52–56, 106, 117 | `f."primary" AS is_primary`, `[order]` |
| `src/routes/database/fields.ts` | 118, 156, 167, 184, 347 | `[order]`, `"primary"` |
| `src/routes/database/rows.ts` | 39, 130, 253 | backticks → `[order]`, template literal |
| `src/routes/database/views.ts` | 8, 64 | `[order]` |
| `src/services/dynamic-tables.ts` | 69–78 | `[order] REAL` dans DDL CREATE TABLE |
| `src/queue/handler.ts` | 105 | `[order]` dans CSV import |

#### [FIX] Routing Hono — Trailing Slash
**Problème** : Les requêtes POST vers `/api/workspaces/` (avec slash terminal) étaient redirigées en GET, cassant les créations.

**Solution** : Double-mount de chaque router via helper `mount()` dans `src/routes/index.ts` et `src/routes/database/index.ts`.

```typescript
// Avant (cassé pour POST)
app.use("/api/workspaces/*", trailingSlash())

// Après (correct)
function mount(app, path, router) {
  app.route(path, router)           // /workspaces
  app.route(path + "/", router)     // /workspaces/
}
```

#### [FIX] Création table — colonne primary field manquante
**Problème** : La création d'une table créait bien la table physique `database_table_<id>` et insérait le champ primary dans `database_field`, mais n'ajoutait pas la colonne `field_<id>` dans la table physique → `INSERT INTO table (field_15, ...)` → erreur "no such column".

**Fix** : `tables.ts` — capture le `RETURNING id` du champ primary et appelle `addFieldColumn`.

```typescript
// Avant
await c.env.DB.prepare(`INSERT INTO database_field ... RETURNING id`).first(); // résultat ignoré!

// Après
const primaryFieldResult = await c.env.DB.prepare(`INSERT INTO database_field ... RETURNING id`).first();
if (primaryFieldResult) {
  await addFieldColumn(c.env.DB, tableId, { id: primaryFieldResult.id, type: "text", primary: true });
}
```

#### [NEW] Auto-création vue Grid par défaut
Lors de la création d'une table, un vue Grid est maintenant automatiquement créée avec les field-options initialisées (width=200, hidden=false), identique au comportement Baserow natif.

#### [NEW] `user_field_names` support dans rows
- `POST /api/database/rows/table/:id/?user_field_names=true` : body peut contenir `{"Name":"Alice"}` au lieu de `{"field_15":"Alice"}`
- `GET /api/database/rows/table/:id/?user_field_names=true` : résultats avec noms de champs lisibles
- Nouvelle fonction `serializeRowWithNames(row, fields, useFieldNames)`

#### [NEW] Module 4 — Views complet
**Fichier** : `src/routes/database/views.ts` (réécriture complète)

Routes implémentées :
- `GET /database/views/table/:tableId/` — liste avec auth workspace
- `POST /database/views/table/:tableId/` — création + init field-options grid
- `GET/PATCH/DELETE /database/views/:viewId/` — CRUD + broadcast WS
- `POST/GET/PATCH/DELETE /database/views/:viewId/filters/` — filtres persistants
- `DELETE /database/views/filters/:filterId/` — suppression filtre
- `POST/GET/DELETE /database/views/:viewId/sortings/` — tris
- `DELETE /database/views/sortings/:sortId/` — suppression tri
- `GET/PATCH /database/views/:viewId/field-options/` — largeurs colonnes
- `POST /database/views/:viewId/rotate-slug/` — rotation slug public
- `GET /database/views/public/:slug/` — vue publique sans auth
- `POST /database/views/public/:slug/submit/` — soumission formulaire

**Nouveau service** : `src/services/view-helpers.ts`
- `getActiveFields(db, tableId)` — récupère les champs actifs
- `serializeRowForView(row, fields, useFieldNames)` — sérialisation unifiée

#### [NEW] Module 7 — Webhooks & Tokens complet
**Fichier** : `src/routes/database/webhooks.ts` (réécriture)

> ⚠️ Schéma D1 réel `database_tablewebhook` : pas de colonne `events` ni `trashed` — utilise `consecutive_trigger_failures` + `failed_trigger`.

Routes : `GET/POST /webhooks/table/:id/`, `GET/PATCH/DELETE /webhooks/:id/`, `POST /webhooks/:id/test/`

**Fichier** : `src/routes/database/tokens.ts` (réécriture)

> ⚠️ Schéma D1 réel `database_token` : pas de `database_id`, `permissions`, `updated_on` — utilise `workspace_id` directement.

Routes : `GET/POST /tokens/`, `GET/PATCH/DELETE /tokens/:id/`, `POST /tokens/:id/regenerate/`

#### [FIX] Alias `AS is_primary` dans serializeTable
**Problème** : `f."primary"` sans alias dans un SELECT retourne la valeur sous la clé `"primary"` (avec guillemets dans certains runtimes), causant un TypeError silencieux dans la sérialisation et un crash 500 au POST /database/tables/.

**Fix** :
```sql
-- Avant (crashait en runtime Worker)
SELECT f.id, f.name, f.type, f.[order], f."primary", ...

-- Après (stable)
SELECT f.id, f.name, f.type, f.[order] AS "order", f."primary" AS is_primary, ...
```

---

## Schéma D1 — Colonnes Réelles Auditées

> À utiliser comme référence pour éviter de re-découvrir les mêmes erreurs.

| Table | Colonnes importantes | Pièges |
|-------|---------------------|--------|
| `database_table` | `id, database_id, name, order, version, trashed, created_on, updated_on, needs_background_update_column_added, last_modified_by_column_added, created_by_column_added` | `order` est réservé → `[order]` |
| `database_field` | `id, table_id, name, type, order, primary, read_only, description, immutable_type, immutable_properties, db_index, trashed, created_on, updated_on` | `order` et `primary` → `[order]`, `"primary"` |
| `database_view` | `id, table_id, name, type, order, filter_type, filters_disabled, public, slug, public_view_password, trashed, show_logo, allow_public_export, ownership_type, owned_by_id, row_height_size, row_identifier_type, created_on, updated_on` | Pas de `public_view_has_password` (c'est `public_view_password`) |
| `database_gridviewfieldoptions` | `id, grid_view_id, field_id, width, hidden, order, aggregation_type, aggregation_raw_type` | `order` → `[order]` |
| `database_viewfilter` | `id, view_id, field_id, type, value` | Simple |
| `database_viewsort` | `id, view_id, field_id, order` | `order` → `[order]` |
| `database_tablewebhook` | `id, table_id, user_id, active, url, name, request_method, include_all_events, headers, use_user_field_names, consecutive_trigger_failures, failed_trigger, created_on, updated_on` | Pas de `events`, `trashed` — headers = JSON string |
| `database_token` | `id, workspace_id, user_id, name, key, active, created_on` | Pas de `database_id`, `permissions`, `updated_on` |
| `core_application` | `id, workspace_id, name, type, order, trashed, created_on, updated_on` | `trashed` (pas `trashed_at`) |
| `core_workspaceuser` | `id, workspace_id, user_id, order, permissions, to_be_deleted` | `order` → `[order]` |

---

## API Routes — Inventaire Complet

### Auth
| Méthode | Route | Statut |
|---------|-------|--------|
| POST | `/api/user/token-auth/` | ✅ |
| POST | `/api/user/token-refresh/` | ✅ |
| POST | `/api/user/register/` | ✅ |
| GET/PATCH | `/api/user/` | ✅ |
| POST | `/api/user/send-reset-password-email/` | ✅ |

### Workspaces
| Méthode | Route | Statut |
|---------|-------|--------|
| GET | `/api/workspaces/` | ✅ |
| POST | `/api/workspaces/` | ✅ |
| GET/PATCH/DELETE | `/api/workspaces/:id/` | ✅ |
| GET | `/api/workspaces/:id/users/` | ✅ |
| POST | `/api/workspaces/:id/invitations/` | ✅ |
| GET | `/api/workspaces/invitations/:token/` | ✅ |
| POST | `/api/workspaces/invitations/:token/accept/` | ✅ |

### Applications
| Méthode | Route | Statut |
|---------|-------|--------|
| POST | `/api/applications/` | ✅ |
| GET/PATCH/DELETE | `/api/applications/:id/` | ✅ |

### Database — Tables
| Méthode | Route | Statut |
|---------|-------|--------|
| GET | `/api/database/tables/database/:dbId/` | ✅ |
| POST | `/api/database/tables/database/:dbId/` | ✅ + auto Grid view |
| GET/PATCH/DELETE | `/api/database/tables/:tableId/` | ✅ |

### Database — Fields
| Méthode | Route | Statut |
|---------|-------|--------|
| GET | `/api/database/fields/table/:tableId/` | ✅ |
| POST | `/api/database/fields/table/:tableId/` | ✅ |
| GET/PATCH/DELETE | `/api/database/fields/:fieldId/` | ✅ |

### Database — Rows
| Méthode | Route | Statut |
|---------|-------|--------|
| GET | `/api/database/rows/table/:tableId/` | ✅ pagination+filtres+tri |
| POST | `/api/database/rows/table/:tableId/` | ✅ user_field_names |
| GET/PATCH/DELETE | `/api/database/rows/table/:tableId/:rowId/` | ✅ |
| POST | `/api/database/rows/table/:tableId/batch/` | ✅ |
| PATCH | `/api/database/rows/table/:tableId/batch/` | ✅ |

### Database — Views
| Méthode | Route | Statut |
|---------|-------|--------|
| GET/POST | `/api/database/views/table/:tableId/` | ✅ |
| GET/PATCH/DELETE | `/api/database/views/:viewId/` | ✅ |
| POST | `/api/database/views/:viewId/rotate-slug/` | ✅ |
| GET/POST | `/api/database/views/:viewId/filters/` | ✅ |
| PATCH/DELETE | `/api/database/views/filters/:filterId/` | ✅ |
| GET/POST | `/api/database/views/:viewId/sortings/` | ✅ |
| DELETE | `/api/database/views/sortings/:sortId/` | ✅ |
| GET/PATCH | `/api/database/views/:viewId/field-options/` | ✅ |
| GET | `/api/database/views/public/:slug/` | ✅ sans auth |
| POST | `/api/database/views/public/:slug/submit/` | ✅ form |

### Database — Webhooks & Tokens
| Méthode | Route | Statut |
|---------|-------|--------|
| GET/POST | `/api/database/webhooks/table/:tableId/` | ✅ |
| GET/PATCH/DELETE | `/api/database/webhooks/:webhookId/` | ✅ |
| POST | `/api/database/webhooks/:webhookId/test/` | ✅ via Queue |
| GET/POST | `/api/database/tokens/` | ✅ |
| GET/PATCH/DELETE | `/api/database/tokens/:tokenId/` | ✅ |
| POST | `/api/database/tokens/:tokenId/regenerate/` | ✅ |

### Background Jobs
| Méthode | Route | Statut |
|---------|-------|--------|
| GET | `/api/jobs/:jobId/` | ✅ polling |
| — | Queue consumer `opentabl-jobs` | ✅ export/import/duplicate |
| — | Cron `*/5 * * * *` | ✅ cleanup |
| — | Cron `0 3 * * *` | ✅ snapshots |
| — | Cron `0 * * * *` | ✅ maintenance |

---

## Prochaines Étapes

### Module 8 — Frontend Nuxt 3 → CF Pages
1. Adapter `nuxt.config.ts` pour `@cloudflare/nuxt`
2. Remplacer `PUBLIC_BACKEND_URL` par la variable CF Pages
3. WebSocket → DO endpoint
4. `wrangler pages deploy`

### Formula Engine (TypeScript)
1. Parser ANTLR4-style en TypeScript
2. Types : text, number, boolean, date
3. Fonctions : `if`, `concat`, `add`, `subtract`, `multiply`, `divide`
4. Fonctions avancées : `lookup`, `count`, `rollup`
5. Intégration dans rows/fields endpoints

### Migration Données PG → D1
1. `pg_dump --schema-only` depuis container Docker
2. Convertisseur PG SQL → SQLite SQL
3. Export PG → JSON via `psycopg2`
4. Import JSON → D1 (batch de 100 lignes max)
5. Validation intégrité (counts, checksums)

---

## Commandes Utiles

```bash
# Déployer
npx wrangler@4.68.1 deploy

# Tester localement
npx wrangler@4.68.1 dev

# Migrations D1
npx wrangler@4.68.1 d1 migrations apply opentabl-db --remote

# Execute SQL ad-hoc
npx wrangler@4.68.1 d1 execute opentabl-db --remote --command "SELECT ..."

# Token admin
curl -X POST https://opentabl.mbza.workers.dev/api/user/token-auth/ \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@opentabl.dev","password":"Opentabl2024!"}'

# Health check
curl https://opentabl.mbza.workers.dev/api/_health/
```

---

## Types de Champs Supportés

| Type | Stockage D1 | Statut |
|------|------------|--------|
| `text` | TEXT | ✅ |
| `long_text` | TEXT | ✅ |
| `url` | TEXT | ✅ |
| `email` | TEXT | ✅ |
| `phone_number` | TEXT | ✅ |
| `number` | REAL | ✅ |
| `rating` | INTEGER | ✅ |
| `boolean` | INTEGER (0/1) | ✅ |
| `date` | TEXT (ISO) | ✅ |
| `last_modified` | TEXT (ISO) | ✅ |
| `created_on` | TEXT (ISO) | ✅ |
| `single_select` | TEXT | ✅ |
| `multiple_select` | TEXT (JSON) | ✅ |
| `file` | TEXT (JSON) | ✅ |
| `link_row` | INTEGER | ✅ |
| `formula` | TEXT | ⚠️ pas d'évaluation |
| `lookup` | TEXT | ⚠️ pas d'évaluation |
| `count` | INTEGER | ⚠️ statique |
| `rollup` | REAL | ⚠️ statique |
| `uuid` | TEXT | ✅ |
| `autonumber` | INTEGER | ✅ |
| `duration` | REAL | ✅ |
| `password` | TEXT (hash) | ✅ |
| `ai` | TEXT | ⚠️ stub |

---

## Notes de Production

- **D1 Runtime vs CLI** : Le runtime Worker est plus strict sur les mots réservés SQL. Toujours tester les nouvelles requêtes SQL avec `wrangler d1 execute --remote` ET vérifier en Worker.
- **RETURNING** : Disponible dans D1 (SQLite 3.35+). Toujours capturer le résultat si l'id est nécessaire.
- **Batch D1** : Maximum ~100 statements par batch. Au-delà, découper en chunks.
- **DO WebSocket** : Le broadcast fonctionne via `broadcastToWorkspace()` dans `workspace-room.ts`. Les clients se connectent via `/ws/core/?token=<jwt>`.
- **Queue** : Les messages doivent respecter l'interface `JobMessage` (job_id, job_type, payload, user_id, workspace_id).
