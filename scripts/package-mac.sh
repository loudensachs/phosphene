#!/bin/bash
# Builds Phosphene.app for macOS.
#   bash scripts/package-mac.sh            build and install to /Applications
#   bash scripts/package-mac.sh --release  build release/Phosphene-<version>-mac-<arch>.dmg and .zip (nothing is installed)
set -euo pipefail
cd "$(dirname "$0")/.."
APP="/Applications/Phosphene.app"
MODE="${1:-install}"
STAGE="$(mktemp -d)/Phosphene.app"

echo "• icon"
ICONSET="$(mktemp -d)/phosphene.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/icon.icns

echo "• renderer bundle"
npx tsc --noEmit
npx vite build --outDir dist --emptyOutDir >/dev/null

echo "• app bundle"
ditto node_modules/electron/dist/Electron.app "$STAGE"
RES="$STAGE/Contents/Resources"
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app"
ditto electron "$RES/app/electron"
ditto dist "$RES/app/dist"
VERSION=$(node -p "require('./package.json').version")
printf '{ "name": "phosphene", "productName": "Phosphene", "version": "%s", "main": "electron/main.cjs" }\n' "$VERSION" > "$RES/app/package.json"
cp build/icon.icns "$RES/phosphene.icns"
PL="$STAGE/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PL" 2>/dev/null || true; }
pb "Set :CFBundleName Phosphene"; pb "Set :CFBundleDisplayName Phosphene"; pb "Add :CFBundleDisplayName string Phosphene"
pb "Set :CFBundleIdentifier app.phosphene.desktop"; pb "Set :CFBundleIconFile phosphene.icns"
pb "Set :CFBundleShortVersionString $VERSION"; pb "Set :CFBundleVersion $VERSION"
pb "Set :NSCameraUsageDescription Phosphene uses the camera as a live video source."; pb "Add :NSCameraUsageDescription string Phosphene uses the camera as a live video source."
pb "Set :NSMicrophoneUsageDescription Phosphene uses audio input to drive visuals."; pb "Add :NSMicrophoneUsageDescription string Phosphene uses audio input to drive visuals."
pb "Add :LSApplicationCategoryType string public.app-category.video"
# .phos projects open in Phosphene when double-clicked
pb "Add :CFBundleDocumentTypes array"; pb "Add :CFBundleDocumentTypes:0 dict"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeName string Phosphene Project"; pb "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor"
pb "Add :CFBundleDocumentTypes:0:LSHandlerRank string Owner"; pb "Add :CFBundleDocumentTypes:0:CFBundleTypeIconFile string phosphene.icns"
pb "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array"; pb "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string phos"
rm -f "$RES/electron.icns"

echo "• sign (ad hoc)"
codesign --force --deep --sign - "$STAGE" >/dev/null 2>&1

if [ "$MODE" = "--release" ]; then
  ARCH=$(uname -m); NAME="Phosphene-$VERSION-mac-$ARCH"; OUT="release"
  mkdir -p "$OUT"; rm -f "$OUT/$NAME.dmg" "$OUT/$NAME.zip"
  echo "• zip"
  ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$OUT/$NAME.zip"
  echo "• dmg"
  DMGDIR="$(mktemp -d)/Phosphene"; mkdir -p "$DMGDIR"
  ditto "$STAGE" "$DMGDIR/Phosphene.app"; ln -s /Applications "$DMGDIR/Applications"
  hdiutil create -volname "Phosphene $VERSION" -srcfolder "$DMGDIR" -ov -format UDZO -imagekey zlib-level=9 "$OUT/$NAME.dmg" >/dev/null
  ( cd "$OUT" && shasum -a 256 "$NAME.dmg" "$NAME.zip" > "$NAME.sha256" )
  echo "Built $OUT/$NAME.dmg ($(du -h "$OUT/$NAME.dmg" | cut -f1)) and $OUT/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1))"
  exit 0
fi

echo "• install"
rm -rf "$APP"
ditto "$STAGE" "$APP"
touch "$APP"
echo "Installed $APP ($(du -sh "$APP" | cut -f1))"
