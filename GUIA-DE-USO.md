# AlchemyCut — Guía de uso

AlchemyCut es un panel de Premiere Pro que hace dos cosas, cada una por separado:

- **✂ Cortes:** saca silencios, muletillas, voces bajas (indicaciones fuera de cámara) y tomas repetidas.
- **Subtítulos:** transcribe el video y pone captions animados con el estilo que elijas.

Se abre en **Ventana › Extensiones › AlchemyCut**. (Para instalarlo, mirá `INSTALAR-WINDOWS.md` o `INSTALAR-MAC.md`.)

---

## Antes de empezar
1. Abrí tu proyecto y tené la secuencia activa.
2. Si arriba del panel aparece **“Falta instalar: …”**, apretá **Instalar ahora** y esperá a que termine. Se hace una sola vez y necesita internet.
3. Todos los cambios se hacen sobre la secuencia: podés deshacer con Ctrl/Cmd + Z.

---

## ✂ Cortes (silencios, muletillas, repeticiones)

1. En la secuencia, **seleccioná el clip** con la voz.
2. En el panel, tocá **Leer selección**.
3. Elegí qué querés sacar:
   - **Silencios:** dejá marcado “Umbral automático”. “Duración mínima” es cuánto tiene que durar un silencio para cortarlo; “Aire a cada lado” deja un respiro antes y después de cada palabra.
   - **Quitar voces bajas:** para indicaciones que se escuchan de fondo. Poné el nivel en dB entre tu voz de fondo (por ejemplo -33) y tu voz principal (por ejemplo -6); **-20** va bien para empezar.
   - **Quitar muletillas** (eh, um, o sea…) y **Quitar repeticiones** (si repetiste una frase, queda la última toma). Estas dos transcriben el audio.
4. Tocá **Analizar**. Te muestra cuántos cortes hace y cuánto tiempo ahorra, con la lista de tramos.
5. Si te gusta, **Aplicar cortes**. Los tramos se cortan y se eliminan de la secuencia, cerrando el hueco.
   Si no, **← Cambiar ajustes** y probás otra vez.

### Método de corte: Rápido o Preciso
Arriba de las opciones elegís cómo se cortan los silencios:
- **Rápido (por volumen):** lo de siempre. No transcribe, es lo más veloz.
- **Preciso (por palabras y guion):** transcribe el audio y corta las pausas **entre palabras**, dejando la pausa que corresponde a cada signo: más larga después de un punto, más corta después de una coma, mínima entre palabras. Se mide en el audio real y nunca se corta adentro de una palabra. Tarda más, pero suena más natural.
  - **Pausa que queda…** son tres controles (punto, coma, entre palabras) y **“Solo se acortan las pausas de más de…”** deja intactas las pausas cortas.
  - **Quedarme con la mejor toma de cada frase (usa el guion):** pegá el guion en el cuadro que aparece. Si dijiste una frase varias veces, queda la mejor (la más parecida al guion; si empatan, la última). Se sacan los arranques en falso, las tomas anteriores y lo que no está en el guion (“a ver”, “listo, corte”).
  - Si una frase se dijo **con otras palabras**, no se saca sola: queda en la lista **sin marcar** con el aviso “posible versión distinta de…”, para que vos decidas. “Parecido mínimo con el guion” regula qué tan estricto es.
  - Sin guion también funciona (solo ajusta las pausas), pero no puede elegir tomas.
- En los dos métodos, la lista de cortes tiene una **casilla por corte** (podés desmarcar los que no querés) y un botón **Ir** que lleva el cursor de Premiere a ese punto para escucharlo antes de aplicar.

Consejos:
- Aplicá los cortes **una sola vez** por análisis. Si querés volver a analizar el mismo clip, seleccionalo y tocá **Leer selección** de nuevo.
- Los cortes se hacen en todas las pistas, así el video y el audio quedan sincronizados.

---

## Subtítulos

### 1. Elegir qué transcribir
Entrá a la pestaña **Subtítulos** (arriba a la derecha). En **Qué transcribir**:
- **Los clips que tengo seleccionados** — seleccioná uno o varios pedazos en la secuencia (sirven clips ya cortados y secuencias anidadas).
- **Toda la secuencia (pista de audio)** — elegís la pista.
- **Solo entre las marcas de entrada y salida** — marcás I y O en la secuencia.

Siempre se transcribe **lo que está en la secuencia**, no el archivo original completo.

### 2. Transcripción
- **Idioma:** español, inglés, portugués o detectar.
- **Transcripción con:** *Whisper local* es gratis, funciona sin internet y es lo recomendado. OpenAI y ElevenLabs piden una API key.
- **Calidad:** “Alta” es la más precisa; “Media” es más liviana y rápida.

### 3. Guion (opcional pero muy recomendado)
Si tenés el guion de lo que se dice, **pegalo** en el cuadro (o tocá **Cargar .txt**). Aparece una etiqueta verde “✓ pegado · N palabras”.
La transcripción se corrige con el guion: nombres, tildes, mayúsculas y puntuación salen como en el guion, y los tiempos se mantienen. Lo que dijiste y no está en el guion queda como se dijo.
Pegá solo lo que se dice; las indicaciones entre [corchetes] y los títulos terminados en “:” se ignoran.

Tocá **Transcribir**. La primera vez con Whisper local puede tardar un poco.

### 4. Editar los subtítulos (pestaña Líneas)
Se abre el editor: la **vista previa** queda a la izquierda y, a su lado, la pestaña **Líneas** con la lista de subtítulos:
- Editá el texto de cada subtítulo. **Unir** lo junta con el siguiente; **Dividir** lo corta donde está el cursor.
- **◂ ▸** adelantan o atrasan ese subtítulo (0,05 s; con Shift, 0,25 s). **🗑** lo borra de la lista.
- Tildá los subtítulos que quieras tocar para trabajar solo con ellos (**Marcar todos / Ninguno / Borrar los marcados**).
- Arrastrá la esquinita de abajo a la derecha de la lista para **agrandarla**.
- **Corregir con el guion:** si pegaste el guion después de transcribir, esto lo aplica sin volver a transcribir.
- Más abajo, **Cómo se parten los subtítulos**: caracteres y palabras por línea, líneas por subtítulo, **adelantar o atrasar todos** a la vez, que cada subtítulo dure hasta el siguiente, quitar signos. (Al cambiar esto se rearman los subtítulos y se pierden las ediciones a mano: conviene usarlo primero.)
- Al final, plegable, **Buscar y reemplazar palabras**: en todos los subtítulos o solo en los marcados.
- Clic en la vista previa para **mover el texto** de lugar.
- “Volver al inicio” no pierde nada: podés volver con **Volver a los subtítulos que ya transcribí →**.
- Si volvés al inicio y transcribís otra selección (o cargás subtítulos de la secuencia) teniendo **cambios sin agregar**, el panel te avisa y pide tocar el botón otra vez antes de reemplazar lo que estás editando. Lo que ya agregaste a la secuencia no se toca.

### 5. Estilo y animación, y Agregar
- **Estilo y animación** (una pestaña con dos solapitas: **Estilo** y **Animación**): en Estilo, elegí uno de los **estilos** de la galería (se ven con su fuente, color y contorno) o armá el tuyo: fuente, tamaño, grosor, contorno, colores (texto, resalte, contorno, caja), caja detrás del texto, sombra, MAYÚSCULAS.
  - Cada slider tiene al lado una **casilla para escribir el valor exacto**.
  - Cada color tiene un **cuentagotas** para tomar un color del fotograma del video o de la pantalla.
  - **Posición del texto:** deslizadores de **Altura** y **Horizontal**, el cuadrito con el punto amarillo (arrastralo) o un clic en la vista previa. Hay atajos Arriba / Centro / Abajo.
  - **Guardar como estilo nuevo** guarda tu estilo; **Actualizar este estilo** lo modifica (los de fábrica no se pueden pisar). Con la casilla **“Guardar también cómo se parten los subtítulos”** (marcada por defecto), el estilo guarda además los caracteres por línea, palabras por línea, líneas por subtítulo, la puntuación a quitar y si cada subtítulo dura hasta el siguiente: al elegir ese estilo, los subtítulos se vuelven a armar así. Si tenías ediciones a mano, el panel avisa y pide tocar el estilo otra vez antes de rearmar. Los estilos de fábrica no cambian estas opciones.
  - “Aplicar los cambios a… solo los que marqué” te deja dar a unos subtítulos un estilo distinto; **Volver al estilo general** los devuelve.
  - **Animación** (solapita al lado de **Estilo**, arriba de la galería): cada tarjeta muestra un **ejemplo animado** con tu estilo. Elegí las que quieras (se combinan): pop, fundido, palabra por palabra, crece, resalta, subraya. “Una palabra por vez” muestra cada palabra sola y centrada.
- **Agregar:** formato y dónde se pone (siguiente punto).

### 6. Agregar los subtítulos a la secuencia
En la pestaña **Agregar**:
- **Formato:** **PNG** (liviano, recomendado) o **Video .mov con transparencia** (animación completa, pesa más).
- **Qué agregar:** todas las líneas o solo las marcadas.
- **Reemplazar los captions de AlchemyCut que ya estén en ese tramo:** dejalo marcado para no duplicar al volver a agregar.
- **Pista de destino:** automática o la que elijas.
- Tocá **Agregar captions a la secuencia**. (“Agregar como captions nativos” crea un SRT sin estilo.)

---

### 7. Cambiar subtítulos que ya están en la secuencia
Si después querés cambiar el color, el tamaño, la fuente, el texto o la posición de algunos subtítulos:
1. En la secuencia, **seleccioná los clips de subtítulos** que querés cambiar (se llaman `ac_…`).
2. En el panel, pestaña **Subtítulos**, tocá **Editar los subtítulos que seleccioné**.
3. Se abre el editor solo con esas líneas, con el estilo que tenían. Cambiá lo que quieras (Estilo, Animación, texto…).
4. En **Agregar**, tocá **Agregar captions a la secuencia**: se reemplazan **solo esos** clips; el resto no se toca.

**Si agregaste algo por error**, en Subtítulos (pantalla de inicio) están **Borrar de la secuencia los que seleccioné** y **Borrar de la secuencia todos los de AlchemyCut** (piden confirmar tocando dos veces; Ctrl/Cmd + Z lo deshace).

Notas: funciona con los subtítulos agregados desde esta versión (el panel guarda un registro de cada tanda en esta computadora). Si moviste los clips en la secuencia, los vuelve a poner donde están ahora. Esto reemplaza lo que tengas abierto en el editor.

---

## Atajos y detalles
- **Ctrl/Cmd + C, V, X, A** funcionan para copiar y pegar dentro del panel.
- Las fuentes del selector son las que tiene instaladas tu computadora. Si una fuente no sale en la lista, instalala en el sistema y reabrí el panel.
- Tus ajustes se guardan entre sesiones.

## Actualizaciones
AlchemyCut se actualiza solo desde GitHub. Una vez por día el panel mira si hay una versión nueva; si la hay, aparece arriba un aviso azul: **“Hay una versión nueva… Actualizar ahora”**. Tocalo y esperá unos segundos: el panel se recarga solo. Tus ajustes y estilos guardados se conservan.
- El botón **↻**, al lado del nombre (arriba a la izquierda), busca actualizaciones cuando quieras. Al lado se ve la versión instalada.
- Solo descarga de GitHub, por conexión segura y comprobando que el archivo sea el correcto antes de instalarlo.
- Lo que cada persona tiene instalado aparte (ffmpeg, Whisper y los modelos) no se vuelve a bajar.

## Si algo no anda
| Pasa esto | Probá esto |
|---|---|
| El panel no aparece en Extensiones | Cerrá Premiere del todo, volvé a correr el instalador y abrilo de nuevo. |
| “Falta instalar…” | Apretá **Instalar ahora** y esperá. Necesita internet solo esa vez. |
| “No se pudo cortar ningún tramo” / el clip “ya no está como cuando lo analizaste” | Seleccioná el clip, **Leer selección** y volvé a analizar. |
| “No encuentro el registro de esos subtítulos” | Esos clips se agregaron con una versión anterior o en otra computadora. Volvé a transcribir y agregalos de nuevo (a partir de ahí quedan registrados). |
| Los subtítulos salen desfasados con el audio | 0) Si el clip está acelerado o frenado, el panel ya lo tiene en cuenta (en “Leer” aparece “velocidad ajustada (125 %)”); si no aparece, avisá. 1) Transcribí **después** de hacer los cortes, no antes (los tiempos se calculan sobre lo que hay en la secuencia en ese momento). 2) Los clips invertidos o con velocidad variable (rampas) no se pueden ajustar: el panel lo avisa con un ⚠. 3) Corregí una línea con ◂ ▸ o todas con “Desfase de los captions”. |
| Transcribe de más o de menos | Revisá **Qué transcribir** y, si usás clips sueltos, que estén seleccionados. |
| La transcripción tarda mucho | Usá la calidad **Media** o transcribí un tramo más corto. |
| Falta alguna palabra en la secuencia | El panel avisa cuántas imágenes no quedaron en la pista (pasa con palabras que duran muy poco). Probá desmarcar “Palabra por palabra” o agregá de nuevo solo esas líneas. |
| El texto sale con otra fuente | Esa fuente no está instalada en tu computadora: elegí otra o instalala. |
| Cuentagotas: la pantalla se ve solo con el fondo (Mac) | Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla: activá Premiere Pro y reabrilo. Mientras tanto usá “Fotograma del video”. |

Si algo falla, mandá una captura del panel con el mensaje que aparece abajo.
