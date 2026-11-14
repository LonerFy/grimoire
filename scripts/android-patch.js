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

// Build release : signature avec la clé stable (lue dans l'environnement, jamais écrite sur disque)
// et règles R8 qui gardent le pont JS GrimoireAndroid (sinon R8 renomme ou retire ses méthodes).
const appDir = 'src-tauri/gen/android/app';
const gradlePath = path.join(appDir, 'build.gradle.kts');
if (!fs.existsSync(gradlePath)) throw new Error('build.gradle.kts introuvable : ' + gradlePath);
let g = fs.readFileSync(gradlePath, 'utf8');
if (!g.includes('GRIMOIRE-SIGNING')) {
  const releaseRe = /getByName\("release"\)\s*\{|^[ \t]*release\s*\{/m;
  const typesRe = /^[ \t]*buildTypes\s*\{/m;
  if (!releaseRe.test(g)) throw new Error('build.gradle.kts : bloc "release" introuvable, le modèle Tauri a changé');
  if (!typesRe.test(g)) throw new Error('build.gradle.kts : bloc buildTypes introuvable, le modèle Tauri a changé');
  g = g.replace(releaseRe, all => all + '\n            signingConfig = signingConfigs.getByName("release")\n            proguardFile("proguard-grimoire.pro")');
  const signing = [
    '    // GRIMOIRE-SIGNING : clé stable lue dans l\'environnement (CI)',
    '    signingConfigs {',
    '        create("release") {',
    '            val ksPath = System.getenv("ANDROID_KEYSTORE_PATH")',
    '            if (ksPath != null) {',
    '                storeFile = file(ksPath)',
    '                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")',
    '                keyAlias = System.getenv("ANDROID_KEY_ALIAS")',
    '                keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")',
    '            }',
    '        }',
    '    }',
    ''
  ].join('\n');
  g = g.replace(typesRe, all => signing + all);
  if (!g.includes('signingConfig = signingConfigs.getByName("release")')) throw new Error('build.gradle.kts : signature non injectée');
  fs.writeFileSync(gradlePath, g);
}
fs.writeFileSync(path.join(appDir, 'proguard-grimoire.pro'), [
  '# Le pont JS (window.GrimoireAndroid) est appelé par nom depuis la page : R8 ne doit ni le renommer ni le retirer.',
  '-keepattributes *Annotation*',
  '-keep class app.grimoire.notes.MainActivity { *; }',
  '-keep class app.grimoire.notes.MainActivity$Bridge { *; }',
  '-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }',
  ''
].join('\n'));

console.log('Projet Android adapté.\n' + m + '\n--- build.gradle.kts (sans secret : tout vient de l\'environnement) ---\n' + g);
