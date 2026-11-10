/* AlchemyCut — selectores propios de color y de fuente.
 * El selector de color nativo (<input type="color">) no abre dentro de los paneles de Premiere,
 * y un <datalist> solo muestra las fuentes que coinciden con lo escrito. Por eso van los dos a mano. */
window.AlchemyPickers = (function () {
  'use strict';

  // ---------- color ----------
  var SWATCHES = ['#ffffff', '#000000', '#ffd400', '#ff3d71', '#00e676', '#2d8ceb', '#ff6d00', '#9c27b0', '#00e5ff', '#ff1744', '#808080', '#f5e6c8'];
  var valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  function norm(v) {
    v = String(v || '').trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(v)) v = v.replace(/(.)/g, '$1$1');
    return /^[0-9a-f]{6}$/.test(v) ? '#' + v : null;
  }
  function toRgb(hex) { var n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function toHex(r, g, b) { return '#' + [r, g, b].map(function (c) { return ('0' + Math.round(c).toString(16)).slice(-2); }).join(''); }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, mx ? d / mx : 0, mx];
  }
  function hsvToRgb(h, s, v) {
    var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  var pop = null, target = null, hsv = [0, 1, 1];

  // ---------- cuentagotas ----------
  // El EyeDropper del navegador no funciona dentro de CEP (se cancela solo), así que se saca una foto de la pantalla
  // y se elige el color de esa foto. Sirve para cualquier cosa que se vea: el monitor de programa, un logo, otra app.
  var DROPPER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.7 5.3a2.4 2.4 0 0 0-3.4 0l-2.6 2.6-1-1-1.4 1.4 1 1-7.6 7.6V19h2.1l7.6-7.6 1 1 1.4-1.4-1-1 2.6-2.6a2.4 2.4 0 0 0 0-3.4z"/></svg>';
  var ZOOM_MAX = 48;

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'actoast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 6000);
  }

  // Fotos de todas las pantallas (una por monitor). Devuelve las URLs de imagen.
  function captureScreens(cb) {
    var req = window.require || (window.cep_node && window.cep_node.require);
    if (!req) return cb(new Error('Esto solo funciona dentro de Premiere.'));
    var cp = req('child_process'), os = req('os'), path = req('path'), fs = req('fs');
    var stamp = Date.now(), files = [];
    for (var i = 0; i < 4; i++) files.push(path.join(os.tmpdir(), 'ac_screen_' + stamp + '_' + i + '.png'));
    var finish = function (err) {
      var urls = [];
      files.forEach(function (f) {
        try {
          if (fs.existsSync(f) && fs.statSync(f).size > 0) urls.push(URL.createObjectURL(new Blob([fs.readFileSync(f)], { type: 'image/png' })));
        } catch (e) {}
        try { fs.unlinkSync(f); } catch (e) {}
      });
      if (!urls.length) return cb(err || new Error('No se pudo sacar la foto de la pantalla.'));
      cb(null, urls);
    };
    var plat = os.platform();
    if (plat === 'darwin') {
      cp.execFile('/usr/sbin/screencapture', ['-x', '-t', 'png'].concat(files), { timeout: 15000 }, function (err) { finish(err); });
    } else if (plat === 'win32') {
      var ps = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;' +
        '$i=0; foreach($s in [System.Windows.Forms.Screen]::AllScreens){ if($i -ge 4){break};' +
        '$b=$s.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp);' +
        '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $g.Dispose();' +
        '$bmp.Save(("' + files[0].replace(/_0\.png$/, '') + '_" + $i + ".png"),[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $i++ }';
      cp.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 20000, windowsHide: true }, function (err) { finish(err); });
    } else {
      cb(new Error('El cuentagotas todavía no está disponible en este sistema.'));
    }
  }

  var frameProvider = null;     // main.js entrega el fotograma del video que se ve en la vista previa
  function pickFromScreen(input) {
    if (document.querySelector('.acshot')) return;
    var frame = null;
    try { frame = frameProvider && frameProvider(); } catch (e) {}
    captureScreens(function (err, urls) {
      var sources = [];
      if (frame) sources.push({ url: frame, label: 'Fotograma del video' });
      (urls || []).forEach(function (u, i) { sources.push({ url: u, label: 'Pantalla ' + (i + 1), screen: true }); });
      if (!sources.length) { toast('Cuentagotas: ' + ((err && err.message) || err || 'no se pudo sacar la foto de la pantalla.')); return; }
      openShot(sources, function (hex) {
        input.value = hex;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  function openShot(sources, onPick) {
    var urls = sources.map(function (x) { return x.url; });
    var ov = document.createElement('div');
    ov.className = 'acshot';
    ov.innerHTML =
      '<div class="bar"><span class="msg">Clic: elegir color · rueda: zoom · arrastrar: mover · Esc: cancelar</span>' +
      '<button type="button" class="zo" title="Alejar">−</button><button type="button" class="zi" title="Acercar">+</button>' +
      '<button type="button" class="fit" title="Ver todo">Ver todo</button>' +
      (sources.length > 1 ? '<button type="button" class="nx"></button>' : '') +
      '<button type="button" class="cx">Cancelar</button></div>' +
      '<canvas class="view"></canvas>' +
      '<div class="chip" hidden><canvas width="99" height="99"></canvas><div class="sw"></div><b></b></div>' +
      '<div class="note"></div>';
    document.body.appendChild(ov);

    var cv = ov.querySelector('canvas.view'), ctx = cv.getContext('2d');
    var chip = ov.querySelector('.chip'), lp = chip.querySelector('canvas'), lctx = lp.getContext('2d');
    var off = document.createElement('canvas'), octx = off.getContext('2d');
    var img = new Image(), cur = 0, s = 1, ox = 0, oy = 0, minS = 0.05, mouse = null, drag = null;

    function size() { cv.width = cv.clientWidth; cv.height = cv.clientHeight; }
    function fit() {
      minS = Math.min(cv.width / img.naturalWidth, cv.height / img.naturalHeight);
      s = minS; ox = (cv.width - img.naturalWidth * s) / 2; oy = (cv.height - img.naturalHeight * s) / 2;
    }
    function clampView() {
      var w = img.naturalWidth * s, h = img.naturalHeight * s;
      ox = w <= cv.width ? (cv.width - w) / 2 : Math.min(0, Math.max(cv.width - w, ox));
      oy = h <= cv.height ? (cv.height - h) / 2 : Math.min(0, Math.max(cv.height - h, oy));
    }
    function draw() {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = s < 1;
      ctx.drawImage(img, ox, oy, img.naturalWidth * s, img.naturalHeight * s);
      if (mouse) look(mouse.x, mouse.y);
    }
    function zoomAt(f, mx, my) {
      var ns = Math.min(ZOOM_MAX, Math.max(minS, s * f));
      ox = mx - (mx - ox) * ns / s; oy = my - (my - oy) * ns / s; s = ns; clampView(); draw();
    }
    function pixelAt(mx, my) {
      var x = Math.floor((mx - ox) / s), y = Math.floor((my - oy) / s);
      if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return null;
      var d = octx.getImageData(x, y, 1, 1).data;
      return { x: x, y: y, hex: toHex(d[0], d[1], d[2]) };
    }
    function look(mx, my) {
      var p = pixelAt(mx, my);
      if (!p) { chip.hidden = true; return; }
      chip.hidden = false;
      lctx.imageSmoothingEnabled = false; lctx.fillStyle = '#000'; lctx.fillRect(0, 0, 99, 99);
      lctx.drawImage(off, p.x - 5, p.y - 5, 11, 11, 0, 0, 99, 99);
      lctx.lineWidth = 1; lctx.strokeStyle = '#fff'; lctx.strokeRect(36.5, 36.5, 27, 27);
      lctx.strokeStyle = '#000'; lctx.strokeRect(35.5, 35.5, 29, 29);
      chip.querySelector('.sw').style.background = p.hex;
      chip.querySelector('b').textContent = p.hex;
      var r = cv.getBoundingClientRect(), cw = chip.offsetWidth, ch = chip.offsetHeight;
      var left = r.left + mx + 18, top = r.top + my + 18;
      if (left + cw > window.innerWidth - 4) left = r.left + mx - cw - 18;
      if (top + ch > window.innerHeight - 4) top = r.top + my - ch - 18;
      chip.style.left = Math.max(4, left) + 'px'; chip.style.top = Math.max(4, top) + 'px';
    }
    function load(i) {
      cur = i; img = new Image();
      img.onload = function () {
        off.width = img.naturalWidth; off.height = img.naturalHeight;
        octx.drawImage(img, 0, 0);
        size(); fit(); draw();
      };
      img.src = urls[i];
      var nb = ov.querySelector('.nx');
      if (nb) nb.textContent = sources[i].label + ' (' + (i + 1) + '/' + sources.length + ') ▸';
      ov.querySelector('.note').textContent = sources[i].screen
        ? 'Si solo ves el fondo de escritorio: en el Mac, dale permiso de “Grabación de pantalla” a Premiere Pro (Ajustes del Sistema › Privacidad y seguridad) y reabrí Premiere. Mientras tanto usá “Fotograma del video”.'
        : 'Es el fotograma del video, sin efectos de color de Premiere.';
    }
    function close() {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      urls.forEach(function (u) { if (u.indexOf('blob:') === 0) URL.revokeObjectURL(u); });
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === '+' || e.key === '=') zoomAt(1.4, cv.width / 2, cv.height / 2);
      else if (e.key === '-') zoomAt(1 / 1.4, cv.width / 2, cv.height / 2);
    }
    function onResize() { if (img.naturalWidth) { size(); fit(); draw(); } }
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);

    function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    cv.addEventListener('mousemove', function (e) {
      mouse = pos(e);
      if (drag) {
        if (Math.abs(e.clientX - drag.cx) + Math.abs(e.clientY - drag.cy) > 4) drag.moved = true;
        if (drag.moved) { ox = drag.ox + (e.clientX - drag.cx); oy = drag.oy + (e.clientY - drag.cy); clampView(); draw(); return; }
      }
      look(mouse.x, mouse.y);
    });
    cv.addEventListener('mouseleave', function () { mouse = null; chip.hidden = true; });
    cv.addEventListener('mousedown', function (e) { e.preventDefault(); drag = { cx: e.clientX, cy: e.clientY, ox: ox, oy: oy, moved: false }; });
    function onUp(e) {
      var d = drag; drag = null;
      if (!d || d.moved || !ov.parentNode) return;
      var p = pixelAt(pos(e).x, pos(e).y);
      if (p) { close(); onPick(p.hex); }
    }
    document.addEventListener('mouseup', onUp);
    cv.addEventListener('wheel', function (e) { e.preventDefault(); var p = pos(e); zoomAt(e.deltaY < 0 ? 1.25 : 1 / 1.25, p.x, p.y); }, { passive: false });
    ov.querySelector('.zi').addEventListener('click', function () { zoomAt(1.5, cv.width / 2, cv.height / 2); });
    ov.querySelector('.zo').addEventListener('click', function () { zoomAt(1 / 1.5, cv.width / 2, cv.height / 2); });
    ov.querySelector('.fit').addEventListener('click', function () { fit(); draw(); });
    ov.querySelector('.cx').addEventListener('click', close);
    var nx = ov.querySelector('.nx'); if (nx) nx.addEventListener('click', function () { load((cur + 1) % urls.length); });
    load(0);
  }

  function buildPopup() {
    pop = document.createElement('div');
    pop.className = 'colorpop';
    pop.hidden = true;
    pop.innerHTML =
      '<canvas class="sv" width="200" height="130"></canvas>' +
      '<input class="hue" type="range" min="0" max="360" value="0" data-pk="1">' +
      '<div class="swatches"></div>' +
      '<input class="hexin" type="text" maxlength="7" spellcheck="false" data-pk="1">';
    document.body.appendChild(pop);
    var sw = pop.querySelector('.swatches');
    SWATCHES.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.style.background = c; b.title = c;
      b.addEventListener('click', function () { setFromHex(c); });
      sw.appendChild(b);
    });
    var cv = pop.querySelector('.sv');
    var drag = function (e) {
      var r = cv.getBoundingClientRect();
      hsv[1] = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      hsv[2] = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      commit();
    };
    cv.addEventListener('mousedown', function (e) {
      e.preventDefault(); drag(e);
      var move = function (ev) { drag(ev); };
      var up = function () { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    pop.querySelector('.hue').addEventListener('input', function () { hsv[0] = +this.value; commit(); });
    pop.querySelector('.hexin').addEventListener('input', function () { var n = /^#?[0-9a-fA-F]{6}$/.test(this.value.trim()) ? norm(this.value) : null; if (n) setFromHex(n, true); });
    document.addEventListener('mousedown', function (e) {
      if (!pop.hidden && !pop.contains(e.target) && !(e.target.closest && e.target.closest('.colorfield'))) close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  function paintSV() {
    var cv = pop.querySelector('.sv'), g = cv.getContext('2d'), w = cv.width, h = cv.height;
    var base = hsvToRgb(hsv[0], 1, 1);
    var gx = g.createLinearGradient(0, 0, w, 0);
    gx.addColorStop(0, '#fff'); gx.addColorStop(1, toHex(base[0], base[1], base[2]));
    g.fillStyle = gx; g.fillRect(0, 0, w, h);
    var gy = g.createLinearGradient(0, 0, 0, h);
    gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, '#000');
    g.fillStyle = gy; g.fillRect(0, 0, w, h);
    var x = hsv[1] * w, y = (1 - hsv[2]) * h;
    g.lineWidth = 2; g.strokeStyle = '#fff'; g.beginPath(); g.arc(x, y, 6, 0, 7); g.stroke();
    g.lineWidth = 1; g.strokeStyle = '#000'; g.beginPath(); g.arc(x, y, 7.5, 0, 7); g.stroke();
  }
  function emit() { if (target) target.dispatchEvent(new Event('input', { bubbles: true })); }
  function commit() {
    var c = hsvToRgb(hsv[0], hsv[1], hsv[2]), hex = toHex(c[0], c[1], c[2]);
    target.value = hex;
    pop.querySelector('.hexin').value = hex;
    paintSV(); emit();
  }
  function setFromHex(hex, fromTyping) {
    var c = toRgb(hex); hsv = rgbToHsv(c[0], c[1], c[2]);
    // en gris/negro/blanco el matiz queda indefinido: se conserva el que había en el control
    if (!hsv[1]) hsv[0] = +pop.querySelector('.hue').value;
    pop.querySelector('.hue').value = Math.round(hsv[0]);
    if (!fromTyping) pop.querySelector('.hexin').value = hex;
    target.value = hex; paintSV(); emit();
  }
  function open(input, anchor) {
    if (!pop) buildPopup();
    target = input;
    var hex = norm(input.value) || '#ffffff', c = toRgb(hex);
    hsv = rgbToHsv(c[0], c[1], c[2]);
    pop.querySelector('.hue').value = Math.round(hsv[0]);
    pop.querySelector('.hexin').value = hex;
    pop.hidden = false;
    var r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.max(4, Math.min(window.innerWidth - pw - 4, r.left));
    var top = r.bottom + 4;
    if (top + ph > window.innerHeight && r.top - ph - 4 > 0) top = r.top - ph - 4;
    pop.style.left = left + 'px';
    pop.style.top = (top + window.scrollY) + 'px';
    paintSV();
  }
  function close() { if (pop) pop.hidden = true; target = null; }

  function enhanceColor(input) {
    var wrap = document.createElement('span');
    wrap.className = 'colorfield';
    var sw = document.createElement('button');
    sw.type = 'button'; sw.className = 'swatch'; sw.title = 'Elegir color';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(sw); wrap.appendChild(input);
    input.type = 'text'; input.maxLength = 7; input.spellcheck = false;
    var dp = document.createElement('button');
    dp.type = 'button'; dp.className = 'dropper'; dp.title = 'Cuentagotas: tomar un color de la pantalla';
    dp.innerHTML = DROPPER_SVG;
    wrap.appendChild(dp);
    dp.addEventListener('click', function (e) { e.preventDefault(); close(); pickFromScreen(input); });

    var last = norm(input.value) || '#ffffff';
    var refresh = function () { var n = norm(valueDesc.get.call(input)); if (n) last = n; sw.style.background = last; };
    // los presets asignan .value por código: el cuadrito de color tiene que enterarse
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: function () { return valueDesc.get.call(input); },
      set: function (v) { valueDesc.set.call(input, v); refresh(); }
    });
    input.addEventListener('input', function () {
      refresh();
      var n = norm(input.value);
      if (n && target === input && pop) { setFromHexQuiet(n); }
    });
    input.addEventListener('change', function () {
      var n = norm(input.value);
      input.value = n || last;       // si lo escrito no es un color, vuelve al último válido
      if (n) input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    sw.addEventListener('click', function (e) {
      e.preventDefault();
      if (pop && !pop.hidden && target === input) close(); else open(input, sw);
    });
    refresh();
  }
  function setFromHexQuiet(hex) {
    var c = toRgb(hex); hsv = rgbToHsv(c[0], c[1], c[2]);
    if (!hsv[1]) hsv[0] = +pop.querySelector('.hue').value;
    pop.querySelector('.hue').value = Math.round(hsv[0]);
    var hi = pop.querySelector('.hexin'); if (document.activeElement !== hi) hi.value = hex;
    paintSV();
  }

  // ---------- fuente ----------
  var fonts = [], list = null, fontInput = null, shown = [], sel = -1, typed = false;

  function enhanceFont(input) {
    var wrap = document.createElement('div');
    wrap.className = 'combo';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    list = document.createElement('div');
    list.className = 'combo-list';
    list.hidden = true;
    wrap.appendChild(list);
    fontInput = input;
    // flechita para desplegar toda la lista (sin tener que escribir)
    var arrow = document.createElement('button');
    arrow.type = 'button'; arrow.className = 'arrow'; arrow.textContent = '▾'; arrow.title = 'Ver todas las fuentes';
    wrap.appendChild(arrow);
    arrow.addEventListener('mousedown', function (e) {
      e.preventDefault();                       // sin esto el campo pierde el foco y la lista se cierra antes de abrir
      if (!list.hidden) { list.hidden = true; input.blur(); return; }
      typed = false; render(); list.hidden = false; input.focus(); scrollToCurrent();
    });
    input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = 'Buscar fuente…';

    input.addEventListener('focus', function () { typed = false; input.select(); render(); list.hidden = false; scrollToCurrent(); });
    input.addEventListener('input', function () { typed = true; sel = -1; render(); list.hidden = false; });
    input.addEventListener('blur', function () { list.hidden = true; });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); list.hidden = false;
        sel = Math.max(0, Math.min(shown.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
        mark();
      } else if (e.key === 'Enter' && sel > -1 && shown[sel]) { e.preventDefault(); choose(shown[sel]); }
      else if (e.key === 'Escape') { list.hidden = true; input.blur(); }
    });
    // mousedown (no click) y sin quitarle el foco al campo, si no el blur cierra la lista antes de elegir
    list.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var it = e.target.closest ? e.target.closest('.fitem') : null;
      if (it) choose(it.getAttribute('data-f'));
    });
  }
  function choose(name) {
    fontInput.value = name;
    fontInput.dispatchEvent(new Event('input', { bubbles: true }));
    typed = false; list.hidden = true; fontInput.blur();
  }
  function render() {
    var q = typed ? fontInput.value.trim().toLowerCase() : '';
    shown = fonts.filter(function (f) { return !q || f.toLowerCase().indexOf(q) > -1; });
    if (q) shown.sort(function (a, b) { return (a.toLowerCase().indexOf(q) !== 0) - (b.toLowerCase().indexOf(q) !== 0); });
    list.innerHTML = '';
    if (!shown.length) { var n = document.createElement('div'); n.className = 'fnone'; n.textContent = fonts.length ? 'Ninguna fuente coincide' : 'Cargando fuentes…'; list.appendChild(n); return; }
    var frag = document.createDocumentFragment();
    shown.forEach(function (f) {
      var d = document.createElement('div');
      d.className = 'fitem'; d.setAttribute('data-f', f); d.textContent = f;
      d.style.fontFamily = '"' + f.replace(/"/g, '') + '", sans-serif';
      if (f === fontInput.value) d.classList.add('cur');
      frag.appendChild(d);
    });
    list.appendChild(frag);
  }
  function mark() {
    var items = list.querySelectorAll('.fitem');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('sel', i === sel);
    if (items[sel]) items[sel].scrollIntoView({ block: 'nearest' });
  }
  function scrollToCurrent() { var c = list.querySelector('.cur'); if (c) list.scrollTop = Math.max(0, c.offsetTop - 60); }

  function setFonts(arr) {
    fonts = (arr || []).filter(Boolean).filter(function (f, i, a) { return a.indexOf(f) === i; }).sort(function (a, b) { return a.localeCompare(b); });
    if (list && !list.hidden) render();
  }

  // ---------- sliders con casilla numérica ----------
  // Límites de lo que se puede escribir a mano (el slider se estira solo si el valor se pasa de su recorrido).
  var ABS = {
    size: [8, 500], weight: [100, 900], outlineW: [0, 100], maxChars: [4, 200], maxWords: [0, 30], offset: [-3000, 3000],
    noiseDb: [-100, 0], minSilence: [0.05, 10], pad: [0, 2], quietLevel: [-100, 0], quietMin: [0.1, 30], repeatWords: [2, 30], repeatGap: [1, 300]
  };
  function enhanceRange(r) {
    if (r.getAttribute('data-pk') || r.parentNode.className === 'rng') return;
    var omin = +r.min, omax = +r.max, lim = ABS[r.id] || [omin, omax];
    var stepStr = r.getAttribute('step') || '1';
    var dec = (stepStr.split('.')[1] || '').length;
    var rd = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    var wrap = document.createElement('div');
    wrap.className = 'rng';
    if (r.parentNode.tagName === 'LABEL') r.parentNode.classList.add('hasrng');
    r.parentNode.insertBefore(wrap, r);
    wrap.appendChild(r);
    var num = document.createElement('input');
    num.type = 'number'; num.className = 'numbox'; num.min = lim[0]; num.max = lim[1]; num.step = stepStr; num.title = 'Escribí el valor a mano';
    wrap.appendChild(num);

    var show = function () { num.value = (+rd.get.call(r)).toFixed(dec); };
    var stretch = function (v) { r.min = Math.min(omin, v); r.max = Math.max(omax, v); };
    // los presets y el guardado asignan .value por código: el slider se estira y la casilla se entera
    Object.defineProperty(r, 'value', {
      configurable: true,
      get: function () { return rd.get.call(r); },
      set: function (v) { var n = parseFloat(v); if (isFinite(n)) stretch(n); rd.set.call(r, v); show(); }
    });
    r.addEventListener('input', show);
    var clamp = function (v) { return Math.min(lim[1], Math.max(lim[0], v)); };
    num.addEventListener('input', function () {
      var v = parseFloat(num.value);
      if (!isFinite(v) || v < lim[0] || v > lim[1]) return;      // a mitad de escribir ("1" camino a "140") no se aplica
      stretch(v); rd.set.call(r, String(v));
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    num.addEventListener('change', function () {
      var v = parseFloat(num.value);
      if (!isFinite(v)) { show(); return; }
      v = clamp(v); stretch(v); rd.set.call(r, String(v)); show();
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    show();
  }
  // los sliders ya están en la página cuando carga este script: se arman antes que main.js restaure los valores guardados
  Array.prototype.forEach.call(document.querySelectorAll('input[type=range]'), enhanceRange);

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('input.hex'), enhanceColor);
    var f = document.querySelector('input.fontpick');
    if (f) enhanceFont(f);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return { setFonts: setFonts, setFrameProvider: function (fn) { frameProvider = fn; } };
})();
