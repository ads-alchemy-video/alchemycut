# AlchemyCut en Windows

## Instalar (una sola vez)
1. Descomprimí la carpeta `alchemycut` en cualquier lugar (por ejemplo en Documentos).
2. Cerrá Premiere Pro.
3. Doble clic en **`instalar-windows.bat`**. No pide permisos de administrador.
4. Abrí Premiere Pro → menú **Ventana › Extensiones › AlchemyCut**.
5. Si arriba del panel aparece “Falta instalar: ffmpeg, Whisper…”, apretá **Instalar ahora**.
   Baja ffmpeg (~115 MB), Whisper (~9 MB) y el modelo de transcripción (~570 MB) a tu carpeta de usuario
   (`%USERPROFILE%\.alchemycut`). Se hace una sola vez y necesita internet solo para bajar.

Después de eso la transcripción funciona **sin internet y gratis** con Whisper local (es la primera opción del panel).
También podés usar OpenAI o ElevenLabs con tu API key.

## Si no aparece en el menú Extensiones
- Asegurate de haber cerrado Premiere del todo antes de instalar y de abrirlo de nuevo.
- Volvé a correr `instalar-windows.bat` y mirá si muestra algún error.

## Desinstalar
```
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```
(la carpeta `%USERPROFILE%\.alchemycut` con ffmpeg y los modelos se puede borrar a mano).

## Notas
- La transcripción local usa el procesador (CPU). Con el modelo “Large v3 turbo” puede tardar varios minutos según tu PC; si va muy lento, elegí el modelo “Small”.
- Las fuentes del selector son las que tiene instaladas tu Windows.
- Cuentagotas: el botón “Fotograma del video” siempre funciona; la foto de pantalla puede tardar un segundo.

## Cómo se usa
Mirá **GUIA-DE-USO.md** (en esta misma carpeta): explica paso a paso los cortes y los subtítulos.
