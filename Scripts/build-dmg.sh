#!/bin/bash
# Genera dist/Singularity-<versión>.dmg con herramientas que ya trae macOS.
# Uso: bash Scripts/build-dmg.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/orquestador-agentes"
DIST="$ROOT/dist"
# Se compila aparte y se cambia al final: un rebuild lanzado desde el propio
# panel borraría la app que lo está ejecutando si trabajáramos sobre dist.
WORK="$DIST/.next"
APP="$WORK/Singularity.app"
FINAL="$DIST/Singularity.app"
VERSION="$(node -p "require('$SRC/package.json').version")"
DMG="$DIST/Singularity-$VERSION.dmg"

echo "→ Compilando Singularity.app $VERSION"
rm -rf "$WORK"
mkdir -p "$WORK"
RES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/MacOS" "$RES"

# Binario universal (Apple Silicon + Intel)
BIN="$APP/Contents/MacOS/Singularity"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13" -o "$WORK/Singularity-$arch" "$ROOT/macos/Singularity.swift"
done
lipo -create -output "$BIN" "$WORK/Singularity-arm64" "$WORK/Singularity-x86_64"
rm "$WORK/Singularity-arm64" "$WORK/Singularity-x86_64"

echo "→ Generando el icono"
ICONSET="$WORK/Singularity.iconset"
mkdir -p "$ICONSET"
swift "$ROOT/macos/make-icon.swift" "$ROOT/macos/logo-singularity.jpg" "$WORK/icon-1024.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$WORK/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$WORK/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns -o "$RES/AppIcon.icns" "$ICONSET"
rm -rf "$ICONSET" "$WORK/icon-1024.png"

cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Singularity</string>
  <key>CFBundleIdentifier</key><string>com.axiuz.singularity</string>
  <key>CFBundleName</key><string>Singularity</string>
  <key>CFBundleDisplayName</key><string>Singularity</string>
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
# Todos los .js de la raíz, no una lista a mano: cada módulo nuevo que se olvidara
# hacía que la app abriera y muriera sola con un Cannot find module
cp -R "$SRC"/*.js \
  "$SRC/package.json" "$SRC/pnpm-lock.yaml" "$SRC/pnpm-workspace.yaml" "$SRC/public" "$RES/app/"

# Red de seguridad: que no salga un bundle al que le falte un require
missing=""
for mod in $(grep -oE 'require\("\./[a-zA-Z0-9_-]+"\)' "$RES/app/server.js" | sed -E 's/require\("\.\/(.*)"\)/\1/' | sort -u); do
  [ -f "$RES/app/$mod.js" ] || missing="$missing $mod.js"
done
if [ -n "$missing" ]; then
  echo "Faltan módulos en el bundle:$missing" >&2
  exit 1
fi
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
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Singularity" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

# El cambio va al final y en dos pasos: la app vieja se aparta y solo se borra
# cuando la nueva ya está en su sitio, así que un fallo aquí no deja a nadie sin app.
echo "→ Instalando la app nueva en dist"
VIEJA="$DIST/Singularity.app.anterior"
rm -rf "$VIEJA"
if [ -d "$FINAL" ]; then mv "$FINAL" "$VIEJA"; fi
mv "$APP" "$FINAL"
rm -rf "$VIEJA" "$WORK"

echo "✓ $DMG"
echo "✓ $FINAL"
