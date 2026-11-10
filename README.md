# AlchemyCut

Plugin de Premiere Pro para **cortar silencios, muletillas y tomas repetidas** y para poner **subtítulos animados** con el estilo que elijas. Transcribe con Whisper (local y gratis) y puede usar un guion para corregir los textos.

## Instalar
1. En [Releases](../../releases/latest) bajá **un** zip, el de tu sistema:
   - `AlchemyCut-Windows.zip`
   - `AlchemyCut-Mac.zip`
2. Descomprimilo y seguí `INSTALAR-WINDOWS.md` o `INSTALAR-MAC.md` (adentro del zip). La guía de uso está en `GUIA-DE-USO.md`.
3. Abrí Premiere Pro › Ventana › Extensiones › AlchemyCut.

## Actualizaciones
El panel busca solo versiones nuevas y muestra un botón **Actualizar ahora**. Cada versión se publica como un Release con sus zips y un `version.json` con la huella (SHA-256) de cada uno; el panel comprueba la huella antes de instalar.

## Para quien mantiene el plugin
```
./publicar.sh 1.2.0 "Qué cambió, en una frase"      # sube la versión, arma los zips y crea el Release
./publicar.sh 1.2.0 "notas" --solo-local             # arma todo en dist/ sin publicar (prueba)
node test/logic.test.js                               # pruebas automáticas
```
El código del panel está en `js/`, `css/` e `index.html`; el motor (ffmpeg, Whisper, cortes) en `engine/`; lo que habla con Premiere en `jsx/host.jsx`.

`engine/bin/mac/whisper-cli` es [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (licencia MIT) compilado para Mac; ver `engine/bin/mac/LEEME.txt`.
