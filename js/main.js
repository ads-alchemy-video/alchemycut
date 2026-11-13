/* AlchemyCut — panel CEP. Habla con Premiere (jsx/host.jsx) y con el motor (engine/lib.js). */
(function () {
  'use strict';
  var nodeRequire = window.require || (window.cep_node && window.cep_node.require);
  var cep = window.__adobe_cep__;
  var $ = function (id) { return document.getElementById(id); };

  var extPath = cep ? decodeURI(cep.getSystemPath('extension')).replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1') : '';   // en Windows queda C:/…, no /C:/…
  var engine = nodeRequire && extPath ? nodeRequire(extPath + '/engine/lib.js') : null;
  var fs = nodeRequire ? nodeRequire('fs') : null;
  var path = nodeRequire ? nodeRequire('path') : null;
  var os = nodeRequire ? nodeRequire('os') : null;

  var R = window.AlchemyRender;
  var state = { clip: null, clips: [], mode: 'cuts', timeline: [], result: null, lines: [], active: 0, frameDir: null, bg: null, playing: 0, vpos: 78, hpos: 50, scopeSel: false, globalSp: null, wv: 78, wh: 50, lastPick: -1 };

  // Controles de estilo (se guardan y forman parte de los presets) y de líneas (rearman los captions).
  var STYLE_VALUES = ['font', 'size', 'weight', 'outlineW', 'color', 'highlight', 'outlineColor', 'boxColor'];
  var STYLE_CHECKS = ['outline', 'box', 'shadow', 'uppercase', 'perWord'];
  var LINE_VALUES = ['maxChars', 'maxWords', 'maxLines', 'punctList', 'offset'];
  var LINE_CHECKS = ['extend', 'stripPunct', 'oneWord'];  // oneWord vive en la pestaña Animación
  var ANIM_IDS = R.ANIMATIONS.map(function (a) { return a.id; });
  var animBox = function (id) { return $('anim_' + id); };

  // ruta del disco -> URL file:// (en Windows: C:\\x\\y.jpg -> file:///C:/x/y.jpg)
  function fileUrl(p) { p = String(p).replace(/\\/g, '/'); return 'file://' + encodeURI(p.charAt(0) === '/' ? p : '/' + p); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem('ac_' + k); localStorage.setItem('ac_' + k, v); } catch (e) {} return null; }
  function status(msg, isErr) { var el = $('status'); el.textContent = msg || ''; el.className = 'hint' + (isErr ? ' error' : ''); }
  function host(fn, arg) {
    return new Promise(function (resolve, reject) {
      var call = 'ac_' + fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
      cep.evalScript(call, function (raw) {
        var r;
        try { r = JSON.parse(raw); } catch (e) { return reject(new Error('Premiere respondió algo inesperado: ' + raw)); }
        r.ok ? resolve(r.data) : reject(new Error(r.error));
      });
    });
  }
  var fmt = function (s) { return s.toFixed(2) + ' s'; };
  var clock = function (s) { var m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
  // Nombres de archivo solo con letras ASCII: Premiere no reconoce bien los nombres con tildes al importar.
  var safe = function (name) { return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'clip'; };

  // Casillas de animación
  R.ANIMATIONS.forEach(function (a) {
    var lab = document.createElement('label');
    lab.className = 'animchip';
    lab.title = a.desc;
    lab.innerHTML = '<input type="checkbox" id="anim_' + a.id + '"><span class="box"><canvas class="demo" width="440" height="110" data-id="' + a.id + '"></canvas><b>' + a.label + '</b><small>' + a.desc + '</small></span>';
    $('animList').appendChild(lab);
  });
  animBox('pop').checked = true; animBox('highlight').checked = true;

  // Controles guardados entre sesiones
  ['noiseDb', 'minSilence', 'pad', 'quietLevel', 'quietMin', 'premierePeak', 'repeatWords', 'repeatGap', 'language', 'provider', 'model', 'subScope', 'capType', 'outFormat', 'cutMethod', 'keepEnd', 'keepComma', 'keepWord', 'minGap', 'takeMin'].concat(STYLE_VALUES, LINE_VALUES).forEach(function (id) { var v = store(id); if (v !== null) $(id).value = v; });
  ['fillers', 'autoThresh', 'quietVoices', 'repeats', 'useTakes', 'cutOffScript'].concat(STYLE_CHECKS, LINE_CHECKS).forEach(function (id) { var v = store(id); if (v !== null) $(id).checked = v === '1'; });
  ANIM_IDS.forEach(function (id) { var v = store('anim_' + id); if (v !== null) animBox(id).checked = v === '1'; });
  ['vpos', 'hpos'].forEach(function (k) { var v = store(k); if (v !== null) state[k] = +v; });
  // Una key guardada por proveedor, así cambiar de uno a otro no pisa la otra.
  function loadKey() { $('apiKey').value = store('apiKey_' + $('provider').value) || ''; }
  loadKey();

  // Marca en el desplegable qué modelos locales ya están descargados.
  function markModels() {
    if (!fs || !os || !path) return;
    Array.prototype.forEach.call($('model').options, function (o) {
      if (!o.getAttribute('data-t')) o.setAttribute('data-t', o.textContent);
      var f = path.join(os.homedir(), '.alchemycut', 'models', 'ggml-' + o.value + '.bin');
      var have = false;
      try { have = fs.existsSync(f); } catch (e) {}
      o.textContent = o.getAttribute('data-t') + (have ? '' : ' — no descargado');
    });
  }
  markModels();

  // ---- Componentes (ffmpeg, Whisper local, modelo) ----
  var STEP_NAMES = { ffmpeg: 'ffmpeg', whisper: 'Whisper', model: 'el modelo de Whisper' };
  function setupNeeds() {
    if (!engine || !engine.setup) return null;
    var st = engine.setup.status($('model').value), local = $('provider').value === 'local', need = [];
    if (!st.ffmpeg) need.push('ffmpeg');
    if (local && !st.whisper) need.push('whisper');
    if (local && !st.model) need.push('model');
    return { st: st, need: need, inst: need.filter(function (n) { return st.installable.indexOf(n) > -1; }), manual: need.filter(function (n) { return st.installable.indexOf(n) < 0; }) };
  }
  function refreshSetup() {
    var card = $('setupCard'), n = setupNeeds();
    if (!n || !n.need.length) { card.hidden = true; return; }
    card.hidden = false;
    $('setupTitle').textContent = 'Falta instalar: ' + n.need.map(function (x) { return STEP_NAMES[x]; }).join(', ');
    var msg = [];
    if (n.inst.length) msg.push('Se baja una sola vez (≈ ' + engine.setup.sizeMB(n.inst, $('model').value) + ' MB) a tu carpeta de usuario; no hace falta ser administrador.');
    if (n.manual.length) msg.push('No se puede instalar desde acá: ' + n.manual.map(function (x) { return STEP_NAMES[x]; }).join(' y ') + '. Instalalo a mano (Mac: brew install ffmpeg whisper-cpp).');
    $('setupMsg').textContent = msg.join(' ');
    $('btnSetup').hidden = !n.inst.length;
    $('btnSetup').textContent = 'Instalar ahora (≈ ' + engine.setup.sizeMB(n.inst, $('model').value) + ' MB)';
  }
  // mensaje corto si falta algo para lo que se está por hacer ('' si está todo)
  function setupProblem(needLocal) {
    var n = setupNeeds();
    if (!n) return '';
    var miss = n.need.filter(function (x) { return x === 'ffmpeg' || needLocal; });
    if (!miss.length) return '';
    refreshSetup();
    return 'Falta ' + miss.map(function (x) { return STEP_NAMES[x]; }).join(', ') + '. ' + (n.manual.length ? 'Mirá el aviso de arriba.' : 'Apretá “Instalar ahora” en el aviso de arriba.');
  }
  $('btnSetup').onclick = function () {
    var n = setupNeeds();
    if (!n || !n.inst.length) return;
    var btn = $('btnSetup'), mb = function (b) { return (b / 1048576).toFixed(0); };
    btn.disabled = true; $('setupBar').hidden = false; $('setupBar').removeAttribute('value');
    status('Instalando… no cierres Premiere hasta que termine.');
    engine.setup.install({
      model: $('model').value, steps: n.inst,
      onProgress: function (p) {
        $('setupProg').textContent = p.label + (p.pct !== null ? ' · ' + p.pct + '% (' + mb(p.got) + ' de ' + mb(p.total) + ' MB)' : '');
        if (p.pct !== null) $('setupBar').value = p.pct; else $('setupBar').removeAttribute('value');
      }
    }).then(function () {
      $('setupProg').textContent = '';
      status('Listo, ya está instalado.');
    }).catch(function (e) {
      $('setupProg').textContent = 'No se pudo instalar: ' + (e && e.message || e);
      status('No se pudo instalar: ' + (e && e.message || e), true);
    }).then(function () { btn.disabled = false; $('setupBar').hidden = true; markModels(); refreshSetup(); });
  };

  function labels() {
    $('dbVal').textContent = $('noiseDb').value; $('minVal').textContent = $('minSilence').value; $('padVal').textContent = (+$('pad').value).toFixed(2);
    $('thrRow').style.opacity = $('autoThresh').checked ? 0.45 : 1; $('noiseDb').disabled = $('autoThresh').checked;
    $('quietVal').textContent = $('quietLevel').value; $('quietMinVal').textContent = (+$('quietMin').value).toFixed(1); $('quietRow').hidden = !$('quietVoices').checked;
    $('repWordsVal').textContent = $('repeatWords').value; $('repGapVal').textContent = $('repeatGap').value; $('repeatRow').hidden = !$('repeats').checked;
    $('charsVal').textContent = $('maxChars').value;
    $('offsetVal').textContent = (+$('offset').value > 0 ? '+' : '') + $('offset').value + ' ms';
    $('wordsVal').textContent = +$('maxWords').value === 0 ? 'sin límite' : $('maxWords').value;
    $('sizeVal').textContent = $('size').value; $('weightVal').textContent = $('weight').value; $('outlineWVal').textContent = $('outlineW').value;
    $('audioTrackRow').hidden = $('subScope').value === 'selected';
    $('scopeHint').textContent = { selected: 'Seleccioná en la secuencia los clips con la voz (sirven varios pedazos ya cortados).',
      sequence: 'Transcribe todo lo que hay en la pista de audio elegida, tal como está en la secuencia (no el archivo original).',
      inout: 'Marcá entrada (I) y salida (O) en la secuencia: solo se transcribe ese tramo.' }[$('subScope').value];
    var precise = $('cutMethod').value === 'precise';
    Array.prototype.forEach.call(document.querySelectorAll('#cutSeg button'), function (b) { b.classList.toggle('on', b.getAttribute('data-v') === $('cutMethod').value); });
    $('methodHint').textContent = precise
      ? 'Transcribe el audio y corta las pausas entre palabras, dejando la pausa que corresponde a cada signo. Tarda más, pero suena más natural. Con el guion puede elegir la mejor toma de cada frase.'
      : 'Corta por volumen: lo que está por debajo del umbral. Es lo más rápido y no transcribe.';
    $('preciseBox').hidden = !precise;
    $('minSilRow').hidden = precise; $('padRow').hidden = precise;
    $('keepEndVal').textContent = (+$('keepEnd').value).toFixed(2); $('keepCommaVal').textContent = (+$('keepComma').value).toFixed(2);
    $('keepWordVal').textContent = (+$('keepWord').value).toFixed(2); $('minGapVal').textContent = (+$('minGap').value).toFixed(2);
    $('takeMinVal').textContent = $('takeMin').value; $('takeRow').hidden = !$('useTakes').checked;
    $('transcBoxCuts').hidden = !($('fillers').checked || $('repeats').checked || precise);
    $('keyRow').hidden = $('provider').value === 'local';
    $('modelRow').hidden = $('provider').value !== 'local';
    $('punctRow').hidden = !$('stripPunct').checked;
    Array.prototype.forEach.call(document.querySelectorAll('#outSeg button'), function (b) { b.classList.toggle('on', b.getAttribute('data-v') === $('outFormat').value); });
    var png = $('outFormat').value === 'png';
    $('capTypeRow').hidden = png;
    var multiWordPW = $('perWord').checked && !$('oneWord').checked;
    $('formatHint').textContent = png
      ? 'PNG: imágenes livianas, una por subtítulo (o una por palabra si hay resalte, subrayado o aparición). El pop y el fundido los hace Premiere con animaciones de Escala y Opacidad.' + (multiWordPW ? ' Con PNG, “Animar palabra por palabra” solo hace aparecer cada palabra; para que cada una rebote o se funda usá “Una palabra por vez” o el video con transparencia.' : '')
      : 'Video .mov con transparencia: la animación completa, pero pesa bastante más que los PNG.';
  }
  labels();

  var isStyleControl = function (id) { return STYLE_VALUES.indexOf(id) > -1 || STYLE_CHECKS.indexOf(id) > -1 || id.indexOf('anim_') === 0; };
  var isLineControl = function (id) { return LINE_VALUES.indexOf(id) > -1 || LINE_CHECKS.indexOf(id) > -1; };
  document.querySelectorAll('input,select').forEach(function (el) {
    if (!el.id || el.id === 'presetSel' || el.id === 'presetName' || el.id === 'styleScope') return;
    el.addEventListener('input', function () {
      labels();
      if (el.id === 'provider' || el.id === 'model') refreshSetup();
      if (el.id === 'provider') loadKey();
      else if (el.id === 'apiKey') store('apiKey_' + $('provider').value, el.value);
      else if (!(state.scopeSel && isStyleControl(el.id))) store(el.id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
      if (isStyleControl(el.id)) { if (state.scopeSel) assignSelected(); drawPreview(); }
    });
    // las opciones de líneas rearman los captions al soltar el control (no mientras se arrastra)
    if (isLineControl(el.id)) el.addEventListener('change', regenLines);
  });

  if (!cep || !engine) status('Este panel solo funciona dentro de Premiere Pro (CEP con Node habilitado).', true);

  // Cuentagotas: además de la pantalla, puede tomar colores del fotograma del video que se ve en la vista previa
  window.AlchemyPickers.setFrameProvider(function () {
    var b = state.bg;
    if (!b || !b.naturalWidth) return null;
    var c = document.createElement('canvas');
    c.width = b.naturalWidth; c.height = b.naturalHeight;
    c.getContext('2d').drawImage(b, 0, 0);
    return c.toDataURL('image/png');
  });

  // ---- Fuentes instaladas ----
  // Se pide la lista al sistema (Mac: NSFontManager vía osascript; Windows: PowerShell). Se guarda la última para que el panel abra con la lista ya lista.
  (function loadFonts() {
    var P = window.AlchemyPickers;
    var plat = os && os.platform ? os.platform() : '';
    var FALLBACK = plat === 'win32'
      ? ['Arial', 'Arial Black', 'Impact', 'Segoe UI', 'Verdana', 'Georgia', 'Calibri', 'Tahoma', 'Trebuchet MS', 'Courier New', 'Times New Roman']
      : ['Arial', 'Helvetica Neue', 'Impact', 'Montserrat', 'Georgia', 'Verdana', 'Futura', 'Avenir Next', 'Courier New', 'Times New Roman'];
    var cached = null;
    try { cached = JSON.parse(store('fonts') || 'null'); } catch (e) {}
    P.setFonts(cached && cached.length ? cached : FALLBACK);
    var cp = nodeRequire ? nodeRequire('child_process') : null;
    if (!cp) return;
    var done = function (err, out) {
      if (err || !out) return;
      try {
        var list = JSON.parse(String(out).replace(/^\uFEFF/, '').trim());
        if (typeof list === 'string') list = [list];
        list = list.filter(function (f) { return f && f.charAt(0) !== '.'; });
        if (list.length) { P.setFonts(list); store('fonts', JSON.stringify(list)); }
      } catch (e) {}
    };
    if (plat === 'darwin') {
      var js = 'ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))';
      cp.execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { maxBuffer: 8 * 1024 * 1024 }, done);
    } else if (plat === 'win32') {
      // PresentationCore ve también las fuentes instaladas solo para el usuario; si falla, GDI+
      var ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
        '$n=@(); try{ Add-Type -AssemblyName PresentationCore; $n=@([System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source }) }catch{};' +
        'if($n.Count -eq 0){ Add-Type -AssemblyName System.Drawing; $n=@((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }) };' +
        '$n | Sort-Object -Unique | ConvertTo-Json -Compress';
      cp.execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8', timeout: 30000 }, done);
    }
  })();

  // ---- Actualizaciones (GitHub) ----
  // Una vez por día mira si hay una versión nueva; el botón ↻ la busca cuando quieras. Instalar es siempre con un toque del usuario.
  var upd = null;
  function showVersion() {
    try { $('verLabel').textContent = 'v' + engine.update.readLocal(extPath).version; } catch (e) {}
  }
  function checkUpdates(manual) {
    if (!engine || !engine.update || !extPath) return;
    if (manual) status('Buscando actualizaciones…');
    engine.update.check({ extDir: extPath }).then(function (info) {
      store('updChecked', String(Date.now()));
      upd = info;
      if (info.newer) {
        $('updateCard').hidden = false;
        $('updTitle').textContent = 'Hay una versión nueva: ' + info.latest + ' (tenés la ' + info.current + ')';
        $('updMsg').textContent = (info.notes ? info.notes + ' ' : '') + 'Se instala en unos segundos y el panel se recarga. Tus ajustes y estilos se conservan.';
        if (manual) status('Hay una versión nueva: ' + info.latest + '.');
      } else {
        $('updateCard').hidden = true;
        if (manual) status('Ya tenés la última versión (' + info.current + ').');
      }
    }).catch(function (e) { if (manual) status('No pude buscar actualizaciones: ' + (e && e.message || e), true); });
  }
  $('btnCheckUpd').onclick = function () { checkUpdates(true); };
  $('btnUpdate').onclick = function () {
    if (!upd || !upd.newer) return;
    var btn = $('btnUpdate');
    btn.disabled = true; $('updBar').hidden = false; $('updBar').removeAttribute('value');
    status('Actualizando… no cierres Premiere.');
    engine.update.install({
      extDir: extPath, info: upd,
      onProgress: function (p) { $('updMsg').textContent = p.label + (p.pct !== null ? ' · ' + p.pct + '%' : '…'); if (p.pct !== null) $('updBar').value = p.pct; else $('updBar').removeAttribute('value'); }
    }).then(function (r) {
      status('Actualizado a la versión ' + r.version + '. Recargando…');
      // el script de Premiere (jsx) se vuelve a cargar y después se recarga el panel con los archivos nuevos
      var done = function () { location.reload(); };
      try { cep.evalScript('$.evalFile("' + extPath.replace(/\\/g, '/') + '/jsx/host.jsx")', function () { setTimeout(done, 300); }); } catch (e) { done(); }
    }).catch(function (e) {
      $('updBar').hidden = true; btn.disabled = false;
      $('updMsg').textContent = '';
      status('No se pudo actualizar: ' + (e && e.message || e), true);
    });
  };
  showVersion();
  (function dailyCheck() {
    var last = +(store('updChecked') || 0);
    if (Date.now() - last > 20 * 3600 * 1000) setTimeout(function () { checkUpdates(false); }, 2500);
  })();

  refreshSetup();

  // ---- Presets de estilo ----
  var BUILTIN_PRESETS = {
    'Clásico': { size: 64, weight: 800, outlineW: 12, color: '#ffffff', outline: true, box: false, shadow: true, uppercase: false, anims: ['pop'], oneWord: false, perWord: false },
    'Destacado amarillo': { size: 72, weight: 900, outlineW: 14, color: '#ffffff', highlight: '#ffd400', outline: true, box: false, shadow: true, uppercase: true, anims: ['highlight', 'grow'], oneWord: false, perWord: false },
    'Caja negra': { size: 60, weight: 700, color: '#ffffff', box: true, boxColor: '#000000', outline: false, shadow: false, uppercase: false, anims: ['fade'], oneWord: false, perWord: false },
    'Palabra por palabra': { size: 76, weight: 900, outlineW: 14, color: '#ffffff', highlight: '#00e676', outline: true, box: false, shadow: true, uppercase: true, anims: ['reveal', 'highlight'], oneWord: false, perWord: false },
    'Una palabra (pop)': { size: 96, weight: 900, outlineW: 14, color: '#ffffff', highlight: '#ffd400', outline: true, box: false, shadow: true, uppercase: true, anims: ['pop', 'highlight'], oneWord: true, perWord: false },
    'Subrayado': { size: 64, weight: 800, outlineW: 12, color: '#ffffff', highlight: '#ff3d71', outline: true, box: false, shadow: true, uppercase: false, anims: ['pop', 'underline'], oneWord: false, perWord: false }
  };
  function userPresets() { try { return JSON.parse(store('presets') || '{}'); } catch (e) { return {}; } }
  function collectPreset() {
    var p = { anims: ANIM_IDS.filter(function (id) { return animBox(id).checked; }), vpos: state.scopeSel ? state.wv : state.vpos, hpos: state.scopeSel ? state.wh : state.hpos, oneWord: $('oneWord').checked };
    STYLE_VALUES.forEach(function (id) { p[id] = $(id).value; });
    STYLE_CHECKS.forEach(function (id) { p[id] = $(id).checked; });
    return p;
  }
  // Pone los valores de un preset en los controles. persist = false cuando se editan solo las líneas marcadas: no toca el estilo general guardado.
  function setControls(p, persist) {
    STYLE_VALUES.forEach(function (id) { if (p[id] !== undefined) $(id).value = p[id]; });
    STYLE_CHECKS.forEach(function (id) { if (p[id] !== undefined) $(id).checked = p[id]; });
    if (p.anims) ANIM_IDS.forEach(function (id) { animBox(id).checked = p.anims.indexOf(id) > -1; });
    if (persist) {
      if (p.oneWord !== undefined && p.oneWord !== $('oneWord').checked) { $('oneWord').checked = p.oneWord; store('oneWord', p.oneWord ? '1' : '0'); setTimeout(regenLines, 0); }
      if (p.vpos !== undefined) { state.vpos = p.vpos; store('vpos', p.vpos); }
      if (p.hpos !== undefined) { state.hpos = p.hpos; store('hpos', p.hpos); }
      // guarda cada control como si el usuario lo hubiera tocado
      STYLE_VALUES.concat(STYLE_CHECKS, ANIM_IDS.map(function (id) { return 'anim_' + id; })).forEach(function (id) {
        var el = $(id); if (el) store(id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
      });
    } else {
      if (p.vpos !== undefined) state.wv = p.vpos;
      if (p.hpos !== undefined) state.wh = p.hpos;
    }
    labels();
    drawPreview();
  }
  function applyPreset(p) {
    setControls(p, !state.scopeSel);
    if (state.scopeSel) assignSelected();
  }
  // Galería visual de estilos: cada uno se ve con su fuente, color, contorno y caja. Es el mismo selector de siempre, pero con vista previa.
  function presetChip(label, p, value, mine) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.setAttribute('data-v', value); b.title = label;
    var t = document.createElement('span');
    t.className = 'chiptxt';
    var st = t.style;
    st.fontFamily = '"' + String(p.font || 'Montserrat').replace(/"/g, '') + '", sans-serif';
    st.fontWeight = p.weight || 800; st.color = p.color || '#fff';
    st.textTransform = p.uppercase ? 'uppercase' : 'none';
    if (p.outline !== false && (p.outlineW === undefined || p.outlineW > 0)) { st.webkitTextStroke = Math.max(1, Math.round((p.outlineW || 12) / 8)) + 'px ' + (p.outlineColor || '#000'); st.paintOrder = 'stroke fill'; }
    if (p.shadow) st.textShadow = '0 2px 4px rgba(0,0,0,.7)';
    if (p.box) { st.background = p.boxColor || '#000'; st.padding = '1px 6px'; st.borderRadius = '5px'; }
    var a = document.createElement('span'); a.textContent = 'Hola ';
    var h = document.createElement('span'); h.textContent = 'ya'; h.style.color = p.highlight || p.color || '#fff';
    t.appendChild(a); t.appendChild(h);
    var n = document.createElement('span'); n.className = 'chipname'; n.textContent = (mine ? '★ ' : '') + label;
    b.appendChild(t); b.appendChild(n);
    b.addEventListener('click', function () { $('presetSel').value = value; $('presetSel').dispatchEvent(new Event('change', { bubbles: true })); });
    return b;
  }
  function fillGallery() {
    var g = $('presetGallery'); if (!g) return;
    g.innerHTML = '';
    Object.keys(BUILTIN_PRESETS).forEach(function (n) { g.appendChild(presetChip(n, BUILTIN_PRESETS[n], 'b:' + n, false)); });
    var u = userPresets();
    Object.keys(u).forEach(function (n) { g.appendChild(presetChip(n, u[n], 'u:' + n, true)); });
    markGallery();
  }
  function markGallery() {
    var v = $('presetSel').value;
    Array.prototype.forEach.call(document.querySelectorAll('#presetGallery .chip'), function (c) { c.classList.toggle('on', c.getAttribute('data-v') === v); });
  }
  function fillPresets(selected) {
    var sel = $('presetSel');
    sel.innerHTML = '<option value="">— Elegí un estilo —</option>';
    Object.keys(BUILTIN_PRESETS).forEach(function (n) { var o = document.createElement('option'); o.value = 'b:' + n; o.textContent = n; sel.appendChild(o); });
    Object.keys(userPresets()).forEach(function (n) { var o = document.createElement('option'); o.value = 'u:' + n; o.textContent = '★ ' + n; sel.appendChild(o); });
    if (selected) sel.value = selected;
    presetButtons();
    fillGallery();
  }
  function presetButtons() {
    var v = $('presetSel').value, mine = v && v.charAt(0) === 'u';
    $('btnPresetUpdate').disabled = !mine;
    $('btnPresetDel').disabled = !mine;
    $('presetHint').textContent = !v ? '' : mine ? 'Es uno de tus estilos (★): cambialo y tocá “Actualizar este estilo” para guardar los cambios encima.' : 'Los estilos de fábrica no se modifican: guardá una copia con “Guardar como estilo nuevo”.';
    if (mine) $('presetName').value = v.slice(2);
    markGallery();
  }
  fillPresets();
  $('presetSel').addEventListener('change', function () {
    var v = this.value;
    if (!v) return;
    var p = v.charAt(0) === 'b' ? BUILTIN_PRESETS[v.slice(2)] : userPresets()[v.slice(2)];
    presetButtons();
    if (p) applyPreset(p);
  });
  $('btnPresetUpdate').onclick = function () {
    var v = $('presetSel').value;
    if (!v || v.charAt(0) !== 'u') return status('Elegí uno de tus estilos (los que tienen ★) para actualizarlo.', true);
    var name = v.slice(2), all = userPresets();
    if (!all[name]) return status('No encuentro ese estilo.', true);
    all[name] = collectPreset();
    store('presets', JSON.stringify(all));
    status('Estilo “' + name + '” actualizado.');
  };
  $('btnPresetSave').onclick = function () {
    var name = $('presetName').value.trim();
    if (!name) return status('Escribí un nombre para guardar el estilo.', true);
    var all = userPresets(), existed = !!all[name];
    all[name] = collectPreset();
    store('presets', JSON.stringify(all));
    fillPresets('u:' + name);
    status(existed ? 'Ya había un estilo con ese nombre: lo reemplacé.' : 'Estilo “' + name + '” guardado.');
  };
  $('btnPresetDel').onclick = function () {
    var v = $('presetSel').value;
    if (!v || v.charAt(0) !== 'u') return status('Elegí uno de tus presets (los que tienen ★) para borrarlo.', true);
    var all = userPresets();
    delete all[v.slice(2)];
    store('presets', JSON.stringify(all));
    fillPresets();
    status('Preset borrado.');
  };

  // ---- Captions: líneas, formato y tiempos ----
  var escapeClass = function (chars) { return chars.replace(/[\\\]\^-]/g, '\\$&'); };

  // "Quitar signos": se aplica después de armar las líneas, para que las comas y puntos todavía sirvan para cortar bien.
  function stripPunctuation(lines) {
    if (!$('stripPunct').checked || !$('punctList').value) return lines;
    var re = new RegExp('[' + escapeClass($('punctList').value) + ']', 'g');
    return lines.map(function (l) {
      var text = l.text.split('\n').map(function (row) { return row.replace(re, '').replace(/\s+/g, ' ').trim(); }).filter(Boolean).join('\n');
      var words = l.words && l.words.map(function (w) { return { text: w.text.replace(re, ''), fixed: w.fixed, start: w.start, end: w.end }; }).filter(function (w) { return w.text.trim(); });
      return { start: l.start, end: l.end, srcStart: l.srcStart, text: text, words: words };
    }).filter(function (l) { return l.text; });
  }

  // "Extender hasta la siguiente": evita parpadeos entre líneas casi seguidas.
  function extendTiming(lines) {
    if (!$('extend').checked) return lines;
    lines.forEach(function (l, i) {
      var next = lines[i + 1];
      if (next && next.start - l.end > 0 && next.start - l.end < 0.6) l.end = next.start;
    });
    return lines;
  }

  // "Una sola palabra a la vez": cada palabra pasa a ser su propia línea, con el tiempo en que suena.
  function splitOneWord(lines) {
    if (!$('oneWord').checked) return lines;
    var out = [];
    lines.forEach(function (l) {
      var ws = R.lineWords(l);
      ws.forEach(function (w, i) {
        out.push({
          start: i === 0 ? l.start : w.start, end: i + 1 < ws.length ? ws[i + 1].start : l.end, srcStart: l.srcStart,
          text: w.text, words: [{ text: w.text, fixed: w.fixed, start: w.start, end: w.end }]
        });
      });
    });
    return out;
  }

  // Desfase manual de todos los captions (en ms), para afinar contra el audio.
  function shiftLines(lines) {
    var off = (+$('offset').value || 0) / 1000;
    if (!off) return lines;
    var mv = function (t) { return Math.max(0, t + off); };
    return lines.map(function (l) {
      return {
        start: mv(l.start), end: mv(l.end), srcStart: l.srcStart, text: l.text,
        words: l.words && l.words.map(function (w) { return { text: w.text, fixed: w.fixed, start: mv(w.start), end: mv(w.end) }; })
      };
    });
  }

  // Un subtítulo que dura menos de ~3 cuadros se puede perder al colocarlo en la secuencia (Premiere lo acomoda al cuadro y el
  // siguiente lo pisa). Se le presta tiempo de la línea vecina para que siempre se vea.
  function minDur() { return Math.max(0.1, 3 / ((state.clip && state.clip.fps) || 30)); }
  function fixMinDur(lines) {
    var min = minDur();
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i], need = min - (l.end - l.start);
      if (need <= 0) continue;
      var prev = lines[i - 1], next = lines[i + 1];
      if (next && next.start - l.end < 0.05 && next.end - next.start - need >= min) { l.end += need; next.start += need; }
      else if (prev && l.start - prev.end < 0.05 && prev.end - prev.start - need >= min) { prev.end -= need; l.start -= need; }
      else if (!next || next.start - l.end >= need) l.end += need;
    }
    return lines;
  }

  // Corre una línea entera (y sus palabras) d segundos: para arreglar a mano un subtítulo que quedó desfasado.
  function nudgeLine(line, d) {
    var first = line.start;
    d = Math.max(d, -first);                 // no pasa del comienzo del clip
    line.start += d; line.end += d;
    if (line.words) line.words.forEach(function (w) { w.start += d; w.end += d; });
  }

  function regenLines() {
    var r = state.result;
    if (!r || !r.words) return;
    var built = engine.buildCaptions(r.words, r.removed, {
      dropped: r.dropped, maxChars: +$('maxChars').value, maxLines: +$('maxLines').value, maxWords: +$('maxWords').value
    });
    state.lines = fixMinDur(extendTiming(splitOneWord(shiftLines(stripPunctuation(built)))));
    state.active = 0;
    renderCaptions();
  }

  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.max(30, ta.scrollHeight + 2) + 'px'; }

  // Estilo (lo que usa el dibujo) a partir de valores tipo preset.
  function styleFromValues(p) {
    var size = +p.size;
    return {
      animations: p.anims || [],
      font: p.font || 'Montserrat', weight: +p.weight, size: size,
      vpos: p.vpos, hpos: p.hpos,
      color: p.color, highlight: p.highlight,
      outline: !!p.outline, outlineColor: p.outlineColor, outlineWidth: Math.round(size * p.outlineW / 100),
      box: !!p.box, boxColor: p.boxColor, boxOpacity: 0.85, boxRadius: Math.round(size * 0.35), boxPad: Math.round(size * 0.3),
      shadow: !!p.shadow, uppercase: !!p.uppercase, perWord: !!p.perWord
    };
  }
  // Estilo general: lo que muestran los controles, salvo cuando se están editando solo las líneas marcadas (ahí es el guardado al entrar).
  function getStyle() { return styleFromValues(state.scopeSel && state.globalSp ? state.globalSp : collectPreset()); }
  // Cada línea puede tener su estilo propio (line.sp); si no, usa el general.
  function styleOf(line) { return line && line.sp ? styleFromValues(line.sp) : getStyle(); }
  function frameSize() { return { W: (state.clip && state.clip.width) || 1080, H: (state.clip && state.clip.height) || 1920, fps: (state.clip && state.clip.fps) || 30 }; }

  // Dibuja la vista previa con el mismo código que el render final, sobre un cuadro del video (o fondo liso).
  function drawPreview(t) {
    syncPosUi();
    var line = state.lines[state.active];
    var cv = $('previewCanvas'), fsz = frameSize();
    var pw = 340, k = pw / fsz.W;
    cv.width = pw; cv.height = Math.round(fsz.H * k);
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (state.bg) ctx.drawImage(state.bg, 0, 0, cv.width, cv.height);
    if (!line) return;
    if (t === undefined) t = line.start + (line.end - line.start) * 0.6;
    ctx.save();
    ctx.scale(k, k);
    R.draw(ctx, fsz.W, fsz.H, line, t, styleOf(line));
    ctx.restore();
  }

  // Posición del texto: se puede cambiar con los deslizadores de “Estilo”, con el cuadrito de la derecha o con un clic en la vista previa.
  function curPos() { return state.scopeSel ? { h: state.wh, v: state.wv } : { h: state.hpos, v: state.vpos }; }
  function setPos(hp, vp) {
    hp = Math.round(Math.max(5, Math.min(95, hp))); vp = Math.round(Math.max(5, Math.min(95, vp)));
    if (state.scopeSel) { state.wh = hp; state.wv = vp; assignSelected(); }
    else { state.hpos = hp; state.vpos = vp; store('hpos', hp); store('vpos', vp); }
    drawPreview();
  }
  function syncPosUi() {
    var p = curPos();
    if (+$('posV').value !== p.v) $('posV').value = p.v;
    if (+$('posH').value !== p.h) $('posH').value = p.h;
    $('posDot').style.left = p.h + '%'; $('posDot').style.top = p.v + '%';
  }
  $('previewCanvas').addEventListener('click', function (e) {
    var rect = this.getBoundingClientRect();
    setPos((e.clientX - rect.left) / rect.width * 100, (e.clientY - rect.top) / rect.height * 100);
  });
  ['posV', 'posH'].forEach(function (id) { $(id).addEventListener('input', function () { setPos(+$('posH').value, +$('posV').value); }); });
  (function posPad() {
    var pad = $('posPad'), drag = false;
    var at = function (e) { var r = pad.getBoundingClientRect(); setPos((e.clientX - r.left) / r.width * 100, (e.clientY - r.top) / r.height * 100); };
    pad.addEventListener('mousedown', function (e) { drag = true; at(e); e.preventDefault(); });
    document.addEventListener('mousemove', function (e) { if (drag) at(e); });
    document.addEventListener('mouseup', function () { drag = false; });
    Array.prototype.forEach.call(document.querySelectorAll('#posQuick button'), function (b) {
      b.addEventListener('click', function () { setPos(curPos().h, +b.getAttribute('data-v')); });
    });
  })();

  function showPreview(i) {
    state.active = i;
    state.playing++;
    var line = state.lines[i];
    document.querySelectorAll('.cap').forEach(function (el, k) { el.classList.toggle('active', k === i); });
    state.bg = null;
    drawPreview();
    if (!line || !state.frameDir || !state.clip) return;
    var out = path.join(state.frameDir, 'frame_' + i + '.jpg');
    var src = sourceAt(line.srcStart);
    engine.extractFrame(src.path, src.t, out).then(function (ok) {
      if (!ok || state.active !== i) return;
      var img = new Image();
      img.onload = function () { if (state.active === i) { state.bg = img; drawPreview(); } };
      img.src = fileUrl(out) + '?' + Date.now();
    });
  }

  $('btnPlay').onclick = function () {
    var line = state.lines[state.active];
    if (!line) return;
    var token = ++state.playing, t0 = performance.now(), from = line.start - 0.15, to = line.end + 0.15;
    (function tick() {
      if (token !== state.playing) return;
      var t = from + (performance.now() - t0) / 1000;
      drawPreview(Math.min(t, line.end - 0.001));
      if (t < to) requestAnimationFrame(tick); else drawPreview();
    })();
  };

  function renderCaptions() {
    var list = $('capList');
    // el editor tiene que estar visible antes de medir los cuadros de texto, si no quedan de alto cero
    list.innerHTML = '';
    $('capCount').textContent = state.lines.length + (state.lines.length === 1 ? ' subtítulo' : ' subtítulos');
    state.lines.forEach(function (line, i) {
      var row = document.createElement('div');
      row.className = 'cap';
      var t = document.createElement('div');
      t.className = 'tm';
      var pick = document.createElement('input');
      pick.type = 'checkbox'; pick.checked = !!line.sel; pick.title = 'Marcar esta línea (Shift para marcar un rango)';
      pick.addEventListener('click', function (e) { pickLine(i, pick.checked, e.shiftKey); });
      var pl = document.createElement('label');
      pl.appendChild(pick);
      var tn = document.createTextNode(clock(line.start));
      pl.appendChild(tn);
      t.appendChild(pl);
      var mark = document.createElement('span');
      mark.className = 'mark'; mark.textContent = line.sp ? '● estilo propio' : '';
      t.appendChild(mark);
      var fx = document.createElement('span');
      fx.className = 'fixmark'; fx.textContent = hasFix(line) ? '✓ corregida' : '';
      t.appendChild(fx);
      row.classList.toggle('picked', !!line.sel);
      var ta = document.createElement('textarea');
      ta.rows = line.text.split('\n').length;
      ta.value = line.text;
      ta.addEventListener('input', function () { line.text = ta.value; autoGrow(ta); drawPreview(); });
      ta.addEventListener('focus', function () { showPreview(i); });
      var acts = document.createElement('div');
      acts.className = 'acts';
      var join = document.createElement('button');
      join.textContent = 'Unir';
      join.disabled = i === state.lines.length - 1;
      join.onclick = function () { joinWithNext(i); };
      var split = document.createElement('button');
      split.textContent = 'Dividir';
      split.onclick = function () { splitAtCursor(i, ta); };
      // ajuste fino del tiempo de esta línea (clic: 0,05 s · Shift+clic: 0,25 s)
      var early = document.createElement('button'), late = document.createElement('button');
      early.textContent = '◂'; early.title = 'Que aparezca antes (clic: 0,05 s · Shift: 0,25 s)';
      late.textContent = '▸'; late.title = 'Que aparezca después (clic: 0,05 s · Shift: 0,25 s)';
      var nudge = function (dir) { return function (e) { nudgeLine(line, dir * (e.shiftKey ? 0.25 : 0.05)); tn.nodeValue = clock(line.start); showPreview(i); }; };
      early.onclick = nudge(-1); late.onclick = nudge(1);
      var del = document.createElement('button');
      del.textContent = '🗑'; del.title = 'Borrar este subtítulo de la lista (no se agrega a la secuencia)';
      del.onclick = function () { state.lines.splice(i, 1); state.active = Math.max(0, Math.min(state.active, state.lines.length - 1)); renderCaptions(); status('Borré el subtítulo.'); };
      acts.appendChild(join); acts.appendChild(split); acts.appendChild(early); acts.appendChild(late); acts.appendChild(del);
      row.appendChild(t); row.appendChild(ta); row.appendChild(acts);
      list.appendChild(row);
    });
    list.querySelectorAll('textarea').forEach(autoGrow);
    updateSelUi();
    if (state.lines.length) showPreview(Math.min(state.active, state.lines.length - 1));
    else drawPreview();
  }

  // ---- Líneas marcadas: estilo propio, reemplazo de palabras y agregar solo algunas ----
  function hasFix(line) { return !!(line.words && line.words.some(function (w) { return w.fixed; })); }
  function selectedLines() { return state.lines.filter(function (l) { return l.sel; }); }
  function updateSelUi() {
    var n = selectedLines().length;
    $('selCount').textContent = n ? n + ' de ' + state.lines.length + ' marcados' : 'ninguno marcado';
    $('btnUnstyle').disabled = !selectedLines().some(function (l) { return l.sp; });
    $('styleScopeHint').textContent = state.scopeSel
      ? (n ? 'Los cambios afectan solo a los ' + n + ' subtítulos marcados. El estilo general no cambia.' : 'Tildá a la izquierda los subtítulos que querés cambiar.')
      : 'Los cambios afectan a todos los subtítulos, salvo los que tienen estilo propio (●).';
    document.querySelectorAll('#capList .cap').forEach(function (row, k) {
      var l = state.lines[k]; if (!l) return;
      row.classList.toggle('picked', !!l.sel);
      var mk = row.querySelector('.mark'); if (mk) mk.textContent = l.sp ? '● estilo propio' : '';
      var fm = row.querySelector('.fixmark'); if (fm) fm.textContent = hasFix(l) ? '✓ corregida' : '';
      var cb = row.querySelector('input[type=checkbox]'); if (cb) cb.checked = !!l.sel;
    });
  }
  function pickLine(i, on, range) {
    if (range && state.lastPick > -1) {
      var a = Math.min(i, state.lastPick), b = Math.max(i, state.lastPick);
      for (var k = a; k <= b; k++) state.lines[k].sel = on;
    } else state.lines[i].sel = on;
    state.lastPick = i;
    onSelectionChanged();
  }
  function onSelectionChanged() {
    // al editar solo las marcadas, los controles muestran el estilo de la primera marcada (si tiene uno propio)
    if (state.scopeSel) { var f = selectedLines()[0]; if (f && f.sp) setControls(f.sp, false); }
    updateSelUi();
  }
  function assignSelected() {
    var p = collectPreset();
    state.lines.forEach(function (l) { if (l.sel) l.sp = JSON.parse(JSON.stringify(p)); });
    updateSelUi();
  }
  $('selAll').onclick = function () { state.lines.forEach(function (l) { l.sel = true; }); onSelectionChanged(); };
  $('selNone').onclick = function () { state.lines.forEach(function (l) { l.sel = false; }); onSelectionChanged(); };
  $('btnDelSel').onclick = function () {
    var n = selectedLines().length;
    if (!n) return status('Marcá primero los subtítulos que querés borrar (casilla de la izquierda).', true);
    state.lines = state.lines.filter(function (l) { return !l.sel; });
    state.active = 0; state.lastPick = -1;
    renderCaptions();
    status('Borré ' + n + (n === 1 ? ' subtítulo' : ' subtítulos') + ' de la lista.');
  };
  $('btnUnstyle').onclick = function () {
    state.lines.forEach(function (l) { if (l.sel) delete l.sp; });
    updateSelUi(); drawPreview();
    status('Los subtítulos marcados vuelven al estilo general.');
  };
  $('styleScope').addEventListener('change', function () {
    if (this.value === 'sel') {
      state.globalSp = collectPreset();
      state.wv = state.vpos; state.wh = state.hpos;
      state.scopeSel = true;
      var f = selectedLines()[0];
      if (f && f.sp) setControls(f.sp, false);
    } else {
      state.scopeSel = false;
      if (state.globalSp) setControls(state.globalSp, true);
      state.globalSp = null;
    }
    updateSelUi(); drawPreview();
  });

  // Reemplazar palabras: en todas las líneas o solo en las marcadas. Se conserva el tiempo de cada palabra cuando se puede.
  function escapeRe(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  $('btnReplace').onclick = function () {
    var find = $('findText').value, repl = $('replText').value;
    if (!find) return status('Escribí la palabra que querés buscar.', true);
    var whole = $('findWhole').checked, flags = $('findCase').checked ? 'g' : 'gi';
    var core = escapeRe(find);
    // “palabra completa”: que no haya otra letra o número pegado antes ni después
    var re = new RegExp(whole ? '(^|[^\\p{L}\\p{N}])(' + core + ')(?![\\p{L}\\p{N}])' : '()(' + core + ')', flags + 'u');
    var onlySel = $('findScope').value === 'sel', hits = 0, linesHit = 0;
    if (onlySel && !selectedLines().length) return status('Tildá primero los subtítulos donde querés reemplazar.', true);
    state.lines.forEach(function (l) {
      if (onlySel && !l.sel) return;
      var n = 0;
      var sub = function (text) { return text.replace(re, function (_m, pre) { n++; return pre + repl; }); };
      var newText = sub(l.text);
      if (!n) return;
      hits += n; linesHit++;
      if (l.words) {
        var nw = l.words.map(function (w) { return { text: w.text.replace(re, function (_m, pre) { return pre + repl; }), fixed: w.fixed, start: w.start, end: w.end }; }).filter(function (w) { return w.text.trim(); });
        l.words = nw.map(function (w) { return w.text; }).join(' ') === newText.replace(/\s+/g, ' ').trim() ? nw : null;
      }
      l.text = newText;
    });
    renderCaptions();
    status(hits ? 'Reemplacé ' + hits + (hits === 1 ? ' vez' : ' veces') + ' en ' + linesHit + (linesHit === 1 ? ' subtítulo.' : ' subtítulos.') : 'No encontré “' + find + '”' + (onlySel ? ' en los subtítulos marcados.' : '.'), !hits);
  };

  function joinWithNext(i) {
    var a = state.lines[i], b = state.lines[i + 1];
    if (!b) return;
    state.lines.splice(i, 2, { sel: a.sel, sp: a.sp, start: a.start, end: b.end, srcStart: a.srcStart, text: (a.text + ' ' + b.text).replace(/\s*\n\s*/g, ' '), words: a.words && b.words ? a.words.concat(b.words) : null });
    state.active = i;
    renderCaptions();
  }

  // El tiempo del corte se reparte según dónde cae el cursor dentro del texto.
  function splitAtCursor(i, ta) {
    var line = state.lines[i];
    var pos = ta.selectionStart;
    var left = ta.value.slice(0, pos).trim();
    var right = ta.value.slice(pos).trim();
    if (!left || !right) return status('Poné el cursor en el medio del texto para dividir.', true);
    var mid = line.start + (line.end - line.start) * (left.length / (left.length + right.length));
    state.lines.splice(i, 1,
      { sel: line.sel, sp: line.sp, start: line.start, end: mid, srcStart: line.srcStart, text: left },
      { sel: line.sel, sp: line.sp, start: mid, end: line.end, srcStart: line.srcStart, text: right });
    state.active = i;
    renderCaptions();
  }

  // ---- Modos, pantallas y pestañas ----
  // Cortes y Subtítulos son dos flujos separados: los subtítulos se arman sobre lo que ya está en la secuencia.
  function setMode(mode) {
    if (state.mode !== mode) { state.clips = []; state.clip = null; }   // cada modo lee lo suyo
    state.mode = mode;
    store('mode', mode);
    $('cutsMode').hidden = mode !== 'cuts';
    $('subsMode').hidden = mode !== 'subs';
    $('modeCuts').classList.toggle('active', mode === 'cuts');
    $('modeSubs').classList.toggle('active', mode === 'subs');
    // la transcripción (idioma, motor, modelo) es la misma en los dos modos: cambia de lugar
    $('transcBoxCuts').appendChild($('transcFs'));
    if (mode === 'subs') $('transcBoxSubs').appendChild($('transcFs'));
    $('transcFs').hidden = false;
    // el guion también sirve en los cortes precisos: cambia de lugar igual que la transcripción
    (mode === 'subs' ? $('scriptHostSubs') : $('scriptBoxCuts')).appendChild($('scriptBox'));
    labels();
    refreshInfo();
    if (mode === 'subs' && !$('subsEditor').hidden) { drawPreview(); $('capList').querySelectorAll('textarea').forEach(autoGrow); }
  }
  function showCuts(view) { $('cutsSetup').hidden = view !== 'setup'; $('cutsResult').hidden = view !== 'result'; }
  function updateSteps() {
    var editor = !$('subsEditor').hidden, add = editor && !$('optOut').hidden;
    var cur = !editor ? 1 : add ? 3 : 2;
    Array.prototype.forEach.call(document.querySelectorAll('#subSteps li'), function (li) {
      var n = +li.getAttribute('data-s');
      li.classList.toggle('on', n === cur); li.classList.toggle('done', n < cur);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('#subSteps li'), function (li) {
    li.addEventListener('click', function () {
      var n = +li.getAttribute('data-s');
      if (n === 1) showSubs('setup');
      else if (state.lines.length) { showSubs('editor'); showPane('optTabs', n === 3 ? 'optOut' : 'optStyle'); }
      else status('Primero transcribí el video: después podés editar y agregar.', true);
    });
  });
  function showSubs(view) {
    if (view !== 'editor') stopAnimDemos();
    $('subsSetup').hidden = view !== 'setup'; $('transcFs').hidden = view !== 'setup'; $('subsEditor').hidden = view !== 'editor';
    updateSteps();
    $('btnToEditor').hidden = !(state.result && state.lines.length);
    if (view === 'editor') { drawPreview(); $('capList').querySelectorAll('textarea').forEach(autoGrow); }
  }
  // Ejemplos animados en las tarjetas de animación: cada una muestra su efecto solo, con el estilo (fuente, colores) que tengas ahora.
  var demoToken = 0;
  var DEMO_LINE = { start: 0, end: 2.0, text: 'Así se ve', words: [{ text: 'Así', start: 0.15, end: 0.6 }, { text: 'se', start: 0.75, end: 1.1 }, { text: 've', start: 1.25, end: 2.0 }] };
  function startAnimDemos() {
    var token = ++demoToken, t0 = performance.now();
    var cards = Array.prototype.slice.call(document.querySelectorAll('#animList canvas.demo'));
    (function tick() {
      if (token !== demoToken) return;
      var T = ((performance.now() - t0) / 1000) % 2.8, base = getStyle();
      cards.forEach(function (cv) {
        var ctx = cv.getContext('2d'), W = 540, H = 135, k = cv.width / W;
        ctx.clearRect(0, 0, cv.width, cv.height);
        var st = Object.assign({}, base, { animations: [cv.getAttribute('data-id')], perWord: false, settled: false, vpos: 50, hpos: 50, size: 56 });
        ctx.save(); ctx.scale(k, k);
        try { R.draw(ctx, W, H, DEMO_LINE, T, st); } catch (e) {}
        ctx.restore();
      });
      requestAnimationFrame(tick);
    })();
  }
  function stopAnimDemos() { demoToken++; }
  // los ejemplos solo corren cuando se está viendo la parte de Animación
  function updateDemos() {
    var showing = !$('optStyle').hidden && !$('animMain').hidden && !$('subsEditor').hidden;
    if (showing) startAnimDemos(); else stopAnimDemos();
  }
  // Estilo / Animación: dos solapitas dentro de la misma pestaña
  function showStyleSub(v) {
    $('styleMain').hidden = v !== 'style'; $('animMain').hidden = v !== 'anim';
    Array.prototype.forEach.call(document.querySelectorAll('#styleSub button'), function (b) { b.classList.toggle('on', b.getAttribute('data-v') === v); });
    updateDemos();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#styleSub button'), function (b) { b.addEventListener('click', function () { showStyleSub(b.getAttribute('data-v')); }); });
  function showPane(groupId, paneId) {
    $(groupId).querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.pane === paneId);
      $(t.dataset.pane).hidden = t.dataset.pane !== paneId;
    });
    if (groupId === 'optTabs') {
      updateSteps();
      updateDemos();
      if (paneId === 'optLines') $('capList').querySelectorAll('textarea').forEach(autoGrow);     // las cajas de texto miden cero mientras están ocultas
    }
  }
  document.querySelectorAll('.step').forEach(function (b) { b.onclick = function () { setMode(b.dataset.mode); }; });
  $('optTabs').querySelectorAll('.tab').forEach(function (t) { t.onclick = function () { showPane('optTabs', t.dataset.pane); }; });
  $('btnBackCuts').onclick = function () { showCuts('setup'); };
  $('btnBackSubs').onclick = function () { showSubs('setup'); };
  $('btnToEditor').onclick = function () { showSubs('editor'); };

  // Dónde está en los archivos originales un instante de la línea de tiempo del análisis (para sacar el fotograma de fondo).
  function sourceAt(t) {
    var tl = state.timeline, k;
    for (k = 0; k < tl.length; k++) if (t >= tl[k].from && t < tl[k].to) return { path: tl[k].path, t: tl[k].inSec + (t - tl[k].from) * (tl[k].speed || 1) };
    if (tl.length) { var last = tl[tl.length - 1]; return { path: last.path, t: last.inSec + Math.max(0, Math.min(t, last.to) - last.from) * (last.speed || 1) }; }
    return { path: state.clip.path, t: state.clip.inSec + t * (state.clip.speed || 1) };
  }

  // ---- Selección, análisis y cortes ----
  function fillTracks(n) {
    var sel = $('targetTrack'), keep = sel.value;
    sel.innerHTML = '<option value="auto">Automática (la primera libre arriba)</option>';
    for (var i = 1; i <= n; i++) { var o = document.createElement('option'); o.value = String(i); o.textContent = 'V' + i; sel.appendChild(o); }
    var nw = document.createElement('option'); nw.value = 'new'; nw.textContent = 'Pista nueva arriba'; sel.appendChild(nw);
    if (keep) sel.value = keep;
  }

  function refreshInfo() {
    var cs = state.clips;
    if (!cs.length) {
      $('clipInfo').textContent = state.mode === 'cuts' ? 'Seleccioná en la secuencia el clip con la voz y apretá “Leer selección”.'
        : 'Elegí qué transcribir y apretá “Leer”: te muestro qué clips va a usar.';
      $('btnRead').textContent = state.mode === 'cuts' ? 'Leer selección' : 'Leer lo que voy a transcribir';
      return;
    }
    $('btnRead').textContent = state.mode === 'cuts' ? 'Leer selección' : 'Leer lo que voy a transcribir';
    var warn = cs.some(function (c) { return c.speedMismatch; }) ? ' · ⚠ hay clips invertidos, con velocidad variable o dentro de una secuencia anidada con otra velocidad: los tiempos pueden no caer bien' : '';
    var fast = cs.filter(function (c) { return c.speed && c.speed !== 1; });
    if (fast.length) warn += ' · velocidad ajustada (' + fast.slice(0, 3).map(function (c) { return Math.round(c.speed * 100) + ' %'; }).join(', ') + (fast.length > 3 ? '…' : '') + ')';
    if (state.mode === 'cuts') {
      var c = cs[0];
      $('clipInfo').textContent = c.name + ' · ' + fmt(c.outSec - c.inSec) + (cs.length > 1 ? ' · ⚠ hay ' + cs.length + ' clips seleccionados: los cortes se hacen sobre el primero' : '') + warn;
    } else {
      var covered = cs.reduce(function (n, c) { return n + (c.endSec - c.startSec); }, 0);
      var where = { selected: 'seleccionados', sequence: 'en la pista A' + state.readInfo.audioTrack, inout: 'entre las marcas, pista A' + state.readInfo.audioTrack }[state.readInfo.scope];
      $('clipInfo').textContent = cs.length + (cs.length === 1 ? ' clip ' : ' clips ') + where + ' · con voz ' + clock(covered) +
        ' · de ' + clock(cs[0].startSec) + ' a ' + clock(cs[cs.length - 1].endSec) + ' en la secuencia' +
        (state.readInfo.nested ? ' · incluye ' + state.readInfo.nested + (state.readInfo.nested === 1 ? ' secuencia anidada' : ' secuencias anidadas') : '') +
        (state.readInfo.skipped ? ' · ⚠ ' + state.readInfo.skipped + ' sin audio que pueda leer, no se transcriben' : '') + warn;
    }
  }

  function fillAudioTracks(n) {
    var sel = $('audioTrack'), keep = sel.value;
    sel.innerHTML = '<option value="0">Automática (la primera con clips)</option>';
    for (var i = 1; i <= n; i++) { var o = document.createElement('option'); o.value = String(i); o.textContent = 'A' + i; sel.appendChild(o); }
    sel.value = keep && +keep <= n ? keep : '0';
  }

  // Lee de Premiere los clips que corresponden al modo: en Cortes, la selección; en Subtítulos, lo que pidió el usuario.
  function readClips() {
    var arg = state.mode === 'cuts' ? { scope: 'selected' } : { scope: $('subScope').value, audioTrack: +$('audioTrack').value };
    return host('getClips', arg).then(function (d) {
      state.clips = d.clips;
      state.readInfo = d;
      state.clip = Object.assign({}, d.clips[0], { width: d.width, height: d.height, videoTracks: d.videoTracks, fps: d.fps });
      fillTracks(d.videoTracks || 0);
      fillAudioTracks(d.audioTracks || 0);
      refreshInfo();
      return d;
    });
  }
  $('btnRead').onclick = function () {
    readClips().then(function () { status(''); }).catch(function (e) { state.clips = []; refreshInfo(); status(e.message, true); });
  };
  // al cambiar lo que se quiere transcribir, la lectura anterior ya no vale
  ['subScope', 'audioTrack'].forEach(function (id) { $(id).addEventListener('input', function () { if (state.mode === 'subs') { state.clips = []; refreshInfo(); } }); });

  function transcriptionArgs() {
    return { language: $('language').value, provider: $('provider').value, model: $('model').value, apiKey: $('apiKey').value };
  }
  function needKey() {
    return $('provider').value !== 'local' && !$('apiKey').value ? 'Falta la API key para transcribir con ' + $('provider').value + '.' : '';
  }

  // ----- Cortes -----
  // Lista de cortes con casilla por corte (los dudosos vienen sin marcar). El resumen se recalcula con lo marcado.
  function checkedCuts() {
    var r = state.cutsResult;
    return r ? r.removed.filter(function (c) { return c.on !== false; }) : [];
  }
  function cutsSummary() {
    var r = state.cutsResult, on = checkedCuts();
    var saved = engine.mergeRanges(on.map(function (c) { return { start: c.start, end: c.end, reason: 'x' }; })).reduce(function (n, c) { return n + (c.end - c.start); }, 0);
    var parts = [on.length + ' de ' + r.removed.length + ' cortes marcados · ahorra ' + fmt(saved) + ' de ' + fmt(r.duration)];
    if (r.level) parts.push('umbral automático ' + r.threshold + ' dB');
    if (r.mainPeak !== null && r.mainPeak !== undefined) {
      parts.push('tu voz marca ' + Math.round(r.mainPeak) + ' dB en el archivo' + (r.offset ? ' (' + Math.round(r.mainPeak + r.offset) + ' en Premiere)' : ''));
      if (r.offset) parts.push('voces bajas: menos de ' + Math.round(r.fileLevel) + ' dB en el archivo');
    }
    var sm = r.smart;
    if (sm && sm.takeInfo) {
      var t = sm.takeInfo;
      if (t.unrelated) parts.push('no encontré frases del guion en la grabación: no se sacó ninguna toma (¿es el guion de este video?)');
      else {
        parts.push(t.chosen + ' de ' + t.sentences + ' frases del guion encontradas');
        if (t.flagged.length) parts.push(t.flagged.length + ' dicha' + (t.flagged.length === 1 ? '' : 's') + ' con otras palabras (se quedan)');
        if (t.missing.length) parts.push('sin encontrar: «' + t.missing.slice(0, 2).join('», «').slice(0, 120) + '»');
      }
    }
    if (sm && sm.skipped && sm.skipped.length) parts.push(sm.skipped.length + ' pausa' + (sm.skipped.length === 1 ? '' : 's') + ' sin cortar (no hay un silencio claro)');
    $('summary').textContent = parts.join(' · ');
    $('btnApply').disabled = on.length === 0;
  }
  $('btnAnalyze').onclick = function () {
    if (!state.clip) return status('Primero leé la selección.', true);
    state.cutsClip = state.clip;
    var precise = $('cutMethod').value === 'precise';
    var wantsText = $('fillers').checked || $('repeats').checked || precise;
    if (wantsText && needKey()) return status(needKey(), true);
    var sp = setupProblem(wantsText);
    if (sp) return status(sp, true);
    $('btnAnalyze').disabled = true;
    status(wantsText ? 'Analizando y transcribiendo…' : 'Buscando silencios…');
    var pp = $('premierePeak').value.trim();
    engine.analyze(Object.assign({
      input: state.clip.path, inSec: state.clip.inSec, durSec: state.clip.outSec - state.clip.inSec,
      noiseDb: +$('noiseDb').value, autoThresh: $('autoThresh').checked, minSilence: +$('minSilence').value, pad: +$('pad').value,
      fillers: $('fillers').checked, captions: false,
      quietVoices: $('quietVoices').checked, quietLevel: +$('quietLevel').value, quietMin: +$('quietMin').value, premierePeak: pp === '' ? null : +pp,
      repeats: $('repeats').checked, repeatWords: +$('repeatWords').value, repeatGap: +$('repeatGap').value,
      method: precise ? 'precise' : 'fast',
      keepEnd: +$('keepEnd').value, keepComma: +$('keepComma').value, keepWord: +$('keepWord').value, minGap: +$('minGap').value,
      takes: precise && $('useTakes').checked, takeMin: +$('takeMin').value / 100, cutOffScript: $('cutOffScript').checked,
      script: precise ? $('scriptText').value : '', scriptFix: $('scriptFix').checked
    }, transcriptionArgs())).then(function (r) {
      state.cutsResult = r;
      var ul = $('cuts'); ul.innerHTML = '';
      r.removed.forEach(function (c) {
        var li = document.createElement('li');
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = c.on !== false;
        cb.addEventListener('change', function () { c.on = cb.checked; cutsSummary(); });
        var go = document.createElement('button');
        go.type = 'button'; go.className = 'secondary go'; go.textContent = 'Ir'; go.title = 'Llevar el cursor de Premiere a este corte';
        go.addEventListener('click', function () {
          host('gotoTime', { sec: state.cutsClip.startSec + c.start }).catch(function (e) { status(e.message, true); });
        });
        var tx = document.createElement('span');
        tx.textContent = c.start.toFixed(2) + '–' + c.end.toFixed(2) + ' · ' + c.reason;
        li.appendChild(cb); li.appendChild(tx); li.appendChild(go);
        ul.appendChild(li);
      });
      cutsSummary();
      status('');
      showCuts('result');
    }).catch(function (e) { status(e.message, true); })
      .then(function () { $('btnAnalyze').disabled = false; });
  };

  // ----- Guion -----
  // Visor acotado: el texto pegado ocupa siempre el mismo lugar chico (con scroll), y la etiqueta verde avisa que hay un guion cargado.
  function scriptInfo() {
    var txt = $('scriptText').value, n = txt.trim() ? engine.scriptTokens(txt).length : 0;
    $('scriptBadge').hidden = !n;
    $('scriptBadge').textContent = '✓ pegado · ' + n + (n === 1 ? ' palabra' : ' palabras');
    $('scriptBox').classList.toggle('has', n > 0);
    $('btnScriptClear').hidden = !n;
    return n;
  }
  $('scriptText').addEventListener('input', scriptInfo);
  function loadScriptFile(file) {
    var r = new FileReader();
    r.onload = function () { $('scriptText').value = String(r.result || ''); $('scriptText').scrollTop = 0; scriptInfo(); status('Guion cargado desde ' + file.name + '.'); };
    r.onerror = function () { status('No pude leer ese archivo.', true); };
    r.readAsText(file, 'utf-8');
  }
  $('btnScriptFile').onclick = function () {
    // dentro de Premiere el selector de archivos del panel es el de CEP; en un navegador común, el normal
    var cepFs = window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx;
    if (cepFs && fs) {
      var r = window.cep.fs.showOpenDialogEx(false, false, 'Elegí el guion (.txt)', '', ['txt', 'text']);
      if (r && r.data && r.data[0]) {
        try { $('scriptText').value = fs.readFileSync(r.data[0].replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1'), 'utf8'); $('scriptText').scrollTop = 0; scriptInfo(); status('Guion cargado desde ' + path.basename(r.data[0]) + '.'); }
        catch (e) { status('No pude leer ese archivo: ' + e.message, true); }
      }
      return;
    }
    $('scriptFile').click();
  };
  $('scriptFile').addEventListener('change', function () { if (this.files && this.files[0]) loadScriptFile(this.files[0]); this.value = ''; });
  ['dragover', 'drop'].forEach(function (ev) {
    $('scriptText').addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) loadScriptFile(e.dataTransfer.files[0]);
    });
  });
  $('btnScriptClear').onclick = function () { $('scriptText').value = ''; scriptInfo(); status('Guion quitado.'); };

  function fixButtons() {
    var rw = state.rawWords, r = state.result;
    $('btnUnfixScript').disabled = !(rw && r && r.words && r.words.some(function (w) { return w.fixed; }));
    $('btnFixScript').disabled = !(r && r.words);
  }
  function scriptSummary(st) {
    if (!st) return '';
    return st.corrected ? 'Corregí ' + st.corrected + (st.corrected === 1 ? ' palabra' : ' palabras') + ' con el guion (' + st.matched + ' de ' + st.total + ' coinciden). Las líneas corregidas tienen ✓.'
      : 'El guion coincide con ' + st.matched + ' de ' + st.total + ' palabras y no hizo falta cambiar ninguna.' + (st.matched < st.total / 3 ? ' Ojo: coincide poco; ¿es el guion de este video?' : '');
  }
  // Corregir o deshacer sobre lo ya transcripto, sin volver a transcribir.
  $('btnFixScript').onclick = function () {
    var r = state.result;
    if (!r || !r.words) return;
    if (!$('scriptText').value.trim()) return status('Primero pegá o cargá el guion (en el inicio de Subtítulos).', true);
    if (!state.rawWords) state.rawWords = r.words;
    var res = engine.alignToScript(state.rawWords, $('scriptText').value);
    r.words = res.words;
    regenLines();
    fixButtons();
    status(scriptSummary(res) + ' Se rearmaron los subtítulos.');
  };
  $('btnUnfixScript').onclick = function () {
    var r = state.result;
    if (!r || !state.rawWords) return;
    r.words = state.rawWords;
    regenLines();
    fixButtons();
    status('Volví a la transcripción original, sin el guion.');
  };

  // ----- Subtítulos -----
  $('btnTranscribe').onclick = function () {
    if (needKey()) return status(needKey(), true);
    var sp = setupProblem(true);
    if (sp) return status(sp, true);
    $('btnTranscribe').disabled = true;
    status('Leyendo la secuencia…');
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemycut-'));
    // se vuelve a leer justo antes de transcribir, así nunca se usa una selección vieja
    readClips().then(function (d) {
      var clips = d.clips;
      status('Preparando el audio de ' + clips.length + (clips.length === 1 ? ' clip…' : ' clips…'));
      // el audio se arma con la posición de cada clip en la secuencia, así los tiempos coinciden con la línea de tiempo
      return engine.buildTimelineAudio(clips, path.join(dir, 'timeline.mp3')).then(function (tl) {
        status('Transcribiendo ' + clock(tl.duration) + ' de la secuencia…');
        state.timeline = clips.map(function (c) { return { path: c.path, inSec: c.inSec, speed: c.speed || 1, from: c.startSec - tl.base, to: c.endSec - tl.base }; });
        return engine.analyze(Object.assign({ audio: tl.file, input: clips[0].path, cuts: false, captions: true, autoThresh: true, script: $('scriptText').value, scriptFix: $('scriptFix').checked }, transcriptionArgs()));
      });
    }).then(function (r) {
      state.result = r;
      state.rawWords = r.rawWords || r.words;
      state.frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemycut-frames-'));
      regenLines();
      fixButtons();
      status(scriptSummary(r.scriptStats));
      showSubs('editor');
    }).catch(function (e) { status(e.message, true); })
      .then(function () { $('btnTranscribe').disabled = false; });
  };

  $('btnApply').onclick = function () {
    var r = state.cutsResult, c = state.cutsClip;
    if (!r || !c) return;
    $('btnApply').disabled = true;
    status('Revisando que el clip siga igual en la secuencia…');
    host('checkClip', { name: c.name, startSec: c.startSec, endSec: c.endSec, inSec: c.inRaw !== undefined ? c.inRaw : c.inSec })
      .then(function (chk) {
        if (!chk.found) {
          throw new Error('El clip “' + c.name + '” ya no está en la secuencia como cuando lo analizaste (empezaba en ' + c.startSec.toFixed(2) + ' s' +
            (chk.near ? '; ahora hay uno igual en ' + chk.near : '') + '). Probablemente ya aplicaste estos cortes o lo moviste: seleccioná el clip, apretá “Leer selección” y volvé a analizar.');
        }
        status('Aplicando cortes…');
        return host('applyCuts', { startSec: c.startSec, removed: engine.mergeRanges(checkedCuts().map(function (x) { return { start: x.start, end: x.end, reason: x.reason }; }), 0).map(function (x) { return { start: x.start / (c.speed || 1), end: x.end / (c.speed || 1) }; }) });
      })
      .then(function (d) {
        if (d.removedItems > 0) status('Listo: ' + d.ranges + ' cortes aplicados. Para hacer otro análisis, volvé a leer la selección.');
        else { status('No se pudo cortar ningún tramo (revisá que las pistas no estén bloqueadas).', true); }
      }).catch(function (e) { status(e.message, true); $('btnApply').disabled = false; });
  };

  // Carpeta de trabajo para los archivos generados (fuera de la carpeta del proyecto del usuario).
  function exportDir() {
    var base = os.platform() === 'win32'
      ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
      : path.join(os.homedir(), 'Library', 'Application Support');
    var dir = path.join(base, 'AlchemyCut', 'exports');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  var baseName = function () { return safe(path.basename(state.clip.path, path.extname(state.clip.path))); };

  // Los captions se calcularon sobre el video ya cortado: si todavía no aplicaste los cortes, los tiempos no coinciden.
  $('btnCaptions').onclick = function () {
    if (!state.lines.length) return;
    var srtPath = path.join(exportDir(), 'ac_' + baseName() + '_' + Date.now().toString(36) + '.srt');
    fs.writeFileSync(srtPath, engine.toSrt(state.lines));
    host('addCaptions', { srtPath: srtPath, startSec: state.clip.startSec })
      .then(function (d) { status(d.track ? 'Captions agregados.' : d.note); })
      .catch(function (e) { status(e.message, true); });
  };

  var pad3 = function (n, l) { return String(n).padStart(l || 3, '0'); };

  // PNG liviano: una imagen recortada al texto por línea (o por palabra si hay resaltado/subrayado/aparición).
  // Cada una lleva su posición y, si corresponde, el pop / fundido para que Premiere lo haga con keyframes.
  function renderPngItems(lines, fsz, dir, run) {
    var items = [], count = 0, chain = Promise.resolve();
    lines.forEach(function (line, li) {
      var ps = R.pngStates(line, styleOf(line), minDur());
      ps.states.forEach(function (st, si) {
        chain = chain.then(function () {
          return R.renderStillCropped(fsz.W, fsz.H, line, st.t, ps.style).then(function (img) {
            var file = path.join(dir, 'ac_' + run + '_' + pad3(li + 1) + '_' + pad3(si + 1, 2) + '.png');
            fs.writeFileSync(file, img.buf);
            items.push({ path: file, startSec: state.clip.startSec + st.start, duration: st.end - st.start, cx: img.cx, cy: img.cy, motion: st.motion });
            status('Preparando los subtítulos… ' + (++count) + ' imágenes');
          });
        });
      });
    });
    return chain.then(function () { return items; });
  }

  // Video con transparencia: uno por línea (editables en la secuencia) o uno solo para todo.
  function renderVideoItems(lines, fsz, dir, run) {
    var anyOwn = lines.some(function (l) { return l.sp; });
    var jobs = $('capType').value === 'single' && !anyOwn
      ? [{ lines: lines, offset: 0, startSec: state.clip.startSec, duration: lines[lines.length - 1].end + 0.2 }]
      : lines.map(function (l) { return { lines: [l], offset: l.start, startSec: state.clip.startSec + l.start, duration: Math.max(0.1, l.end - l.start) }; });
    var chain = Promise.resolve();
    jobs.forEach(function (j, i) {
      j.file = path.join(dir, 'ac_' + run + '_' + pad3(i + 1) + '.mov');
      chain = chain.then(function () {
        var enc = engine.startOverlayEncoder({ outFile: j.file, fps: fsz.fps });
        return R.renderOverlay({
          lines: j.lines, W: fsz.W, H: fsz.H, fps: fsz.fps, duration: j.duration, offset: j.offset, style: styleOf(j.lines[0]),
          write: function (buf) { return enc.write(buf); }
        }).then(function () { return enc.end(); }, function (e) { enc.end().catch(function () {}); throw e; })
          .then(function () { status('Preparando los subtítulos… ' + (i + 1) + ' de ' + jobs.length); });
      });
    });
    return chain.then(function () {
      return jobs.map(function (j) { return { path: j.file, startSec: j.startSec, duration: j.duration }; });
    });
  }

  var rendering = false;
  // ---- Registro de lo que se agregó, para poder editarlo después desde la secuencia ----
  // Cada vez que se agregan captions se guarda un manifest.json con las líneas (texto, tiempos, estilo) y qué clip es cada una.
  function saveManifest(run, dir, lines, items, png) {
    try {
      var gsp = state.scopeSel && state.globalSp ? state.globalSp : collectPreset();
      var anyOwn = lines.some(function (l) { return l.sp; });
      var m = {
        v: 1, run: run, base: state.clip.startSec, png: png,
        single: !png && $('capType').value === 'single' && !anyOwn,
        clip: { path: state.clip.path, name: state.clip.name, inSec: state.clip.inSec, width: state.clip.width, height: state.clip.height, fps: state.clip.fps },
        timeline: state.timeline,
        items: items.map(function (it) { return { name: path.basename(it.path), rel: it.startSec - state.clip.startSec }; }),
        lines: lines.map(function (l) {
          return {
            start: l.start, end: l.end, srcStart: l.srcStart, text: l.text,
            words: l.words ? l.words.map(function (w) { return { text: w.text, start: w.start, end: w.end, fixed: w.fixed }; }) : null,
            sp: JSON.parse(JSON.stringify(l.sp || gsp))
          };
        })
      };
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    } catch (e) { /* si no se pudo guardar, solo se pierde la posibilidad de editar esta tanda desde la secuencia */ }
  }
  // nombre del clip → { run, line (0-based; null = todas las de esa tanda), name }
  function parseCaptionName(name) {
    var a = /^ac_(.+)_(\d{3})_(\d{2})\.png$/i.exec(name), b = /^ac_(.+)_(\d{3})\.mov$/i.exec(name);
    if (a) return { run: a[1], idx: +a[2] - 1, name: name };
    if (b) return { run: b[1], idx: +b[2] - 1, name: name, mov: true };
    return null;
  }

  $('btnLoadSeq').onclick = function () {
    status('Leyendo los subtítulos seleccionados…');
    host('getSelectedCaptionClips').then(function (d) {
      if (!d.clips.length) throw new Error('No hay clips de subtítulos de AlchemyCut seleccionados' + (d.total ? ' (seleccionaste ' + d.total + ' clip' + (d.total === 1 ? '' : 's') + ' que no son de AlchemyCut)' : '') + '. Seleccionalos en la secuencia (se llaman “ac_…”) y probá de nuevo.');
      var byRun = {}, bad = 0;
      d.clips.forEach(function (c) {
        var p = parseCaptionName(c.name);
        if (!p) { bad++; return; }
        (byRun[p.run] = byRun[p.run] || []).push({ p: p, clip: c });
      });
      var runs = Object.keys(byRun), loaded = [], missing = 0;
      runs.forEach(function (run) {
        var mf = path.join(exportDir(), run, 'manifest.json'), m = null;
        try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (e) {}
        if (!m) { missing += byRun[run].length; return; }
        // si movieron los clips en la secuencia, se sigue su posición actual
        var shift = null, want = {};
        byRun[run].forEach(function (x) {
          var it = m.items.filter(function (i) { return i.name === x.p.name; })[0];
          if (it && shift === null) shift = x.clip.startSec - (m.base + it.rel);
          if (m.single) m.lines.forEach(function (_l, k) { want[k] = true; }); else if (m.lines[x.p.idx]) want[x.p.idx] = true;
        });
        shift = shift !== null && Math.abs(shift) > 0.05 ? shift : 0;
        Object.keys(want).forEach(function (k) {
          var l = m.lines[+k];
          loaded.push({ run: run, m: m, base: m.base + shift, l: l });
        });
      });
      if (!loaded.length) throw new Error('No encuentro el registro de esos subtítulos (se crearon con una versión anterior o en otra computadora). Volvé a transcribir y agregalos de nuevo.');
      var base0 = Math.min.apply(null, loaded.map(function (x) { return x.base; }));
      var first = loaded[0].m, oneRun = runs.length === 1 || loaded.every(function (x) { return x.run === loaded[0].run; });
      state.clip = Object.assign({}, first.clip, { startSec: base0 });
      state.timeline = oneRun ? (first.timeline || []) : [];
      state.lines = loaded.map(function (x) {
        var off = x.base - base0, l = x.l;
        return {
          sel: true, sp: JSON.parse(JSON.stringify(l.sp)), start: l.start + off, end: l.end + off, srcStart: l.srcStart, text: l.text,
          words: l.words ? l.words.map(function (w) { return { text: w.text, fixed: w.fixed, start: w.start + off, end: w.end + off }; }) : null
        };
      }).sort(function (a, b) { return a.start - b.start; });
      state.result = state.result && state.result.words ? Object.assign({}, state.result) : { words: null };
      state.active = 0; state.lastPick = -1;
      if (!state.frameDir) state.frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemycut-frames-'));
      // se edita solo lo cargado: los cambios de estilo y "agregar" van a las líneas marcadas (todas las cargadas)
      $('addScope').value = 'sel'; $('replacePrev').checked = true;
      $('styleScope').value = 'sel';
      $('styleScope').dispatchEvent(new Event('change'));
      renderCaptions();
      onSelectionChanged();
      showSubs('editor');
      showPane('optTabs', 'optStyle');
      status('Cargué ' + state.lines.length + (state.lines.length === 1 ? ' subtítulo' : ' subtítulos') + ' de la secuencia. Cambiá lo que quieras y, andá a “Agregar” y tocá “Agregar los subtítulos a la secuencia”: reemplaza solo esos.' +
        (missing || bad ? ' (' + (missing + bad) + ' clip' + (missing + bad === 1 ? '' : 's') + ' seleccionado' + (missing + bad === 1 ? '' : 's') + ' sin registro: no se pudieron cargar)' : ''));
    }).catch(function (e) { status(e.message, true); });
  };

  $('btnAnimated').onclick = function () {
    if (rendering || !state.lines.length) return;
    var onlySel = $('addScope').value === 'sel';
    var lines = onlySel ? selectedLines() : state.lines;
    if (!lines.length) return status('Tildá primero los subtítulos que querés agregar (casilla a la izquierda de cada uno).', true);
    var fsz = frameSize(), png = $('outFormat').value === 'png';
    var run = baseName() + '_' + Date.now().toString(36);
    var dir = path.join(exportDir(), run);
    fs.mkdirSync(dir, { recursive: true });
    rendering = true;
    $('btnAnimated').disabled = true;
    // tramos que ocupan las líneas: ahí se borran los captions de AlchemyCut anteriores si se pidió reemplazar
    var ranges = lines.map(function (l) { return { from: state.clip.startSec + l.start, to: state.clip.startSec + l.end }; });
    var replaced = 0;
    var prep = $('replacePrev').checked ? host('removeCaptionClips', { ranges: ranges }).then(function (d) { replaced = d.removed; }) : Promise.resolve();
    status('Preparando los subtítulos…');
    prep.then(function () { return png ? renderPngItems(lines, fsz, dir, run) : renderVideoItems(lines, fsz, dir, run); })
      .then(function (items) {
        saveManifest(run, dir, lines, items, png);
        status('Importando ' + items.length + ' archivos a Premiere…');
        return host('addOverlays', { items: items, track: $('targetTrack').value, bin: 'AlchemyCut ' + run, still: png, W: fsz.W, H: fsz.H });
      })
      .then(function (d) {
        status('Listo: ' + d.placed + ' clips en la pista V' + d.track + (replaced ? ' (reemplazó ' + replaced + ' de antes)' : '') + (d.note ? '. ' + d.note : '.'), d.lost > 0);
      })
      .catch(function (e) { status(e.message, true); })
      .then(function () { rendering = false; $('btnAnimated').disabled = false; });
  };

  // Borrar de la secuencia los subtítulos que se agregaron (de a los seleccionados, o todos). Dos toques para evitar accidentes.
  function armDelete(btn, label, run) {
    var timer = null;
    btn.onclick = function () {
      if (btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1'); btn.textContent = '¿Seguro? Tocá otra vez';
        timer = setTimeout(function () { btn.removeAttribute('data-armed'); btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer); btn.removeAttribute('data-armed'); btn.textContent = label;
      run();
    };
  }
  function removeFromSeq(which) {
    return host('removeCaptions', { which: which }).then(function (d) {
      status(d.removed ? 'Borré ' + d.removed + (d.removed === 1 ? ' clip' : ' clips') + ' de subtítulos de la secuencia. (Ctrl/Cmd + Z lo deshace.)' : (which === 'selected' ? 'No hay clips de subtítulos de AlchemyCut seleccionados en la secuencia.' : 'No encontré subtítulos de AlchemyCut en la secuencia.'), !d.removed);
    }).catch(function (e) { status(e.message, true); });
  }
  armDelete($('btnRemSel'), 'Borrar de la secuencia los que seleccioné', function () { removeFromSeq('selected'); });
  armDelete($('btnRemAll'), 'Borrar de la secuencia todos los de AlchemyCut', function () { removeFromSeq('all'); });

  // Formato: dos botones en vez de un desplegable (en los paneles de Premiere los desplegables a veces no abren)
  Array.prototype.forEach.call(document.querySelectorAll('#outSeg button'), function (b) {
    b.addEventListener('click', function () {
      $('outFormat').value = b.getAttribute('data-v');
      $('outFormat').dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('#cutSeg button'), function (b) {
    b.addEventListener('click', function () {
      $('cutMethod').value = b.getAttribute('data-v');
      $('cutMethod').dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  scriptInfo();
  labels();
  setMode(store('mode') === 'subs' ? 'subs' : 'cuts');
  showCuts('setup');
  showSubs('setup');
})();
