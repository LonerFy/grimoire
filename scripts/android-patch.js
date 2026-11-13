// Adapte le projet Android généré par `tauri android init` (le dossier gen/ n'est pas versionné).
// Usage : node scripts/android-patch.js   (depuis la racine, après `tauri android init`)
const fs = require('fs'), path = require('path');
const gen = 'src-tauri/gen/android/app/src/main';
const manifestPath = path.join(gen, 'AndroidManifest.xml');
let m = fs.readFileSync(manifestPath, 'utf8');

const perms = [
  '<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />'
];
for (const p of perms) {
  const name = p.match(/android:name="([^"]+)"/)[1];
  if (!m.includes(name)) m = m.replace(/<application/, p + '\n    <application');
}

// Réception d'un texte partagé depuis une autre appli.
if (!m.includes('android.intent.action.SEND')) {
  const filter = '<intent-filter>\n                <action android:name="android.intent.action.SEND" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <data android:mimeType="text/plain" />\n            </intent-filter>\n        ';
  if (!/<\/activity>/.test(m)) throw new Error('AndroidManifest : balise </activity> introuvable');
  m = m.replace(/<\/activity>/, '    ' + filter + '</activity>');
}
// Une seule instance : un partage reçu pendant que l'appli tourne arrive dans onNewIntent.
if (!/android:launchMode=/.test(m)) m = m.replace(/<activity\b/, '<activity android:launchMode="singleTask"');
fs.writeFileSync(manifestPath, m);

const java = path.join(gen, 'java/app/grimoire/notes');
if (!fs.existsSync(java)) throw new Error('Dossier Kotlin introuvable : ' + java);
fs.copyFileSync('android/MainActivity.kt', path.join(java, 'MainActivity.kt'));
console.log('Projet Android adapté.\n' + m);
