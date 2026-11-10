# AlchemyCut en Mac

## Instalar (una sola vez)
1. Descomprimí la carpeta `AlchemyCut` en cualquier lugar (por ejemplo en Documentos) y cerrá Premiere Pro.
2. Doble clic en **`instalar-mac.command`**.
   Si macOS dice que no se puede abrir: clic derecho sobre el archivo › **Abrir** › Abrir.
3. Abrí Premiere Pro → menú **Ventana › Extensiones › AlchemyCut**.
4. Si arriba del panel aparece “Falta instalar: …”, apretá **Instalar ahora**.
   Instala ffmpeg (~45 MB, se baja), Whisper (ya viene con el plugin) y baja el modelo de transcripción (~570 MB).
   Se hace una sola vez, queda en tu carpeta de usuario (`~/.alchemycut`) y no pide contraseña ni usa Homebrew.

Después de eso la transcripción funciona **sin internet y gratis** con Whisper local (primera opción del panel).
También podés usar OpenAI o ElevenLabs con tu API key.

## Notas
- Funciona en Macs con Apple Silicon (M1 y siguientes) y en Intel.
- Si ya tenés ffmpeg y whisper-cpp instalados con Homebrew, el panel los usa y no baja nada de eso.
- Desinstalar: borrá la carpeta `~/Library/Application Support/Adobe/CEP/extensions/com.adsalchemy.alchemycut` (y `~/.alchemycut` si querés liberar espacio).

## Cómo se usa
Mirá **GUIA-DE-USO.md** (en esta misma carpeta): explica paso a paso los cortes y los subtítulos.
