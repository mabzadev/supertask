# Prototype st-richtext : éditeur egui + yrs

Phase 0 du plan de réécriture (`docs/plan-reecriture-rust.md`), risque « Éditeur de texte riche collaboratif ». Question posée : un widget egui écrit maison sur yrs peut-il ouvrir et modifier un document Supertask existant sans casser la compatibilité avec TipTap/y-prosemirror ?

**Recommandation : GO**, avec un calendrier à revoir (voir l'estimation). La compatibilité des données dans les deux sens est prouvée avec les vraies bibliothèques du frontend, et l'édition de base tient dans un code simple. Le reste à faire est surtout de l'interface, en quantité, sans nouveau verrou technique.

## Où vit l'état Yjs d'un document

- Le fragment est `XmlFragment("default")`, la valeur de `Collaboration.configure({ field: 'default' })` dans `frontend/modules/documents/pages/page.vue`. Le schéma est celui de TipTap, décrit par y-prosemirror : un `XmlElement` par nœud, avec ses attributs non nuls, et un `XmlText` par suite de textes, où chaque mark devient un attribut de formatage (`bold: {}`, `link: {href, target, rel, class}`).
- Une map `supertask` porte `materialized`, une copie JSON de la page (titre, contenu ProseMirror, icône, couverture). Le client la réécrit à chaque frappe. À chaque enregistrement, le Durable Object `ContentRoomDO` la recopie dans D1 (`supertask_document_page.content`). L'état Yjs complet est stocké dans le DO sous la clé `ydoc`. Les versions enregistrées dans R2 et D1 sont du JSON matérialisé, pas du Yjs.
- **Aucun état Yjs n'existe en local.** Les fichiers SQLite des DO `document-page:*` ne contiennent pas de table `_cf_KV`. La cause : `ContentRoomDO.fetch` passe le WebSocket à Hocuspocus 4.4 avec `handleConnection()`, mais ne relaie jamais les messages (`clientConnection.handleMessage()`, `handleClose()`), et la v4 exige ce relais de l'intégration. Le serveur ne répond donc à aucune synchronisation. Je l'ai constaté avec un client Hocuspocus Node : la connexion passe en 101, puis aucun message n'arrive en 6 s.
- Fixture : `tools/capture-fixture.cjs` reconstitue la salle en mémoire avec les mêmes bibliothèques que le front et le serveur. Il part de la page 5 « Spéc : export PDF » (application Spécifications), lue par l'API locale (`GET /api/document/pages/5/` et `.../materialized/`). La salle est initialisée comme `onLoadDocument`. Alice amorce le fragment comme `page.vue` (`updateYFragment` à partir du contenu D1). Bruno, dans une seconde session, ajoute du formatage et des blocs comme la barre d'outils TipTap : gras, italique, lien, barré, souligné, liste numérotée imbriquée, citation, code, séparateur, saut de ligne, tableau, encadré, image. Le résultat `Y.encodeStateAsUpdate(room)` correspond aux octets que `onStoreDocument` écrirait. Il est enregistré dans `tests/fixtures/spec-export-pdf.yjs` (5,9 Ko, 3 clients), avec à côté le JSON produit par y-prosemirror.

## Ce qui marche

- **Lecture** de tout le document, y compris les nœuds inconnus. On obtient le même JSON ProseMirror que `yXmlFragmentToProseMirrorRootNode`, à la normalisation près : attributs nuls absents, ordre des marks.
- **Rendu egui** : paragraphes, titres 1 à 3, listes à puces, numérotées et de tâches (cases cliquables), listes imbriquées, citations, blocs de code, séparateurs, sauts de ligne. Marks gras, italique, souligné, barré, lien, indice et exposant. Les nœuds inconnus (tableau, encadré, image, YouTube…) restent **intacts** dans Yjs et s'affichent comme un cadre avec leur type et le début de leur texte.
- **Édition**, une transaction yrs par commande, donc une mise à jour Yjs par commande (`take_local_updates()`) :
  - saisie avec les marks héritées comme dans ProseMirror : un lien ne s'étend pas en tapant à sa suite ;
  - Retour arrière et Suppr, y compris la fusion de blocs, la jonction d'éléments de liste et la sortie d'une liste ou d'une citation ;
  - Entrée : coupe du bloc, fin de titre suivie d'un paragraphe, nouvel élément de liste, sortie de liste depuis un élément vide, désindentation dans une liste imbriquée, saut de ligne dans un bloc de code ; Maj+Entrée insère un saut de ligne ;
  - Ctrl+B, I et U sur une sélection, ou en marks mémorisées sans sélection ;
  - sélection et suppression sur plusieurs blocs, Ctrl+A, copier, couper, coller (les sauts de ligne deviennent des paragraphes) ;
  - Ctrl+Z, Ctrl+Maj+Z et Ctrl+Y avec l'`UndoManager` de yrs, comme y-prosemirror qui remplace l'historique par `Y.UndoManager` ;
  - flèches avec conservation de la colonne, Début et Fin, clic et glisser ;
  - IME : validation et `DeleteSurrounding` (claviers mobiles), position du curseur transmise à la plateforme.
- **Invariants y-prosemirror** respectés : jamais deux `XmlText` voisins, élément de liste commençant toujours par un paragraphe, conteneurs vides supprimés. Sans eux, y-prosemirror supprimerait des nœuds en relisant le document.
- **Miroir `materialized`** tenu à jour à chaque modification, sans toucher au titre ni à l'icône. Sans ce miroir, D1 ne verrait jamais les modifications faites en Rust.
- **Curseur stable** face aux modifications distantes : il est indexé par l'identifiant Yjs du bloc, pas par sa position.
- Amorçage d'une page sans état Yjs à partir du JSON D1 (`load_prosemirror_json`), comme le fait `page.vue`.
- Compile pour `wasm32-unknown-unknown`. Clippy passe avec `-D warnings` et le code est formaté par rustfmt.

À corriger en passant : sur le web, `fastrand` (utilisé par yrs pour tirer l'identifiant client) part d'une graine constante si sa fonction `js` n'est pas activée. Tous les onglets auraient eu le même identifiant client, et les documents partagés auraient été corrompus. Le crate active `fastrand/js` pour wasm.

## Vérification

```sh
. ~/.cargo/env && export CARGO_TARGET_DIR=$PWD/target/richtext
cargo test -p st-richtext                         # 3 unitaires + 36 d'intégration
cargo clippy -p st-richtext --all-targets -- -D warnings
cargo build -p st-richtext --target wasm32-unknown-unknown
node crates/st-richtext/tools/verify.cjs          # 10 vérifications, yjs 13.6 + y-prosemirror 1.3 + schéma TipTap 3 du front
cargo test --release -p st-richtext --test perf -- --ignored --nocapture
```

`verify.cjs` réalise trois contrôles :

- **(a)** le modèle Rust lit la fixture exactement comme y-prosemirror ;
- **(b)** l'exemple `edit` pilote le widget sans fenêtre, par de vrais événements clavier : saisie, Maj+flèches, Ctrl+B, Entrée, Ctrl+I, Entrée dans une liste, Retour arrière après un saut de ligne. Node applique ensuite les 16 mises à jour Rust, une par une puis en une seule différence. Le document obtenu n'exige aucune réparation de y-prosemirror, le vecteur d'état est inchangé après conversion, et `node.check()` passe. Il est égal à l'original augmenté des seules modifications attendues, et `materialized.content` le suit ;
- **(c)** une modification TipTap concurrente et les mises à jour Rust convergent quel que soit l'ordre d'application, et Rust relit l'état fusionné comme y-prosemirror.

Tests du widget sans fenêtre (`tests/widget.rs`, via `st_richtext::headless::Harness`, un `egui::Context` alimenté en `RawInput`) : saisie, Entrée, gras, Retour arrière et Suppr, listes, flèches, Ctrl+A, collage, annuler et rétablir, clic et case à cocher, IME, curseur conservé après une insertion distante, page réelle.

Mesures en build release sur un i9-9900, sans virtualisation :

| Taille de la page | Chargement | Frappe | Frappe sans miroir JSON | 1ʳᵉ image | Images suivantes |
| --- | --- | --- | --- | --- | --- |
| 200 blocs | 1 ms | 1,7 ms | 0,3 ms | 8 ms | 0,1 ms |
| 2 000 blocs | 9 ms | 22 ms | 3,6 ms | 70 ms | 1,1 ms |

Le miroir JSON réécrit à chaque frappe domine le coût. Il faudra le différer, comme le `queueSave` de 450 ms du front.

## Extensions TipTap de Supertask et état dans le prototype

Les extensions viennent de `RichTextEditor.vue` (mise en forme riche) et de `page.vue` (documents). Légende : ✅ fait, 🟡 partiel, ❌ absent ; les nœuds ❌ sont tous conservés intacts.

| Extension | État | Reste à faire |
| --- | --- | --- |
| Document, Paragraph, Text | ✅ | — |
| HardBreak | ✅ | `keepMarks` |
| Heading (1 à 3) | 🟡 | rendu et texte faits ; manquent le changement de niveau (Ctrl+Alt+1-3, barre d'outils) et les règles de saisie `#` |
| BulletList, OrderedList, ListItem | 🟡 | Entrée et Retour arrière faits ; manquent Tab et Maj+Tab (indenter, désindenter), les règles de saisie `- ` et `1. `, et le basculement d'un bloc en liste |
| TaskList, TaskItem | 🟡 | rendu et case cliquable ; mêmes manques que pour les listes |
| Blockquote | 🟡 | rendu et édition ; manque la commande de basculement |
| CodeBlock | 🟡 | texte monospace, Entrée insère un saut de ligne ; manquent la coloration et la sortie par triple Entrée |
| HorizontalRule | 🟡 | rendu ; manque l'insertion |
| Bold, Italic, Underline | ✅ | gras visuel par couleur : il faut embarquer une police grasse ou variable (`bold_family`, axe `wght` d'epaint) |
| Strike, Subscript, Superscript | 🟡 | rendu et API ; manquent les raccourcis |
| Link | 🟡 | lu, rendu, non inclusif ; manquent la création, l'édition et l'ouverture au clic |
| History | ✅ | remplacé par l'`UndoManager` de yrs |
| Collaboration (fragment `default`) | ✅ | — |
| CollaborationCaret (awareness) | ❌ | curseurs et noms des autres membres |
| Markdown (tiptap-markdown) | ❌ | import et export, collage Markdown |
| Placeholder | ❌ | texte d'invite d'une page vide (simple) |
| CharacterCount | ❌ | compteur de mots (simple, à partir de `Document::plain_text`) |
| SlashCommand | ❌ | menu « / » |
| Table, TableRow, TableHeader, TableCell | ❌ | affiché en cadre ; l'édition de tableaux est le plus gros morceau |
| Image, FileHandler, ScalableImage, Dropcursor, Gapcursor | ❌ | affichage, téléversement, glisser-déposer, curseur entre blocs |
| Youtube, Callout | ❌ | affichés en cadre |
| GlobalDragHandle | ❌ | déplacement de blocs à la souris |
| Mention (champs texte riche, commentaires) | ❌ | caractère objet en ligne ; manquent l'affichage `@nom`, l'autocomplétion et la correspondance des positions |
| EnterStopEditExtension (cellules de grille) | ❌ | option du widget |

Les extensions `audio`, `toc`, `embeddedView`, `dynamicLookup`, `pageMention` et `rowMention` de `frontend/modules/documents/editor` ne sont enregistrées nulle part. Leurs entrées du menu « / » appellent donc des commandes absentes dans l'éditeur Vue actuel.

Il manque aussi, hors extensions :

- le transport : protocole Hocuspocus en Rust (authentification, sync 1 et 2, awareness, sur ewebsock) ;
- la persistance locale, équivalent de y-indexeddb ;
- des `StickyIndex` pour les décalages à l'intérieur d'un bloc lors de saisies distantes simultanées ;
- la virtualisation et un cache de mise en page pour les longues pages ;
- le presse-papiers riche (HTML et Markdown) ;
- l'affichage de la composition IME (preedit), l'accessibilité AccessKit et la recherche Ctrl+F (risque « web en canvas » du plan) ;
- les déplacements mot par mot ;
- un curseur après un tableau final (gapcursor).

## Estimation du reste, pour une personne

| Lot | Semaines |
| --- | --- |
| Version minimale de production : sync Hocuspocus et awareness (2), StickyIndex et curseurs distants (1), liens et mentions (2), menu « / » et changements de type de bloc (1), Tab et règles de saisie (0,5), presse-papiers HTML et Markdown (1,5), polices (0,5), virtualisation, cache et miroir différé (1), IME, mobile et accessibilité de base (1,5), images (1), tests de convergence aléatoires contre y-prosemirror (1) | 12 à 13 |
| Parité complète : tableaux éditables (3), encadrés, YouTube et intégrations (1), poignée de déplacement (1), coloration du code (0,5), import et export Markdown (1), ancres de commentaires et versions (1) | 7 à 8 |

Total : environ 20 semaines-personne. La phase 5 du plan prévoit les semaines 11 à 14 : c'est assez pour la version minimale seulement si le travail commence plus tôt ou se fait à deux. Il faut garder l'éditeur Nuxt/TipTap en repli pour les Documents jusqu'à la parité, et livrer les tableaux après, comme le prévoit déjà le plan.

## À traiter côté TypeScript, indépendamment de Rust

1. `ContentRoomDO` ne relaie pas les messages WebSocket à Hocuspocus 4 : il faut ajouter `addEventListener('message' / 'close')`, qui appellent `handleMessage` et `handleClose` sur la connexion retournée. Le temps réel des Documents et des Whiteboards est donc probablement inopérant.
2. En local, les pages 1, 2 et 4, que `npm run dev:reset-local` avait amorcées avec un titre, un paragraphe et des listes, ont perdu ce contenu : après une ouverture dans le navigateur, `content` vaut un paragraphe vide, avec `collaboration_initialized=1`. Cause probable : l'éditeur collaboratif démarre sur un fragment vide et renvoie ce document vide par `v-model`, et `queueSave` l'enregistre avant l'amorçage. À vérifier en production.
