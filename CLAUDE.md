# Grimoire

Appli de notes liées (`[[ ]]`), graphe interactif, synchronisation PC ↔ téléphone. Tauri 2 : Android (APK) et Windows à partir du même code.

## Structure
- `src/` : interface en HTML, CSS, JS purs, sans étape de build. `app.js` contient tout (état, rendu, graphe canvas, synchro GitHub, coffre disque).
- `src/vendor/`, `src/fonts/` : librairies et polices embarquées. L'appli doit marcher hors ligne : aucun CDN.
- `src-tauri/src/vault.rs` : coffre sur disque, un fichier `.md` par note dans le dossier `Grimoire` (en-tête `---` avec id, title, pinned, created, updated). Testé par `cargo test`.
- `src-tauri/src/lib.rs` : commandes Tauri (`vault_path`, `vault_list`, `vault_write`, `vault_delete`, `export_file`).
- `android/MainActivity.kt` + `scripts/android-patch.js` : le dossier `src-tauri/gen/` n'est pas versionné ; le workflow le complète après `tauri android init` (permission « accès à tous les fichiers », réception de texte partagé, pont JS `GrimoireAndroid` pour partager une note et lire le texte reçu).
- `mcp/` : serveur MCP Node (lit et écrit `grimoire-notes.json` du dépôt de notes).
- `.github/workflows/build.yml` : construit l'APK (debug, installable directement) et l'installeur Windows. Un tag `v*` publie dans Releases.

## Commandes
- Lancer sur PC : `npm install && npx tauri icon app-icon.png && npx tauri dev`
- Tester le coffre : `cd src-tauri && cargo test`
- Vérifier le JS : `node --check src/app.js`
- Publier une version : `git tag vX.Y.Z && git push origin vX.Y.Z`, puis suivre l'onglet Actions.

## Règles
- Langue de l'interface : français, tutoiement.
- Design : noir, os, rouge sang ; gothique. Jetons de couleur et de police dans `:root` de `app.css`. Mode sombre uniquement.
- Ne jamais perdre de notes : toute migration de stockage reprend les données existantes et se teste avant de supprimer l'ancien format.
- Format des données partagé par l'appli, la synchro et le MCP : `{ id, title, body, pinned, created, updated }`, plus `deleted: { id: horodatage }` côté synchro. Toute évolution doit rester lisible par les trois.
- Le jeton GitHub ne doit jamais être commité ni écrit dans les journaux.
- Commits : messages courts en français, sans ligne `Co-Authored-By` ni `Claude-Session`.
- Après un changement natif (Rust, plugins, config Tauri), il faut un nouveau build ; un changement dans `src/` aussi, l'appli n'a pas de mise à jour à distance.

## Android
Les notes vont dans `Documents/Grimoire` si l'utilisateur accorde « Accès à tous les fichiers » (invite au premier lancement). Sinon elles restent dans le stockage privé et `vault::migrate` les reprend dans Documents dès que l'accès est accordé (copie, vérification, puis suppression de l'ancien).

## Suite prévue
1. Jeton GitHub dans le coffre sécurisé du système.
2. Synchro note par note avec copie en cas de conflit.
3. Images et pièces jointes, corbeille, historique.
