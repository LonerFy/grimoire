'use strict';
// Les trois fichiers de version et le plancher de versionCode de check-apk.sh doivent rester d'accord (formule de Tauri : major*1000000 + minor*1000 + patch).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('même version dans package.json, Cargo.toml et tauri.conf.json', () => {
  const a = JSON.parse(read('package.json')).version, b = read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)[1], c = JSON.parse(read('src-tauri/tauri.conf.json')).version;
  assert.equal(b, a); assert.equal(c, a);
});
test('check-apk.sh exige exactement le versionCode de la version courante, au moins', () => {
  const [maj, min, pat] = JSON.parse(read('package.json')).version.split('.').map(Number);
  const m = read('scripts/check-apk.sh').match(/min_code="\$\{MIN_VERSION_CODE:-(\d+)\}"/);
  assert.ok(m, 'plancher introuvable');
  assert.equal(Number(m[1]), maj * 1000000 + min * 1000 + pat);
});
test('la CI contrôle la version de package.json (pas de version codée en dur)', () => {
  const y = read('.github/workflows/build.yml');
  assert.match(y, /EXPECTED_VERSION="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
  assert.doesNotMatch(y, /EXPECTED_VERSION="?\d/);
});
