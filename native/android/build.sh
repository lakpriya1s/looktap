#!/bin/sh
# Build the Android helper: javac against android.jar, then d8 → lib/assets/simwright-server.jar.
set -eu
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/classes"
javac -source 8 -target 8 -Xlint:-options -bootclasspath "$PLATFORM/android.jar" -d "$OUT/classes" $(find src -name '*.java')
"$BT/d8" --release --min-api 24 --lib "$PLATFORM/android.jar" --output "$OUT" $(find "$OUT/classes" -name '*.class')
mkdir -p ../../lib/assets
(cd "$OUT" && rm -f simwright-server.jar && zip -q simwright-server.jar classes.dex)
cp "$OUT/simwright-server.jar" ../../lib/assets/simwright-server.jar
echo "built lib/assets/simwright-server.jar ($(wc -c < ../../lib/assets/simwright-server.jar | tr -d ' ') bytes)"
