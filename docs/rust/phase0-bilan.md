# Phase 0 : bilan et go/no-go

7 novembre 2026

**Go.** Toutes les briques à risque de la phase 0 marchent en Rust : le Worker Rust sert déjà deux routes à l'identique devant le Worker TS, l'app egui affiche les vraies tables avec tous les types de champs, et l'éditeur de texte riche lit et modifie un document Supertask réel sans rien casser côté TipTap. Deux ajustements de calendrier : le moteur de formules est porté en avance, l'éditeur de texte riche demandera plus de temps que prévu.

## Résultat par tâche

| Tâche de la phase 0 | État | Résultat |
| --- | --- | --- |
| Workspace Cargo et CI | Fait | 9 crates sous `crates/`, CI `.github/workflows/rust.yml` sur les runners auto-hébergés : formatage, clippy natif et WASM, 1 491 tests, builds release, budgets de taille |
| Worker Rust devant le Worker TS | Fait en local | `supertask-rs` sur `127.0.0.1:8812`, tout ce qui n'est pas porté part au TS par service binding, WebSocket compris. Pas encore en production : à faire sur une route de test |
| Briques Cloudflare dans workers-rs | Fait | D1, KV, R2 (multipart compris), Queues, Durable Objects SQLite et WebSocket, Workers AI, Browser Rendering et Images marchent. Vectorize n'est pas testé (pas de simulateur local). Détail : [phase0-spikes.md](phase0-spikes.md) |
| SAML en WASM | Partiel | `samael` ne compile pas en WASM ; `saml-rs` et `xml-sec`, en pur Rust, compilent. Une vraie connexion SSO reste à tester |
| App egui minimale, web et bureau | Fait | Connexion, session persistante, barre latérale, grille virtualisée, tous les types de champs, édition des cellules texte et nombre. Le binaire de bureau compile mais n'a pas été lancé (serveur sans écran) |
| Mesures de l'app | Fait sauf mobile | WASM 3,94 Mo brut, 1,61 Mo gzip, 1,23 Mo brotli ; démarrage 125 ms ; table de 10 000 lignes : 24 à 26 lignes dessinées par image, premières lignes en 153 à 212 ms. Saisie sur mobile non testée |
| Prototype d'éditeur egui + yrs | Fait | Lit un vrai document comme y-prosemirror, ses modifications se relisent dans TipTap sans réparation, fusion concurrente identique dans les deux ordres. Détail : [PROTOTYPE.md](../../crates/st-richtext/PROTOTYPE.md) |
| Banc de tests différentiels | Fait | 179 cas sur 179 identiques : 116 servis par Rust, 63 relayés au TS. Connexion et liste des lignes portées à l'octet près, création de ligne relayée et comparée par forme |
| Go/no-go écrit | Fait | Ce document |

En avance sur la phase 1 : `st-formula` porte tout le moteur de formules. Il passe 100 % des jeux de cas existants (672 + 614 + 13) et 771 064 comparaisons différentielles contre le moteur TS, sans écart hors un cas d'identité d'objet documenté.

## Calendrier recalé

- **Formules** : faites. Avec les premiers types de `st-core` et `st-api`, une bonne partie de la phase 1 est déjà livrée.
- **Texte riche** : le prototype estime 12 à 13 semaines pour une version minimale prête pour la production, et 7 à 8 de plus pour la parité avec TipTap, contre 4 mois prévus en phase 5. La phase 5 passe à environ 5 mois ; l'éditeur Nuxt/TipTap reste le repli pour Documents jusqu'à la parité.
- **Total** : 24 à 26 mois au lieu de 18 à 24, première version egui utilisable toujours visée vers le mois 9.

## Points ouverts

- Mettre le Worker Rust en production sur une route de test, puis devant tout le trafic.
- Faire tourner les deux Workers dans une seule session `wrangler dev` : deux sessions sur le même état local se gênent (`SQLITE_BUSY`), le banc attend 400 ms après chaque écriture.
- Passer à Workers AI et aux Queues des structs, pas des `serde_json::Value` : ces derniers arrivent côté JS en `Map`, que le consommateur TS ne lit pas.
- Brancher `st-formula` dans le Worker (les tables à formule sont encore relayées au TS) et dans l'app. Il pèse 344 Ko gzip avec la base de fuseaux horaires, 269 Ko sans : le Worker l'utilisera sans `tzdb`.
- Tester une vraie connexion SSO avec `saml-rs`, Vectorize sur un index de test, et la saisie sur mobile.

## Bugs trouvés dans l'app TS actuelle

- **La collaboration en temps réel ne synchronise rien.** `ContentRoomDO` (`src/durable-objects/content-room.ts:99`) passe le WebSocket à Hocuspocus 4.4 sans lui transmettre les messages reçus, ce que la version 4 exige. La connexion s'ouvre, puis plus rien : pas de synchronisation, et l'état Yjs n'est jamais enregistré. Touche Documents et Whiteboards.
- **Des pages perdent leur contenu à l'ouverture en local.** Les pages 1, 2 et 4 créées avec du contenu par `dev:reset-local` sont enregistrées vides après ouverture dans le navigateur, probablement parce que l'éditeur démarre sur un document collaboratif vide et sauvegarde cette version.
