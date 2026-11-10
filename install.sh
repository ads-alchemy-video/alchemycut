#!/usr/bin/env bash
# Instala AlchemyCut en Mac: copia el panel a las extensiones CEP del usuario y habilita extensiones sin firmar.
# Reiniciá Premiere después. Menú: Ventana > Extensiones > AlchemyCut.
#   bash install.sh          copia el panel (lo normal)
#   bash install.sh --link   enlaza esta carpeta en vez de copiar (para desarrollo)
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.adsalchemy.alchemycut"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
if [ "${1:-}" = "--link" ]; then
  ln -sfn "$SRC" "$DEST"
  echo "Enlazado: $DEST -> $SRC"
else
  mkdir -p "$DEST"
  cp -R "$SRC"/. "$DEST"/
  rm -rf "$DEST/test" "$DEST/dist" "$DEST/.git" "$DEST/instalar-windows.bat" "$DEST/install.ps1"
  echo "Copiado a: $DEST"
fi
# sin la marca de "descargado de internet", si no macOS bloquea el whisper-cli que viene con el panel
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
chmod +x "$DEST/engine/bin/mac/whisper-cli" 2>/dev/null || true
for v in 9 10 11 12; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
echo "PlayerDebugMode activado (CSXS 9 a 12). Reiniciá Premiere Pro."
