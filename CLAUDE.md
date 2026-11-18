# Grimoire

Appli de notes liées (`[[ ]]`), graphe interactif, synchronisation PC ↔ téléphone. Tauri 2 : Android (APK) et Windows à partir du même code.

## Structure
- `src/` : interface en HTML, CSS, JS purs, sans étape de build. `app.js` contient tout (état, rendu, graphe canvas, synchro GitHub, coffre disque).
- `src/vendor/`, `src/fonts/` : librairies et polices embarquées. L'appli doit marcher hors ligne : aucun CDN.
- `src-tauri/src/vault.rs` : coffre sur disque, un fichier `.md` par note dans le dossier `Grimoire` (en-tête `---` avec id, title, pinned, created, updated). Testé par `cargo test`.
- `src-tauri/src/lib.rs` : commandes Tauri (`vault_path`, `vault_list`, `vault_write`, `vault_delete`, `export_file`), plus `secret_get`, `secret_set`, `secret_delete` (jeton GitHub, voir `secret.rs`).
- `src-tauri/src/secret.rs` : jeton GitHub dans le Gestionnaire d'identifiants Windows (crate `keyring` 4.x, feature `v1`, déclarée hors Android uniquement). Sur Android, le jeton est chiffré par une clé AES-GCM de l'Android Keystore (pont `secretGet/secretSet/secretDelete` dans `MainActivity.kt`). `localStorage` ne garde que `{ repo }`. Clé Keystore perdue : l'entrée est effacée, la synchro se met en pause et le jeton est redemandé.
- `android/MainActivity.kt` + `scripts/android-patch.js` : le dossier `src-tauri/gen/` n'est pas versionné ; le workflow le complète après `tauri android init` (permission « accès à tous les fichiers », réception de texte partagé, pont JS `GrimoireAndroid` pour partager une note et lire le texte reçu).
- `src/sync-core.js` : cœur de synchro, sans E/S, testé. Une note = un fichier `notes/<id>.md` dans le dépôt de notes (même format que `vault.rs`). Par note, il retient la dernière version synchronisée (`base`) : seul l'un des deux côtés a changé → il gagne ; les deux → conflit : la version distante garde l'id, la version locale entière devient une copie « (conflit …) », jamais de fusion de lignes ; supprimé d'un côté et modifié de l'autre → la modification gagne. Garde-fou contre les suppressions massives (confirmation). `src/github-store.js` : stockage GitHub par l'API Git Data, un commit atomique par synchro. Interface de stockage (`hash`, `list`, `read`, `commit`) décrite en tête de `sync-core.js` : c'est elle que brancheront les futurs adaptateurs.
- Disposition du dépôt de notes : `notes/<id>.md`, `legacy/` (sauvegarde de l'ancien JSON, créée à la migration) et `grimoire-notes.json` à la racine, **jamais déplacé ni supprimé** : après migration il contient un texte marqueur qui n'est jamais du JSON valide. Pourquoi : la 1.3.2 refuse un fichier illisible sans rien écrire, mais recrée un fichier absent et écrase un `{}` (test `tests/legacy-1.3.2.test.js`, qui rejoue le vrai code du tag `v1.3.2`). Migration : jamais silencieuse (confirmation dans l'appli), un commit atomique, relecture et comparaison note par note.
- `mcp/` : serveur MCP Node, même disposition que l'appli (importe `../src/sync-core.js` : cloner le dépôt entier). `update_note` et `delete_note` exigent `base_version` (champ `version` de `read_note`), `append_to_note` l'accepte en option ; une note modifiée entre-temps est refusée, rien n'est écrasé. Un dépôt encore à l'ancien format reste géré à l'ancienne.
- `tests/` : `npm test` (Node, sans dépendance). `legacy-1.3.2` et `app-glue` extraient et exécutent le vrai code de `git show v1.3.2:src/app.js` et de `src/app.js`. `real-github.test.js` ne tourne que si `GRIMOIRE_TEST_TOKEN` est défini et ne vise que le dépôt jetable `LonerFy/grimoire-notes-test`.
- `.github/workflows/build.yml` : construit l'APK (release signé, arm64 seul) et l'installeur Windows. Un tag `v*` publie dans Releases.
- Signature Android : clé stable hors dépôt (`~/grimoire-release.jks`), fournie à la CI par les secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` (aussi mot de passe de la clé, PKCS12) et `ANDROID_KEY_ALIAS`, et la variable `ANDROID_CERT_SHA256` (empreinte attendue). `scripts/android-patch.js` injecte la signature et les règles R8 (garde du pont `GrimoireAndroid`) dans le projet généré ; `scripts/check-apk.sh` contrôle taille (plafond 40 Mo), architecture, pont, signature, empreinte et version. Perdre la clé ou son mot de passe oblige à désinstaller l'appli pour changer de signature : la sauvegarder.

## Commandes
- Lancer sur PC : `npm install && npx tauri icon app-icon.png && npx tauri dev`
- Tester le coffre : `cd src-tauri && cargo test`
- Vérifier le JS : `node --check src/app.js`
- Tests de synchro : `npm test` (et `cd mcp && npm ci` une fois)
- Publier une version : `git tag vX.Y.Z && git push origin vX.Y.Z`, puis suivre l'onglet Actions.

## Règles
- Langue de l'interface : français, tutoiement.
- Design : noir, os, rouge sang ; gothique. Jetons de couleur et de police dans `:root` de `app.css`. Mode sombre uniquement.
- Ne jamais perdre de notes : toute migration de stockage reprend les données existantes et se teste avant de supprimer l'ancien format.
- Format des données partagé par l'appli, la synchro et le MCP : `{ id, title, body, pinned, created, updated }`, sérialisé en `notes/<id>.md` (une suppression = le fichier disparaît ; plus de `deleted` dans la disposition 2, l'ancien est gardé dans `legacy/`). Toute évolution doit rester lisible par les trois.
- Le jeton GitHub ne doit jamais être commité ni écrit dans les journaux. Les tests réels n'utilisent que `GRIMOIRE_TEST_TOKEN` et le dépôt jetable `LonerFy/grimoire-notes-test` : jamais le vrai dépôt `grimoire-notes`.
- Commits : messages courts en français, sans ligne `Co-Authored-By` ni `Claude-Session`.
- Après un changement natif (Rust, plugins, config Tauri), il faut un nouveau build ; un changement dans `src/` aussi, l'appli n'a pas de mise à jour à distance.

## Android
Les notes vont dans `Documents/Grimoire` si l'utilisateur accorde « Accès à tous les fichiers » (invite au premier lancement). Sinon elles restent dans le stockage privé et `vault::migrate` les reprend dans Documents dès que l'accès est accordé (copie, vérification, puis suppression de l'ancien).

## Suite prévue
1. Images et pièces jointes, corbeille, historique.
