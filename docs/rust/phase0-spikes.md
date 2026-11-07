# Phase 0 : spikes workers-rs

7 novembre 2026

Le Worker Rust (`crates/st-worker`, workers-rs 0.8.7) tourne en local devant le Worker TS et reprend déjà deux routes à l'identique : la connexion et la liste des lignes. Toutes les briques Cloudflare du plan marchent depuis Rust, trois d'entre elles par interop JS faute de type dans workers-rs. Le SAML est faisable en pur Rust avec `saml-rs`, mais pas avec `samael`.

Chaque brique a une route de test `/__spike/<nom>`, compilée seulement avec la feature `spikes` (que seul le `wrangler.toml` local active) : un build de production ne les contient pas.

| Brique | Support workers-rs | Testé en local | Résultat | Repli |
| --- | --- | --- | --- | --- |
| D1 | Oui (feature `d1`) : `prepare`, `bind`, `first`, `all`, `run`, `batch` | Oui, `/__spike/d1` et les deux routes portées | OK, y compris `batch` et l'UTF-8. D1 refuse `sqlite_version()`, comme côté TS. | — |
| KV | Oui (`KvStore`) | Oui, `/__spike/kv` | `put` avec TTL, `get`, `list` par préfixe, `delete` : OK | — |
| R2 | Oui (`Bucket`) | Oui, `/__spike/r2` | `put`, `get`, `head`, `delete` : OK. Multipart : une part de 5 Mio et une de 3 octets donnent un objet de 5 242 883 octets (etag en `-2`) | — |
| Queues, envoi | Oui (feature `queue`, `Queue::send`) | Oui, file dédiée `supertask-rs-spike` | OK. Piège : un `serde_json::Value` part en `Map` JS ; il faut des structs pour garder le format que lit le consommateur TS | — |
| Queues, consommation | Oui (`#[event(queue)]`) | Oui, même file | Message reçu et acquitté en environ 1 s | — |
| Durable Objects, stockage SQLite | Oui (`#[durable_object]`, `storage().sql()`) | Oui, `/__spike/do` (migration `new_sqlite_classes`) | Table créée, insertion, `COUNT(*)` : OK | — |
| Durable Objects, WebSocket | Oui (API d'hibernation : `accept_web_socket`, `websocket_message`) | Oui, `/__spike/ws` (banc différentiel) | Écho OK. Les codes 1005 et 1006 ne peuvent pas être renvoyés à la fermeture | — |
| WebSocket transmis au Worker TS | Pas d'API dédiée : l'objet `Response` JS du service binding est rendu tel quel | Oui, `/ws/core/` à travers le Worker Rust | 101, message d'authentification et ping/pong identiques à une connexion directe au TS | — |
| Workers AI | Oui (`Ai::run`) | Oui, en distant (wrangler dev passe toujours par Cloudflare) | Embedding `bge-small-en-v1.5` : vecteur `[1, 384]`. Même piège `Map` : entrées en structs | — |
| Vectorize | Non, pas de type ; interop JS possible | Non : pas de simulateur local (« not supported ») et le mode distant viserait l'index de production | Le binding expose `query`, `insert`, `upsert`, `describe`, `getByIds`, `deleteByIds` | Interop JS sur le binding, ou API REST ; à valider sur un index de test distant |
| Browser Rendering | Pas de type dédié, mais c'est un `Fetcher` (`env.service("BROWSER")`) | Oui, en distant | `GET /v1/limits` répond 200 (sessions, quotas). Reste à écrire le client CDP que `@cloudflare/puppeteer` fournit en TS | API REST Browser Rendering (prévue au plan) |
| Images | Non, pas de type ; interop JS | Oui, en local, `/__spike/images` | `IMAGES.info()` sur un PNG 1×1 : format, taille, dimensions | Interop JS ; transformations à valider |
| SAML (`samael` 0.0.22) | — | Compilation `wasm32-unknown-unknown` | Échec : dépend toujours d'`openssl-sys` et, pour les signatures, de libxml2 et xmlsec1 (C). Sans la feature `xmlsec`, la crate ne compile même plus | — |
| SAML (`saml-rs` 0.6.1, `xml-sec` 0.6.0) | — | Compilation `wasm32-unknown-unknown` | Les deux compilent, avec `getrandom` en `wasm_js` et `uuid` en `js`. `saml-rs` fait SP et IdP, XML-DSig et C14N via `bergshamra`, sans C | `saml-rs` est pré-1.0 et non audité : une connexion SSO de test reste à faire, sinon le SSO reste dans un Worker TS minimal |

## Le Worker Rust devant le Worker TS

Toute requête arrive au Worker Rust. Ce qu'il ne traite pas part au Worker TS par le service binding `LEGACY` : méthode, en-têtes, corps en flux et WebSocket passent sans copie, et la réponse revient intacte (texte de statut compris).

Une route portée renvoie la requête au TS dès qu'elle rencontre un cas qu'elle ne reproduit pas exactement. Pour la connexion, le corps est conservé par `Request.clone()` avant lecture, et la bascule n'est possible qu'avant les écritures.

- **`POST /api/user/token-auth/`** est portée : vérification PBKDF2 (format Supertask en hex, et le vérificateur « Django » SHA-1 avec ses particularités), `is_active`, fournisseur « password » désactivé, `last_login`, journal d'audit, jetons HS256 `access`, `refresh` et `user_session` aux mêmes claims, durées et ordre de clés. Les jetons Rust sont acceptés par le TS, et inversement. Vont au TS : compte avec 2FA active, corps que le TS transformerait en 500 (JSON invalide, identifiants non textuels), hachages hors des cas reproduits, erreur de stockage avant les écritures.
- **`GET /api/database/rows/table/:id/`** est portée : JWT, jeton de base de données (`Token` ou `Bearer`), accès anonyme aux modèles, rôles entreprise (équipes, affectations, repli « lecture seule » par descendant), `page`, `size`, `order_by`, `user_field_names`, `search`, et tous les types de champs sauf les formules évaluées (lien, compte, rollup, lookup, fichier, sélection, etc.). Vont au TS : `filter__*`, `include=row_metadata`, tables à formule (jusqu'à l'arrivée de `st-formula`), identifiants atypiques, erreurs de stockage.
- **`POST /api/database/rows/table/:id/`** n'est pas portée : la création de ligne déclenche historique, webhooks, automatisations, diffusion temps réel, data sync et mises à jour IA. Elle est transmise au TS, et le banc compare la forme des réponses.

L'égalité à l'octet près tient à trois détails : un écrivain JSON qui suit `JSON.stringify` (clés numériques en tête, nombres au format JS, entiers au-delà de 2^53 arrondis), les conversions JS (`Number()`, `parseInt`, `trim`, vérité) dans un module à part, et les mêmes requêtes SQL que le TS.

## Tests différentiels

`crates/st-difftest` envoie chaque requête aux deux Workers et compare statut, en-têtes utiles (`content-type`, CORS, `set-cookie`…) et corps. Les lectures doivent être identiques à l'octet près. Les connexions comparent les jetons par leurs claims décodés : mêmes claims, mêmes durées, `token_hash` égal au SHA-256 du jeton de rafraîchissement. Les écritures comparent la forme, identifiants et horodatages masqués.

Résultat, quatre passages de suite : 179 cas identiques sur 179, dont 116 servis par Rust et 63 transmis au TS. Ils couvrent la connexion des cinq utilisateurs de test et neuf cas d'erreur, les jetons croisés, les huit tables avec seize variantes de pagination, de tri et de recherche, deux jetons de base de données, des routes transmises, deux créations de ligne et les WebSocket.

## Mesures

- **Taille du WASM** : 626 Ko (234 Ko compressé) en production, 818 Ko (291 Ko) avec les spikes. La limite des Workers est de 3 Mo compressés en offre gratuite, 10 Mo en offre payante.
- **Latence locale**, moyenne de dix requêtes :

| Requête | Worker TS | Worker Rust |
| --- | ---: | ---: |
| Connexion | 69 ms | 174 ms |
| Lignes de la table 1 (liens, rollup), `size=100` | 56 ms | 57 ms |
| Lignes de la table 4, `size=100` | 48 ms | 47 ms |
| `GET /api/workspaces/`, transmise au TS | 109 ms | 117 ms |

La connexion coûte environ 100 ms de CPU de plus en Rust : les 100 000 tours de PBKDF2 tournent en Rust pur dans le WASM, là où le TS appelle WebCrypto. Appeler `crypto.subtle.deriveBits` depuis Rust ramènerait le coût à celui du TS. Le passage par le Worker Rust ajoute environ 8 ms à une route transmise.

## Problèmes rencontrés

- **Deux `wrangler dev` sur le même `--persist-to`.** Les deux processus workerd écrivent le même fichier SQLite de D1. Une écriture juste après celle de l'autre processus échoue en `SQLITE_BUSY` (miniflare loge D1 dans un Durable Object qui garde sa transaction ouverte un instant). Une lecture peut échouer de la même façon. Le banc attend 400 ms après chaque écriture, et le Worker Rust renvoie au TS toute lecture dont le stockage échoue. Parade proposée, pas encore essayée (la session TS est gérée par systemd) : une seule session pour les deux Workers (`wrangler dev -c crates/st-worker/wrangler.toml -c wrangler.toml`), donc un seul objet D1.
- **`serde_json::Value` vers JS.** serde-wasm-bindgen convertit les objets JSON en `Map` JS. Workers AI les refuse et le consommateur TS de la file ne les lirait pas. Il faut des structs, ou `Serializer::serialize_maps_as_objects(true)`.
- **Build et CI.** worker-build lance `cargo build` depuis le vrai chemin du crate : un manifeste invalide n'importe où dans le workspace bloque le build du Worker. Le CI doit vérifier tout le workspace avant de construire le Worker.
- **Écart toléré sur les JWT.** jose accepte un en-tête `crit: ["b64"]` ; le Rust le refuse. Seul un détenteur de la clé pourrait fabriquer un tel jeton.

## Lancer en local

Le Worker TS doit tourner (`supertask-dev-api.service`, port 8811). Depuis `crates/st-worker` :

```sh
wrangler dev --ip 127.0.0.1 --port 8812 --inspector-port 9352 \
  --persist-to /home/mabza/.t3/projects/supertask/.wrangler/state
```

Il faut `~/.cargo/bin` dans le `PATH` (worker-build, cargo) et, pour Workers AI et Browser Rendering, le jeton de `~/.config/supertask/cloudflare.env`. Le binding `LEGACY` trouve le Worker TS par le registre de wrangler dev (`[connected]` au démarrage). Les réponses produites par Rust portent `X-Supertask-Backend: rust` (variable `ST_BACKEND_HEADER`, locale seulement).

Tests : `cargo nextest run -p st-worker` (unitaires, natifs), puis `cargo run -p st-difftest` avec les deux Workers lancés.
