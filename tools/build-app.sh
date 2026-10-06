#!/bin/zsh
# Builds "BMD Emulator.app" (a menu bar app) into build/.
#
#   tools/build-app.sh           universal: runs on Apple silicon and Intel Macs
#   tools/build-app.sh --native  smaller, for this Mac's processor only
#
# Needs the Xcode command line tools (swiftc) and Node.js, which gets copied
# into the app so it runs on Macs without Node installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/BMD Emulator.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

UNIVERSAL=1
[[ "${1:-}" == "--native" ]] && UNIVERSAL=0
SOURCES=("$ROOT/app/main.swift" "$ROOT/app/Model.swift" "$ROOT/app/Window.swift")
ARCH="$(uname -m)"

echo "Building BMD Emulator.app…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/emulator" "$APP/Contents/Resources/bin"

# The menu bar app
if (( UNIVERSAL )); then
  swiftc -O -swift-version 5 -target arm64-apple-macos12 "${SOURCES[@]}" -o "$TMP/arm64"
  swiftc -O -swift-version 5 -target x86_64-apple-macos12 "${SOURCES[@]}" -o "$TMP/x86_64"
  lipo -create "$TMP/arm64" "$TMP/x86_64" -output "$APP/Contents/MacOS/BMD Emulator"
else
  swiftc -O -swift-version 5 -target "$ARCH-apple-macos12" "${SOURCES[@]}" -o "$APP/Contents/MacOS/BMD Emulator"
fi

# The emulator itself
cp -R "$ROOT/emulator.mjs" "$ROOT/lib" "$ROOT/web" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/THIRD_PARTY.md" "$APP/Contents/Resources/emulator/"
mkdir -p "$APP/Contents/Resources/emulator/tools"
cp "$ROOT/tools/capture-atem.mjs" "$APP/Contents/Resources/emulator/tools/"

# Node.js (a universal build needs a universal node, like the nodejs.org installer's)
NODE="$(command -v node)"
if (( UNIVERSAL )) && ! { lipo -archs "$NODE" | grep -q arm64 && lipo -archs "$NODE" | grep -q x86_64; }; then
  echo "This Node.js isn't universal; install it from nodejs.org or use --native." >&2
  exit 1
fi
if (( UNIVERSAL )) || ! lipo -archs "$NODE" | grep -q " "; then
  cp "$NODE" "$APP/Contents/Resources/bin/node"
else
  lipo -thin "$ARCH" "$NODE" -output "$APP/Contents/Resources/bin/node"
fi
chmod +x "$APP/Contents/Resources/bin/node"

# Icon
swift "$ROOT/app/make-icon.swift" "$TMP/icon.png"
mkdir -p "$TMP/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$TMP/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

VERSION="$(node -p "require('$ROOT/package.json').version")"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BMD Emulator</string>
  <key>CFBundleDisplayName</key><string>BMD Emulator</string>
  <key>CFBundleIdentifier</key><string>local.bmd-emulator</string>
  <key>CFBundleExecutable</key><string>BMD Emulator</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Carry over anything already programmed with the Terminal version, the first time.
DATA="$HOME/Library/Application Support/BMD Emulator"
if [[ ! -e "$DATA/settings.json" && -d "$ROOT/data" ]]; then
  mkdir -p "$DATA"
  cp -R "$ROOT/data/." "$DATA/"
  [[ -d "$ROOT/profiles" ]] && cp -R "$ROOT/profiles" "$DATA/"
  echo "Copied existing emulator data to $DATA"
fi

# Ad-hoc signature so macOS will run it (and allow Start at Login).
codesign --force --deep --sign - "$APP" >/dev/null 2>&1

echo "Built $APP ($(du -sh "$APP" | cut -f1))"
