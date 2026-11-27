#!/bin/sh
# Build the simulator's touch pointer (loaded into apps by `looktap touches on`) → lib/assets/looktap-touches.dylib.
# No -fmodules and no -framework UIKit on purpose: the dylib must link Foundation only (see LooktapTouches.m), and
# the check at the end fails the build if a UIKit, QuartzCore or CoreGraphics symbol slipped in.
set -eu
cd "$(dirname "$0")"
OUT=../../lib/assets/looktap-touches.dylib
mkdir -p ../../lib/assets
xcrun -sdk iphonesimulator clang -dynamiclib -fobjc-arc -O2 -arch arm64 -arch x86_64 -mios-simulator-version-min=13.0 \
  -framework Foundation -install_name @rpath/looktap-touches.dylib -o "$OUT" LooktapTouches.m
codesign -s - --force "$OUT" 2>/dev/null
if xcrun otool -L "$OUT" | grep -E 'UIKit|QuartzCore|CoreGraphics'; then
  echo "looktap-touches.dylib links more than Foundation: look classes up by name instead" >&2
  exit 1
fi
if xcrun nm -u "$OUT" | grep -E '_OBJC_CLASS_\$_(UI|CA)|_kCA|_UI[A-Z]|_CG[A-Z]'; then
  echo "looktap-touches.dylib refers to UIKit/QuartzCore/CoreGraphics symbols: look them up by name instead" >&2
  exit 1
fi
echo "built lib/assets/looktap-touches.dylib ($(wc -c < "$OUT" | tr -d ' ') bytes)"
