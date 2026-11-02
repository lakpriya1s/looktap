#!/bin/sh
# Build looktap's Wi-Fi keeper (installed only by `looktap wifi --always`) → build/looktap-wifi.apk.
# Signed with a key made for this one build and deleted right after: no signing key is kept anywhere. Releases are
# built by .github/workflows/keeper.yml and published as the GitHub release keeper-v<versionCode>, which looktap
# downloads. A phone whose keeper came from another build gets it reinstalled (looktap handles the key change).
set -eu
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="$(ls -d "$SDK"/platforms/android-[0-9]* | sort -V | tail -1)"
BT="$(ls -d "$SDK"/build-tools/[0-9]* | sort -V | tail -1)"
OUT=build
KEYDIR="$(mktemp -d)"
trap 'rm -rf "$KEYDIR"' EXIT
PASS="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
rm -rf "$OUT" && mkdir -p "$OUT/classes"
keytool -genkeypair -keystore "$KEYDIR/key.p12" -storetype PKCS12 -storepass "$PASS" -alias keeper \
  -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=looktap Wi-Fi keeper" >/dev/null 2>&1
javac -source 8 -target 8 -Xlint:-options -bootclasspath "$PLATFORM/android.jar" -d "$OUT/classes" $(find src -name '*.java')
"$BT/d8" --release --min-api 30 --lib "$PLATFORM/android.jar" --output "$OUT" $(find "$OUT/classes" -name '*.class')
"$BT/aapt2" link --manifest AndroidManifest.xml -I "$PLATFORM/android.jar" --min-sdk-version 30 --target-sdk-version 35 -o "$OUT/unsigned.apk"
(cd "$OUT" && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KEYDIR/key.p12" --ks-pass "pass:$PASS" --out "$OUT/looktap-wifi.apk" "$OUT/aligned.apk"
rm -f "$OUT/unsigned.apk" "$OUT/aligned.apk"
echo "built native/android-wifi/build/looktap-wifi.apk ($(wc -c < "$OUT/looktap-wifi.apk" | tr -d ' ') bytes; its signing key is already deleted)"
