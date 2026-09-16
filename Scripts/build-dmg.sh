#!/bin/bash
# Genera dist/Claude-Dispatch-<versión>.dmg con herramientas que ya trae macOS.
# Uso: bash Scripts/build-dmg.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/orquestador-agentes"
DIST="$ROOT/dist"
APP="$DIST/Claude Dispatch.app"
VERSION="$(node -p "require('$SRC/package.json').version")"
DMG="$DIST/Claude-Dispatch-$VERSION.dmg"

echo "→ Compilando Claude Dispatch.app $VERSION"
rm -rf "$DIST"
mkdir -p "$DIST"
RES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/MacOS" "$RES"

# Binario universal (Apple Silicon + Intel)
BIN="$APP/Contents/MacOS/ClaudeDispatch"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13" -o "$DIST/ClaudeDispatch-$arch" "$ROOT/macos/ClaudeDispatch.swift"
done
lipo -create -output "$BIN" "$DIST/ClaudeDispatch-arm64" "$DIST/ClaudeDispatch-x86_64"
rm "$DIST/ClaudeDispatch-arm64" "$DIST/ClaudeDispatch-x86_64"

echo "→ Generando el icono"
ICONSET="$DIST/ClaudeDispatch.iconset"
mkdir -p "$ICONSET"
swift "$ROOT/macos/make-icon.swift" "$ROOT/macos/logo.jpg" "$DIST/icon-1024.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$DIST/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$DIST/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns -o "$RES/AppIcon.icns" "$ICONSET"
rm -rf "$ICONSET" "$DIST/icon-1024.png"

cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>ClaudeDispatch</string>
  <key>CFBundleIdentifier</key><string>com.axiuz.claude-dispatch</string>
  <key>CFBundleName</key><string>Claude Dispatch</string>
  <key>CFBundleDisplayName</key><string>Claude Dispatch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

install -m 755 "$ROOT/macos/launcher.sh" "$RES/launcher.sh"

echo "→ Copiando el servidor y sus dependencias"
mkdir -p "$RES/app"
# pnpm-workspace.yaml autoriza el postinstall de node-pty (la terminal del panel)
cp -R "$SRC/server.js" "$SRC/package.json" "$SRC/pnpm-lock.yaml" "$SRC/pnpm-workspace.yaml" "$SRC/public" "$RES/app/"
# Solo los valores por defecto: projects.json lleva rutas reales y no viaja en la app
mkdir -p "$RES/app/data"
cp "$SRC/data/agents.json" "$SRC/data/config.json" "$RES/app/data/"
# node_modules plano (sin symlinks de pnpm) para que viaje bien dentro del bundle
(cd "$RES/app" && pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --silent)
# node-pty 1.1.0 no marca spawn-helper como ejecutable; sin eso la terminal no abre
chmod +x "$RES/app/node_modules/node-pty/prebuilds/"darwin-*/spawn-helper

# Firma ad-hoc: al tocar Resources la firma original del applet deja de valer
codesign --force --deep --sign - "$APP"

echo "→ Empaquetando el DMG"
STAGE="$DIST/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Claude Dispatch" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

echo "✓ $DMG"
