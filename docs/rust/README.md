# Supertask en Rust

La réécriture suit [le plan](../plan-reecriture-rust.md). Où en est la phase 0 : [bilan](phase0-bilan.md).

## Les crates

| Crate | Rôle |
| --- | --- |
| `st-core` | Types de domaine : champs, vues, applications, formatage des cellules |
| `st-api` | Requêtes et réponses de l'API HTTP, sans bibliothèque HTTP |
| `st-formula` | Moteur de formules : analyse, types, évaluation |
| `st-richtext` | Éditeur de texte riche egui sur yrs, compatible avec les documents Yjs |
| `st-app` | App eframe/egui, web (WASM) et bureau |
| `st-worker` | Worker Rust (workers-rs) devant le Worker TS |
| `st-difftest` | Banc qui compare les réponses du Worker Rust et du Worker TS |
| `st-public`, `st-import` | Pages publiques en HTML et imports : vides pour l'instant |

## Prérequis

Rust est épinglé par `rust-toolchain.toml` (1.99.1, cible `wasm32-unknown-unknown`). Outils : `cargo install trunk wasm-bindgen-cli cargo-nextest worker-build`. Sans `pkg-config` ni `libssl-dev` sur la machine, `worker-build` compile avec les en-têtes extraits du paquet `libssl-dev` dans `~/.local/opt/openssl-dev` (`OPENSSL_INCLUDE_DIR`, `OPENSSL_LIB_DIR`, `OPENSSL_STATIC=1`).

## Lancer en local

Le Worker TS doit tourner (`supertask-dev-api`, port 8811).

- **App web egui**, sur `http://127.0.0.1:3120/`, `/api` relayé vers le port 8811 :
  `cd crates/st-app && trunk serve --release --address 127.0.0.1 --port 3120`
- **App de bureau** : `cargo run -p st-app --release` (adresse de l'API à saisir sur l'écran de connexion).
- **Worker Rust**, sur `http://127.0.0.1:8812/`, devant le Worker TS et sur le même état local :
  `cd crates/st-worker && npx wrangler dev --ip 127.0.0.1 --port 8812 --inspector-port 9352 --persist-to ../../.wrangler/state`
  Il faut `crates/st-worker/.dev.vars`, un lien vers `../../.dev.vars`. Les réponses produites par Rust portent `X-Supertask-Backend: rust`.
- **Banc différentiel**, les deux Workers lancés : `cargo run -p st-difftest`

## Vérifier comme la CI

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy --target wasm32-unknown-unknown -p st-core -p st-api -p st-formula -p st-richtext -p st-app -p st-worker -- -D warnings
cargo nextest run --workspace
(cd crates/st-app && trunk build --release)
(cd crates/st-worker && worker-build --release)
```

La compatibilité de l'éditeur avec TipTap se vérifie avec `node crates/st-richtext/tools/verify.cjs` (dépendances du frontend installées).
