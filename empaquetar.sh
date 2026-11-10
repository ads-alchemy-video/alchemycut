#!/usr/bin/env bash
# Arma dist/AlchemyCut-Windows.zip y dist/AlchemyCut-Mac.zip para repartir. Correr cada vez que cambie el plugin.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$PWD/dist"; mkdir -p "$OUT"; rm -f "$OUT"/AlchemyCut-*.zip
STAGE="$(mktemp -d)"
for os in Windows Mac; do
  d="$STAGE/$os/AlchemyCut"; mkdir -p "$d"
  for f in CSXS css js jsx engine index.html version.json; do cp -R "$f" "$d/"; done
done
rm -rf "$STAGE/Windows/AlchemyCut/engine/bin"          # el whisper-cli de Mac no va en el zip de Windows
cp GUIA-DE-USO.md "$STAGE/Windows/AlchemyCut/"; cp GUIA-DE-USO.md "$STAGE/Mac/AlchemyCut/"
cp instalar-windows.bat install.ps1 INSTALAR-WINDOWS.md "$STAGE/Windows/AlchemyCut/"
cp instalar-mac.command install.sh INSTALAR-MAC.md "$STAGE/Mac/AlchemyCut/"
find "$STAGE" \( -name '._*' -o -name '.DS_Store' \) -delete
(cd "$STAGE/Windows" && zip -r -X -q "$OUT/AlchemyCut-Windows.zip" AlchemyCut)
(cd "$STAGE/Mac" && zip -r -X -q "$OUT/AlchemyCut-Mac.zip" AlchemyCut)
rm -rf "$STAGE"; rm -f "$OUT"/._* 2>/dev/null || true
ls -la "$OUT"
