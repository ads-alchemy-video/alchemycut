#!/bin/bash
# Doble clic para instalar AlchemyCut en Mac.
cd "$(dirname "$0")"
if bash install.sh; then
  echo
  echo "Listo. Cerrá Premiere Pro del todo y abrilo de nuevo."
  echo "Abrí el panel: Ventana > Extensiones > AlchemyCut."
  echo "Si arriba dice \"Falta instalar...\", apretá \"Instalar ahora\": baja ffmpeg y el modelo de Whisper (una sola vez)."
else
  echo
  echo "Algo salió mal. Copiá el mensaje de arriba y mandalo."
fi
echo
read -n 1 -s -r -p "Tocá una tecla para cerrar"
