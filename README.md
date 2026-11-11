# Grimoire

Notes liées `[[ ]]`, graphe interactif, synchronisation PC ↔ téléphone. Tauri 2.

## Obtenir l'APK et l'appli PC (sans rien installer)
1. Crée un dépôt GitHub (peut être public ou privé) et envoie-y tout ce dossier.
2. Onglet **Actions** du dépôt : le workflow « Build Grimoire » se lance seul.
3. Quand il est vert (15 à 25 min la première fois), ouvre l'exécution et télécharge :
   - **Grimoire-android** : `Grimoire.apk`, à installer sur le téléphone.
   - **Grimoire-windows** : l'installeur `.exe` ou `.msi`.
4. Pour un lien de téléchargement permanent comme celui de ton frère : `git tag v1.0.0 && git push --tags`. L'APK apparaît dans **Releases**.

## Synchroniser PC et téléphone
1. Crée un dépôt GitHub **privé** vide, par exemple `grimoire-notes`.
2. GitHub → Settings → Developer settings → Fine-grained tokens : jeton limité à ce seul dépôt, droit **Contents : Read and write**.
3. Dans Grimoire : menu ⋯ en bas de l'index → « Synchroniser via GitHub ». Colle `proprietaire/grimoire-notes` et le jeton.
4. Même chose sur l'autre appareil. Les notes passent par le fichier `grimoire-notes.json` du dépôt, en moins d'une minute.

## Développer
Prérequis : Node 20, Rust, et les prérequis Tauri 2 de ton système.
```
npm install
npx tauri icon app-icon.png
npx tauri dev
```
Le code de l'interface est dans `src/` (HTML, CSS, JS, sans étape de build).
