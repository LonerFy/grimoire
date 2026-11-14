#!/usr/bin/env bash
# Contrôles de l'APK release avant publication. Usage : scripts/check-apk.sh chemin/vers/app.apk
# Variables : EXPECTED_VERSION (obligatoire), EXPECTED_SHA256 (facultatif), MAX_MB (défaut 40),
#             BUILD_TOOLS (dossier build-tools du SDK). N'affiche que des informations publiques.
set -euo pipefail

apk="${1:?chemin de l APK manquant}"
max_mb="${MAX_MB:-40}"
tools="${BUILD_TOOLS:?BUILD_TOOLS manquant}"
want_version="${EXPECTED_VERSION:?EXPECTED_VERSION manquant}"
min_code="${MIN_VERSION_CODE:-1003001}"   # 1.3.0 = 1003000 avec la formule de Tauri (major*1000000 + minor*1000 + patch)
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail() { echo "::error::$*"; exit 1; }

# 1. Taille
bytes=$(stat -c %s "$apk")
mb=$(awk -v b="$bytes" 'BEGIN { printf "%.2f", b / 1048576 }')
echo "Taille de l'APK : $bytes octets ($mb Mo), plafond $max_mb Mo"
echo "Les 10 plus gros fichiers (taille compressée) :"
unzip -lv "$apk" | awk '$1 ~ /^[0-9]+$/ && NF >= 8' | sort -k3 -n -r | head -10 | awk '{ printf "  %10d  %s\n", $3, $8 }'
[ "$bytes" -le $((max_mb * 1048576)) ] || fail "APK trop gros : $mb Mo (plafond $max_mb Mo)"

# 2. Une seule architecture : arm64-v8a
abis=$(unzip -Z1 "$apk" | grep '^lib/' | cut -d/ -f2 | sort -u | tr '\n' ' ' || true)
echo "Architectures embarquées : ${abis:-aucune}"
[ "$abis" = "arm64-v8a " ] || fail "architectures inattendues : ${abis:-aucune} (attendu : arm64-v8a seul)"

# 3. Le pont JS a survécu à R8 (noms présents dans le dex)
unzip -p "$apk" 'classes*.dex' > "$tmp/all.dex"
for name in 'MainActivity$Bridge' secretGet secretSet secretDelete hasFileAccess requestFileAccess shareText takeSharedText; do
  grep -aqF -- "$name" "$tmp/all.dex" || fail "R8 a retiré ou renommé « $name » : le pont GrimoireAndroid serait cassé"
done
echo "Pont GrimoireAndroid : 8 noms présents dans le dex"

# 4. Signature et empreinte du certificat
sig=$("$tools/apksigner" verify --verbose --print-certs "$apk") || fail "signature invalide ou absente"
echo "$sig" | grep -E 'Verified using v[0-9]|Number of signers' || true
echo "$sig" | grep -q 'Verified using v2 scheme.*true' || fail "signature v2 absente"
got=$(echo "$sig" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -1 | tr -d ': ' | tr 'A-F' 'a-f')
[ -n "$got" ] || fail "empreinte du certificat introuvable dans la sortie d'apksigner"
echo "Empreinte du certificat (SHA-256) : $got"
want=$(printf '%s' "${EXPECTED_SHA256:-}" | tr -d ': \r\n' | tr 'A-F' 'a-f')
if [ -z "$want" ]; then
  echo "::warning::Variable ANDROID_CERT_SHA256 absente : empreinte affichée mais non vérifiée"
elif [ "$got" != "$want" ]; then
  fail "empreinte différente de celle attendue. Obtenue : $got ; attendue : $want. Mauvaise clé de signature ?"
else
  echo "Empreinte conforme à ANDROID_CERT_SHA256"
fi

# 5. Version, numéro de version, non débogable
badging=$("$tools/aapt" dump badging "$apk")
code=$(echo "$badging" | sed -n "s/^package:.* versionCode='\([0-9]*\)'.*/\1/p" | head -1)
name=$(echo "$badging" | sed -n "s/^package:.* versionName='\([^']*\)'.*/\1/p" | head -1)
echo "versionName=$name versionCode=$code"
[ "$name" = "$want_version" ] || fail "versionName « $name » au lieu de « $want_version »"
[ -n "$code" ] && [ "$code" -ge "$min_code" ] || fail "versionCode « $code » inférieur à $min_code : une mise à jour par-dessus 1.3.0 serait refusée"
if echo "$badging" | grep -q 'application-debuggable'; then fail "l'APK est débogable"; fi
echo "Contrôles de l'APK : tous passés"
