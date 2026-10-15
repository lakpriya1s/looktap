#!/bin/sh
# Build the iOS helper (universal macOS binary) → lib/assets/simdrive-sim.
set -eu
cd "$(dirname "$0")"
mkdir -p ../../lib/assets
clang -fobjc-arc -O2 -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -Wno-objc-method-access \
  -framework Foundation -framework AppKit -framework IOSurface -framework ImageIO -framework CoreGraphics \
  -framework UniformTypeIdentifiers \
  -o ../../lib/assets/simdrive-sim simdrive-sim.m
echo "built lib/assets/simdrive-sim ($(wc -c < ../../lib/assets/simdrive-sim | tr -d ' ') bytes)"
