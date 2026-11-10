/* AlchemyCut — dibujo de captions animados en canvas.
 * Una sola función de dibujo (draw) sirve para la vista previa del panel y para el render final,
 * así lo que ves es lo que se exporta. Todas las medidas están en píxeles del cuadro de la secuencia. */
(function (root) {
  'use strict';

  // Se pueden combinar (como en FireCut): las de línea afectan a todo el texto, las de palabra a la palabra activa.
  var ANIMATIONS = [
    { id: 'pop', label: 'Pop', icon: '💥', desc: 'La línea aparece con rebote' },
    { id: 'fade', label: 'Fundido', icon: '🌫', desc: 'Entra y sale suave' },
    { id: 'reveal', label: 'Palabra por palabra', icon: '🔤', desc: 'Las palabras van apareciendo' },
    { id: 'grow', label: 'Crece', icon: '🔍', desc: 'Se agranda la palabra que suena' },
    { id: 'highlight', label: 'Resalta', icon: '🖍', desc: 'Pinta la palabra que suena' },
    { id: 'underline', label: 'Subraya', icon: '＿', desc: 'Subraya la palabra que suena' }
  ];

  var DEFAULT_STYLE = {
    font: 'Montserrat', weight: 800, size: 64, color: '#ffffff', highlight: '#ffd400',
    outline: true, outlineColor: '#000000', outlineWidth: 8,
    box: false, boxColor: '#000000', boxOpacity: 0.8, boxRadius: 22, boxPad: 20,
    shadow: true, uppercase: false, vpos: 78, hpos: 50, animations: ['pop', 'highlight']
  };

  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var easeOutBack = function (x) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  var easeOut = function (x) { return 1 - Math.pow(1 - x, 3); };
  var has = function (style, id) { return (style.animations || []).indexOf(id) > -1; };

  // Palabras de la línea con su tiempo. Si el texto se editó a mano, el tiempo se reparte por largo de palabra.
  function lineWords(line) {
    var flat = line.text.replace(/\s+/g, ' ').trim();
    if (line.words && line.words.length && line.words.map(function (w) { return w.text; }).join(' ') === flat) {
      return line.words;
    }
    var toks = flat.split(' ').filter(Boolean);
    var total = toks.reduce(function (n, t) { return n + t.length; }, 0) || 1;
    var t = line.start, span = line.end - line.start;
    return toks.map(function (text) {
      var d = span * text.length / total, w = { text: text, start: t, end: t + d };
      t += d;
      return w;
    });
  }

  // Índice de la palabra "activa" (la última que ya empezó) en el instante t.
  function activeIndex(words, t) {
    var k = 0;
    for (var i = 0; i < words.length; i++) if (words[i].start <= t) k = i;
    return k;
  }

  // Parte las palabras en filas según los saltos de línea del texto.
  function rowsOf(line, words) {
    var rows = [], idx = 0;
    line.text.split('\n').forEach(function (rowText) {
      var n = rowText.split(/\s+/).filter(Boolean).length, row = [];
      for (var i = 0; i < n && idx < words.length; i++) row.push(idx++);
      if (row.length) rows.push(row);
    });
    return rows;
  }

  // Dibuja la línea en el instante t. ctx ya viene escalado al tamaño de la secuencia (W x H).
  function draw(ctx, W, H, line, t, style) {
    var s = style;
    var words = lineWords(line), rows = rowsOf(line, words);
    if (!words.length) return;
    var local = t - line.start, remain = line.end - t;
    var active = activeIndex(words, t);
    var wordLocal = t - words[active].start;
    // settled: la entrada ya terminó (se usa para los PNG fijos, que no llevan movimiento)
    if (s.settled) { local = 10; remain = 10; wordLocal = 10; }

    var alpha = 1, scale = 1;
    if (has(s, 'pop') && !s.perWord) {
      scale = 0.6 + 0.4 * easeOutBack(clamp(local / 0.2, 0, 1));
      alpha = clamp(local / 0.08, 0, 1);
    }
    if (has(s, 'fade') && !s.perWord) alpha = Math.min(alpha, clamp(local / 0.15, 0, 1), clamp(remain / 0.12, 0, 1));

    var size = s.size;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = s.weight + ' ' + size + 'px "' + s.font + '", Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    // el contorno ocupa lugar a cada lado de la palabra: se suma al espacio para que no se peguen
    var space = ctx.measureText(' ').width + (s.outline ? s.outlineWidth * 0.7 : 0);
    var rowTexts = rows.map(function (row) {
      return row.map(function (i) { return s.uppercase ? words[i].text.toUpperCase() : words[i].text; });
    });
    var baseW = rowTexts.map(function (texts) {
      return texts.reduce(function (n, x) { return n + ctx.measureText(x).width; }, 0) + space * (texts.length - 1);
    });
    // si la fila más ancha no entra en el cuadro (con margen), se achica todo el texto
    var maxRow = Math.max.apply(null, baseW.concat([1]));
    var fit = Math.min(1, (W * 0.9) / (maxRow * (has(s, 'grow') ? 1.15 : 1) + (s.box ? s.boxPad * 2 : 0)));

    var rowH = size * 1.22;
    var blockH = rows.length * rowH;
    ctx.translate(W * s.hpos / 100, H * s.vpos / 100);
    ctx.scale(scale * fit, scale * fit);

    rows.forEach(function (row, r) {
      var y = -blockH / 2 + rowH * (r + 0.5);
      var texts = rowTexts[r];
      // la palabra que crece empuja a las vecinas en vez de taparlas
      var scales = row.map(function (wi) {
        return has(s, 'grow') && wi === active ? 1 + 0.15 * easeOut(clamp(wordLocal / 0.12, 0, 1)) : 1;
      });
      var widths = texts.map(function (x, k) { return ctx.measureText(x).width * scales[k]; });
      var rowW = widths.reduce(function (a, b) { return a + b; }, 0) + space * (row.length - 1);

      if (s.box) {
        var pad = s.boxPad;
        ctx.save();
        ctx.globalAlpha = alpha * s.boxOpacity;
        ctx.fillStyle = s.boxColor;
        roundRect(ctx, -rowW / 2 - pad, y - rowH / 2 - pad * 0.15, rowW + pad * 2, rowH + pad * 0.3, s.boxRadius);
        ctx.fill();
        ctx.restore();
      }

      var x = -rowW / 2;
      row.forEach(function (wi, k) {
        var isActive = wi === active;
        var color = has(s, 'highlight') && isActive ? s.highlight : s.color;
        // en los PNG fijos (settled) la palabra está completa desde el instante en que empieza: sin la rampa de entrada,
        // si no, el cuadro tomado justo en su inicio la dejaría invisible y el texto iría una palabra atrasado
        var wAlpha = has(s, 'reveal') ? (s.settled ? (t >= words[wi].start - 1e-6 ? 1 : 0) : clamp((t - words[wi].start) / 0.09, 0, 1)) : 1;
        var inScale = 1;
        if (s.perWord) {
          // cada palabra hace su propia entrada cuando empieza a sonar; antes de eso no se ve
          var wl = s.settled ? 10 : t - words[wi].start;
          if (t < words[wi].start) wAlpha = 0;
          if (has(s, 'pop')) { inScale = 0.6 + 0.4 * easeOutBack(clamp(wl / 0.2, 0, 1)); wAlpha *= clamp(wl / 0.08, 0, 1); }
          if (has(s, 'fade')) wAlpha *= clamp(wl / 0.15, 0, 1);
        }

        ctx.save();
        ctx.globalAlpha = alpha * wAlpha;
        ctx.translate(x + widths[k] / 2, y);
        ctx.scale(scales[k] * inScale, scales[k] * inScale);
        if (s.shadow && !s.box) {
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = size * 0.12;
          ctx.shadowOffsetY = size * 0.05;
        }
        ctx.textAlign = 'center';
        if (s.outline && s.outlineWidth > 0) {
          ctx.strokeStyle = s.outlineColor;
          ctx.lineWidth = s.outlineWidth;
          ctx.strokeText(texts[k], 0, 0);
          ctx.shadowColor = 'transparent';
        }
        ctx.fillStyle = color;
        ctx.fillText(texts[k], 0, 0);
        if (has(s, 'underline') && isActive) {
          var uw = widths[k] / scales[k], uh = Math.max(3, size * 0.07);
          ctx.fillStyle = has(s, 'highlight') ? s.highlight : s.color;
          ctx.fillRect(-uw / 2, size * 0.42, uw, uh);
        }
        ctx.restore();
        x += widths[k] + space;
      });
    });
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Clave del estado visual de un cuadro: si dos cuadros seguidos tienen la misma clave, se reusa el PNG.
  function stateKey(line, idx, t, style, fps) {
    if (!line) return 'empty';
    var q = function (v) { return Math.round(v * fps); };
    var words = lineWords(line), a = activeIndex(words, t);
    var parts = [idx, a];
    if (style.perWord) parts.push(words.map(function (w) { return q(clamp(t - w.start, 0, 0.25)); }).join(','));
    else {
      if (has(style, 'pop')) parts.push(q(Math.min(t - line.start, 0.25)));
      if (has(style, 'fade')) parts.push(q(Math.min(t - line.start, 0.2)), q(Math.min(line.end - t, 0.15)));
    }
    if (has(style, 'grow')) parts.push(q(Math.min(t - words[a].start, 0.15)));
    if (has(style, 'reveal')) parts.push(words.map(function (w) { return q(clamp(t - w.start, 0, 0.12)); }).join(','));
    return parts.join('|');
  }

  /* Modo PNG: una imagen fija por "estado" de la línea. Con animación de palabra (resaltar, subrayar, crecer, aparecer)
   * hay un estado por palabra; si no, uno solo. El pop y el fundido no se dibujan: cada estado lleva un "motion" que
   * el panel traduce a keyframes de Escala y Opacidad en Premiere (así los PNG siguen siendo livianos).
   * Con "palabra por palabra" en una línea de varias palabras no hay keyframes: la línea entera rebotaría con cada palabra. */
  function pngStates(line, style, minDur) {
    var s = {}, k;
    for (k in style) s[k] = style[k];
    s.settled = true;
    var wordLevel = ['reveal', 'grow', 'highlight', 'underline'];
    var words = lineWords(line);
    var lineLevel = !style.perWord || words.length < 2;
    s.animations = (style.animations || []).filter(function (a) { return wordLevel.indexOf(a) > -1; });
    if (style.perWord && words.length > 1 && s.animations.indexOf('reveal') < 0) s.animations.push('reveal');
    s.perWord = false;
    var pop = lineLevel && has(style, 'pop'), fade = lineLevel && has(style, 'fade');
    var states;
    if (!s.animations.length || words.length < 2) states = [{ start: line.start, end: line.end, t: line.start }];
    else {
      states = words.map(function (w, i) {
        return { start: i === 0 ? line.start : w.start, end: i + 1 < words.length ? words[i + 1].start : line.end, t: w.start };
      }).filter(function (st) { return st.end - st.start > 0.01; });
    }
    // Un estado muy corto (una palabra que dura un par de cuadros) se pierde al colocarlo en la secuencia: se junta con el vecino.
    // El último estado (todo el texto) nunca se pierde.
    if (minDur) {
      for (var i = 0; i < states.length && states.length > 1;) {
        var st = states[i];
        if (st.end - st.start >= minDur) { i++; continue; }
        if (i === states.length - 1) { st.start = states[i - 1].start; states.splice(i - 1, 1); i = Math.max(0, i - 2); }   // el último se queda y absorbe el tiempo del anterior
        else if (i > 0) { states[i - 1].end = st.end; states.splice(i, 1); }
        else { states[1].start = st.start; states.splice(0, 1); }
      }
      if (states.length === 1 && states[0].end - states[0].start < minDur) states[0].end = states[0].start + minDur;
    }
    states.forEach(function (st, i) {
      st.motion = { pop: pop && i === 0, fadeIn: fade && i === 0, fadeOut: fade && i === states.length - 1 };
    });
    return { style: s, states: states };
  }

  // Dibuja un único cuadro y lo devuelve como PNG.
  var stillCanvas = null;
  async function renderStill(W, H, line, t, style) {
    if (!stillCanvas) stillCanvas = document.createElement('canvas');
    stillCanvas.width = W; stillCanvas.height = H;
    var ctx = stillCanvas.getContext('2d');
    try { await document.fonts.load(style.weight + ' ' + style.size + 'px "' + style.font + '"'); } catch (e) {}
    draw(ctx, W, H, line, t, style);
    return Buffer.from(stillCanvas.toDataURL('image/png').split(',')[1], 'base64');
  }

  /* Igual que renderStill pero recortado al texto: el PNG pesa menos y, al escalar en Premiere desde el centro de la imagen,
   * el pop crece desde el centro del texto. Devuelve { buf, cx, cy, w, h } con el centro en píxeles del cuadro. */
  async function renderStillCropped(W, H, line, t, style) {
    if (!stillCanvas) stillCanvas = document.createElement('canvas');
    stillCanvas.width = W; stillCanvas.height = H;
    var ctx = stillCanvas.getContext('2d');
    try { await document.fonts.load(style.weight + ' ' + style.size + 'px "' + style.font + '"'); } catch (e) {}
    draw(ctx, W, H, line, t, style);
    var data = ctx.getImageData(0, 0, W, H).data, x0 = W, x1 = -1, y0 = H, y1 = -1, x, y, row;
    for (y = 0; y < H; y++) {
      row = y * W * 4;
      for (x = 0; x < W; x++) {
        if (data[row + x * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
    // margen y tamaño par (algunos importadores se quejan de medidas impares)
    var pad = 2;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    var w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w % 2 && x1 < W - 1) { x1++; w++; } else if (w % 2 && x0 > 0) { x0--; w++; }
    if (h % 2 && y1 < H - 1) { y1++; h++; } else if (h % 2 && y0 > 0) { y0--; h++; }
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(stillCanvas, x0, y0, w, h, 0, 0, w, h);
    return { buf: Buffer.from(out.toDataURL('image/png').split(',')[1], 'base64'), cx: x0 + w / 2, cy: y0 + h / 2, w: w, h: h };
  }

  var dataUrlToBuffer = function (url) { return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'); };

  /* Recorre el tiempo cuadro por cuadro y entrega un PNG por cuadro a write(buffer).
   * opts: { lines, W, H, fps, duration, offset, style, write: async (Buffer) => void, onProgress(0..1), isCancelled() }
   * offset: instante de la línea de tiempo en el que arranca el cuadro 0 (para renderizar una línea sola). */
  async function renderOverlay(opts) {
    var W = opts.W, H = opts.H, fps = opts.fps, lines = opts.lines, style = opts.style, offset = opts.offset || 0;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    try { await document.fonts.load(style.weight + ' ' + style.size + 'px "' + style.font + '"'); } catch (e) {}
    var total = Math.max(1, Math.ceil(opts.duration * fps)), prevKey = null, prevBuf = null, pointer = 0, unique = 0;
    for (var f = 0; f < total; f++) {
      var t = offset + f / fps;
      while (pointer < lines.length && lines[pointer].end <= t) pointer++;
      var idx = pointer < lines.length && lines[pointer].start <= t ? pointer : -1;
      var line = idx >= 0 ? lines[idx] : null;
      var key = stateKey(line, idx, t, style, fps);
      if (key !== prevKey) {
        ctx.clearRect(0, 0, W, H);
        if (line) draw(ctx, W, H, line, t, style);
        prevBuf = dataUrlToBuffer(canvas.toDataURL('image/png'));
        prevKey = key;
        unique++;
      }
      await opts.write(prevBuf);
      if (f % 15 === 0) {
        if (opts.onProgress) opts.onProgress(f / total);
        if (opts.isCancelled && opts.isCancelled()) throw new Error('Render cancelado.');
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }
    if (opts.onProgress) opts.onProgress(1);
    return { frames: total, uniqueFrames: unique };
  }

  root.AlchemyRender = { ANIMATIONS: ANIMATIONS, DEFAULT_STYLE: DEFAULT_STYLE, draw: draw, lineWords: lineWords, stateKey: stateKey, renderOverlay: renderOverlay, pngStates: pngStates, renderStill: renderStill, renderStillCropped: renderStillCropped };
})(window);
