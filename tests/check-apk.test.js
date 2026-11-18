'use strict';
// scripts/check-apk.sh avec de faux apksigner/aapt et un faux APK : contrôle d'empreinte, version, et blocage des releases sans empreinte.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const haveTools = ['python3', 'unzip', 'bash'].every(c => spawnSync('sh', ['-c', 'command -v ' + c]).status === 0);
const skip = haveTools ? false : 'python3, unzip ou bash absent';
const CERT = '43fd2a5c5d71cf5bcea64d52c5ccbf672a464799c441e5e4beb7031bfc7f1ce8';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-apk-')), tools = path.join(dir, 'bt'); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'apksigner'), '#!/bin/bash\necho "Verified using v2 scheme (APK Signature Scheme v2): true"\necho "Number of signers: 1"\necho "Signer #1 certificate SHA-256 digest: $FAKE_CERT"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'aapt'), "#!/bin/bash\necho \"package: name='app.grimoire.notes' versionCode='$FAKE_CODE' versionName='$FAKE_NAME'\"\n", { mode: 0o755 });
  const apk = path.join(dir, 'app.apk');
  execFileSync('python3', ['-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('lib/arm64-v8a/libgrimoire_lib.so', 'x' * 100)
z.writestr('classes.dex', ' '.join(['MainActivity$Bridge', 'secretGet', 'secretSet', 'secretDelete', 'hasFileAccess', 'requestFileAccess', 'shareText', 'takeSharedText']))
z.writestr('AndroidManifest.xml', 'm')
z.close()`, apk]);
  return { dir, tools, apk };
}
function run(env) {
  const f = setup();
  const r = spawnSync('bash', [path.join(root, 'scripts', 'check-apk.sh'), f.apk], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, BUILD_TOOLS: f.tools, EXPECTED_VERSION: '1.4.2', MIN_VERSION_CODE: '1004002', FAKE_CERT: CERT, FAKE_CODE: '1004002', FAKE_NAME: '1.4.2', ...env }
  });
  fs.rmSync(f.dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('empreinte conforme (format avec deux-points et majuscules accepté) : le contrôle passe', { skip }, () => {
  const r = run({ EXPECTED_SHA256: CERT.toUpperCase().replace(/(..)(?!$)/g, '$1:') });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Empreinte conforme à ANDROID_CERT_SHA256/);
});
test('empreinte différente : échec', { skip }, () => {
  const r = run({ EXPECTED_SHA256: 'ba240087aeeb8b32877296467522aa69b5bfdc2d74af2faa0e6dc98d05527c0e' });
  assert.notEqual(r.code, 0); assert.match(r.out, /empreinte différente/);
});
test('variable absente hors release : avertissement seulement', { skip }, () => {
  const r = run({ EXPECTED_SHA256: '' });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /warning::Variable ANDROID_CERT_SHA256 absente/);
});
test('variable absente avec REQUIRE_FINGERPRINT=1 (release) : échec', { skip }, () => {
  const r = run({ EXPECTED_SHA256: '', REQUIRE_FINGERPRINT: '1' });
  assert.notEqual(r.code, 0); assert.match(r.out, /empreinte est obligatoire/);
});
test('REQUIRE_FINGERPRINT=1 avec la bonne empreinte : la release passe', { skip }, () => {
  const r = run({ EXPECTED_SHA256: CERT, REQUIRE_FINGERPRINT: '1' });
  assert.equal(r.code, 0, r.out);
});
test('versionName inattendu ou versionCode sous le plancher : échec', { skip }, () => {
  assert.match(run({ EXPECTED_SHA256: CERT, FAKE_NAME: '1.4.1' }).out, /versionName « 1\.4\.1 » au lieu de « 1\.4\.2 »/);
  const low = run({ EXPECTED_SHA256: CERT, FAKE_CODE: '1004001' });
  assert.notEqual(low.code, 0); assert.match(low.out, /versionCode « 1004001 » inférieur/);
});
test('le workflow exige l\'empreinte seulement sur les tags v*', () => {
  const y = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(y, /REQUIRE_FINGERPRINT: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) && '1' \|\| '' \}\}/);
  assert.match(y, /EXPECTED_SHA256: \$\{\{ vars\.ANDROID_CERT_SHA256 \}\}/);
});
