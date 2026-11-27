#!/bin/sh
# Build looktap runner for Android (installed only by `looktap runner install`) → build/looktap-app.apk.
# No Gradle: javac, d8, aapt2 and apksigner from the Android SDK, as for the Wi-Fi keeper. Its icon is the runner's
# (native/ios-device/LooktapRunner/Icon). Signed with a key made for this one build and deleted right after: no signing
# key is kept anywhere. Releases are built by .github/workflows/companion.yml and published as the GitHub release
# app-v<versionCode>, which looktap downloads; a phone whose app came from another build gets it reinstalled.
set -eu
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="$(ls -d "$SDK"/platforms/android-[0-9]* | sort -V | tail -1)"
BT="$(ls -d "$SDK"/build-tools/[0-9]* | sort -V | tail -1)"
OUT=build
KEYDIR="$(mktemp -d)"
trap 'rm -rf "$KEYDIR"' EXIT
PASS="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/res/mipmap-xxxhdpi" "$OUT/res/mipmap-xxhdpi"
cp ../ios-device/LooktapRunner/Icon/AppIcon60x60@3x.png "$OUT/res/mipmap-xxxhdpi/ic_launcher.png"
cp ../ios-device/LooktapRunner/Icon/AppIcon60x60@2x.png "$OUT/res/mipmap-xxhdpi/ic_launcher.png"
keytool -genkeypair -keystore "$KEYDIR/key.p12" -storetype PKCS12 -storepass "$PASS" -alias app \
  -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=looktap runner" >/dev/null 2>&1
javac -source 8 -target 8 -Xlint:-options -bootclasspath "$PLATFORM/android.jar" -d "$OUT/classes" $(find src -name '*.java')
"$BT/d8" --release --min-api 29 --lib "$PLATFORM/android.jar" --output "$OUT" $(find "$OUT/classes" -name '*.class')
"$BT/aapt2" compile --dir "$OUT/res" -o "$OUT/res.zip"
"$BT/aapt2" link --manifest AndroidManifest.xml -I "$PLATFORM/android.jar" -R "$OUT/res.zip" --auto-add-overlay \
  --min-sdk-version 29 --target-sdk-version 35 -o "$OUT/unsigned.apk"
(cd "$OUT" && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KEYDIR/key.p12" --ks-pass "pass:$PASS" --out "$OUT/looktap-app.apk" "$OUT/aligned.apk"
rm -f "$OUT/unsigned.apk" "$OUT/aligned.apk" "$OUT/res.zip"
echo "built native/android-app/build/looktap-app.apk ($(wc -c < "$OUT/looktap-app.apk" | tr -d ' ') bytes; its signing key is already deleted)"
