// AlchemyCut — lado Premiere (ExtendScript). Lo llama el panel con evalScript.
// ExtendScript no trae JSON, por eso serializamos a mano; todo vuelve como texto JSON.
var TICKS = 254016000000;

function _json(v) {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return String(v);
  if (t === 'string') {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
  }
  var i, out = [];
  if (v instanceof Array) {
    for (i = 0; i < v.length; i++) out.push(_json(v[i]));
    return '[' + out.join(',') + ']';
  }
  for (var k in v) if (v.hasOwnProperty(k)) out.push(_json(k) + ':' + _json(v[k]));
  return '{' + out.join(',') + '}';
}
function _ok(data) { return _json({ ok: true, data: data }); }
function _err(msg) { return _json({ ok: false, error: msg }); }

// Datos del clip seleccionado en la secuencia activa.
function ac_getSelectedClip() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    var sel = seq.getSelection();
    for (var i = 0; i < sel.length; i++) {
      var c = sel[i];
      if (!c.projectItem) continue;
      var path = c.projectItem.getMediaPath();
      if (!path) continue;
      var seqDur = c.end.seconds - c.start.seconds;
      var srcDur = c.outPoint.seconds - c.inPoint.seconds;
      var ratio1 = seqDur > 0.001 ? srcDur / seqDur : 1;
      var okSpeed = ratio1 > 0.1 && ratio1 < 10;
      return _ok({
        name: c.name, path: path,
        inSec: c.inPoint.seconds, outSec: c.outPoint.seconds,
        startSec: c.start.seconds, endSec: c.end.seconds,
        speed: okSpeed && Math.abs(ratio1 - 1) >= 0.01 ? ratio1 : 1,
        speedMismatch: !okSpeed,
        width: seq.frameSizeHorizontal, height: seq.frameSizeVertical, videoTracks: seq.videoTracks.numTracks,
        fps: Math.round(TICKS / parseFloat(seq.timebase) * 1000) / 1000
      });
    }
    return _err('Seleccioná un clip de la secuencia (video o audio).');
  } catch (e) { return _err(String(e)); }
}

// ¿Sigue estando en la secuencia el clip que se analizó, tal cual (mismo nombre, posición y tramo del archivo)?
// Si ya se aplicaron los cortes o el clip se movió, los tiempos del análisis ya no sirven.
function ac_checkClip(arg) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    var groups = [seq.videoTracks, seq.audioTracks], found = false, near = '';
    for (var g = 0; g < groups.length && !found; g++) {
      for (var t = 0; t < groups[g].numTracks && !found; t++) {
        for (var j = 0; j < groups[g][t].clips.numItems; j++) {
          var c = groups[g][t].clips[j];
          if (c.name !== arg.name) continue;
          if (Math.abs(c.start.seconds - arg.startSec) < 0.05 && Math.abs(c.end.seconds - arg.endSec) < 0.05 && Math.abs(c.inPoint.seconds - arg.inSec) < 0.05) { found = true; break; }
          if (!near) near = c.start.seconds.toFixed(2) + '–' + c.end.seconds.toFixed(2) + ' s';
        }
      }
    }
    return _ok({ found: found, near: near });
  } catch (e) { return _err(String(e)); }
}

// Clips con voz según qué quiere transcribir el usuario. arg: { scope: 'selected' | 'sequence' | 'inout', audioTrack: 0 (automática) | 1..n }
//  selected: los clips seleccionados (un clip de video y su audio vinculado cuentan como uno).
//  sequence: todo lo que hay en la pista de audio elegida (automática = la primera pista de audio con clips que no esté silenciada).
//  inout:    lo mismo, pero solo el tramo entre las marcas de entrada y salida de la secuencia.
// Siempre devuelve tiempos de la secuencia y de qué parte del archivo sale cada tramo; así el panel arma el audio exacto.
function ac_getClips(arg) {
  try {
    arg = arg || {};
    var scope = arg.scope || 'selected';
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    var list = [], seen = {}, skipped = 0, nestedUsed = 0, trackUsed = 0, i, c;
    var isStill = /\.(png|jpe?g|gif|tiff?|psd|bmp|webp|svg)$/i;

    function mediaPath(c) {
      var p = '';
      try { if (c.projectItem) p = c.projectItem.getMediaPath(); } catch (e0) {}
      return p;
    }
    // La secuencia a la que apunta un clip anidado.
    function nestedSeq(pi) {
      var isSeq = false;
      try { isSeq = pi.isSequence(); } catch (e1) {}
      if (!isSeq) return null;
      for (var k = 0; k < app.project.sequences.numSequences; k++) {
        var sq = app.project.sequences[k];
        try { if (sq.projectItem && sq.projectItem.nodeId === pi.nodeId) return sq; } catch (e2) {}
      }
      for (var k2 = 0; k2 < app.project.sequences.numSequences; k2++) {
        if (app.project.sequences[k2].name === pi.name) return app.project.sequences[k2];
      }
      return null;
    }
    function autoTrack(sq) {
      for (var t = 0; t < sq.audioTracks.numTracks; t++) {
        var muted = false; try { muted = sq.audioTracks[t].isMuted(); } catch (e3) {}
        if (!muted && sq.audioTracks[t].clips.numItems > 0) return t;
      }
      return -1;
    }
    // from/to: ventana en el tiempo de la secuencia a la que pertenece el clip (null = sin límite).
    // delta: se suma al tiempo de esa secuencia para llegar al tiempo de la secuencia principal.
    function emit(c, from, to, delta, depth) {
      var st = c.start.seconds, en = c.end.seconds, inS = c.inPoint.seconds;
      // Velocidad del clip: cuántos segundos del archivo se usan por cada segundo de la secuencia (1 = normal, 1.25 = 125 %).
      // Si no se puede saber (clip invertido o con tiempo variable), se marca para avisar.
      var seqDur0 = en - st, srcDur0 = c.outPoint.seconds - c.inPoint.seconds;
      var speed = 1, badSpeed = false;
      if (seqDur0 > 0.001) {
        var ratio = srcDur0 / seqDur0;
        if (ratio > 0.1 && ratio < 10) { speed = Math.abs(ratio - 1) < 0.01 ? 1 : ratio; } else badSpeed = true;
      }
      if (from !== null && st < from) { inS += (from - st) * speed; st = from; }
      if (to !== null && en > to) en = to;
      if (en - st < 0.01) return;
      var path = mediaPath(c);
      if (path) {
        if (isStill.test(path)) return;
        var key = (st + delta).toFixed(3) + '|' + (en + delta).toFixed(3) + '|' + inS.toFixed(3) + '|' + path;
        if (seen[key]) return;
        seen[key] = true;
        list.push({ name: c.name, path: path, inSec: inS, outSec: inS + (en - st) * speed, startSec: st + delta, endSec: en + delta, speed: speed, speedMismatch: badSpeed });
        return;
      }
      // sin archivo: puede ser una secuencia anidada, y el audio está adentro de ella
      var sub = c.projectItem && depth < 4 ? nestedSeq(c.projectItem) : null;
      if (!sub) { skipped++; return; }
      var ti = autoTrack(sub);
      if (ti < 0) { skipped++; return; }
      nestedUsed++;
      var win0 = inS, win1 = inS + (en - st) * speed, tr = sub.audioTracks[ti], n0 = list.length;
      for (var q = 0; q < tr.clips.numItems; q++) {
        var nc = tr.clips[q];
        if (nc.end.seconds <= win0 || nc.start.seconds >= win1) continue;
        emit(nc, win0, win1, delta + st - inS, depth + 1);
      }
      // una secuencia anidada con otra velocidad: los tiempos de adentro no se pueden mapear con una simple suma
      if (speed !== 1 || badSpeed) for (var k0 = n0; k0 < list.length; k0++) list[k0].speedMismatch = true;
    }

    if (scope === 'selected') {
      var sel = seq.getSelection();
      for (i = 0; i < sel.length; i++) emit(sel[i], null, null, 0, 0);
      if (!list.length) return _err('Seleccioná en la secuencia el clip (o los clips) con la voz.');
    } else {
      var from = null, to = null;
      if (scope === 'inout') {
        try { from = seq.getInPointAsTime().seconds; to = seq.getOutPointAsTime().seconds; } catch (e4) { return _err('No pude leer las marcas de entrada y salida de la secuencia.'); }
        if (!(to > from)) return _err('Marcá una entrada (I) y una salida (O) en la secuencia.');
      }
      var tracks = seq.audioTracks, ti0 = arg.audioTrack ? arg.audioTrack - 1 : autoTrack(seq);
      if (ti0 < 0) return _err('No encontré clips de audio en la secuencia.');
      var tr0 = tracks[ti0];
      if (!tr0) return _err('Esa pista de audio no existe.');
      trackUsed = ti0 + 1;
      for (i = 0; i < tr0.clips.numItems; i++) {
        c = tr0.clips[i];
        if (from !== null && (c.end.seconds <= from || c.start.seconds >= to)) continue;
        emit(c, from, to, 0, 0);
      }
      if (!list.length) return _err(scope === 'inout' ? 'No hay clips de audio entre las marcas de entrada y salida.' : 'La pista A' + trackUsed + ' no tiene clips con archivo.');
    }
    list.sort(function (a, b) { return a.startSec - b.startSec; });
    return _ok({
      clips: list, skipped: skipped, nested: nestedUsed, audioTrack: trackUsed, audioTracks: seq.audioTracks.numTracks, scope: scope,
      width: seq.frameSizeHorizontal, height: seq.frameSizeVertical, videoTracks: seq.videoTracks.numTracks,
      fps: Math.round(TICKS / parseFloat(seq.timebase) * 1000) / 1000
    });
  } catch (e) { return _err(String(e)); }
}
function ac_getSelectedClips() { return ac_getClips({ scope: 'selected' }); }

// Borra (sin ripple) los clips que agregó AlchemyCut (nombre ac_*.png / ac_*.mov) cuyo centro cae dentro de alguno de los tramos.
// Así se pueden volver a generar subtítulos corregidos sin dejar los viejos debajo. No toca ningún otro clip.
// arg: { ranges: [{ from, to }] } en segundos de la secuencia.
function ac_removeCaptionClips(arg) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    var ranges = arg.ranges || [], victims = [], t, j, k;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
      for (j = 0; j < seq.videoTracks[t].clips.numItems; j++) {
        var c = seq.videoTracks[t].clips[j];
        if (!/^ac_.*\.(png|mov)$/i.test(c.name)) continue;
        var mid = (c.start.seconds + c.end.seconds) / 2;
        for (k = 0; k < ranges.length; k++) {
          if (mid >= ranges[k].from - 0.001 && mid <= ranges[k].to + 0.001) { victims.push(c); break; }
        }
      }
    }
    var n = 0;
    for (j = victims.length - 1; j >= 0; j--) { try { victims[j].remove(false, false); n++; } catch (e1) {} }
    return _ok({ removed: n, found: victims.length });
  } catch (e) { return _err(String(e)); }
}

function _timecode(sec, tb) {
  var fps = Math.round(TICKS / tb);
  var frames = Math.round(sec * TICKS / tb);
  var ff = frames % fps;
  var s = Math.floor(frames / fps);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60) + ':' + p(ff);
}

function _razorAll(qeSeq, seq, sec) {
  var tb = parseFloat(seq.timebase);
  var tc = _timecode(sec, tb);
  var i;
  for (i = 0; i < qeSeq.numVideoTracks; i++) { try { qeSeq.getVideoTrackAt(i).razor(tc); } catch (e1) {} }
  for (i = 0; i < qeSeq.numAudioTracks; i++) { try { qeSeq.getAudioTrackAt(i).razor(tc); } catch (e2) {} }
}

// Borra con ripple los clips que quedaron completamente dentro de [a, b] (segundos de secuencia).
function _removeBetween(seq, a, b) {
  var eps = 0.5 / 30, n = 0, victims = [], t, j, tracks, clip;
  var groups = [seq.videoTracks, seq.audioTracks];
  for (var g = 0; g < groups.length; g++) {
    tracks = groups[g];
    for (t = 0; t < tracks.numTracks; t++) {
      for (j = 0; j < tracks[t].clips.numItems; j++) {
        clip = tracks[t].clips[j];
        if (clip.start.seconds >= a - eps && clip.end.seconds <= b + eps) victims.push(clip);
      }
    }
  }
  for (j = victims.length - 1; j >= 0; j--) { try { victims[j].remove(true, true); n++; } catch (e) {} }
  return n;
}

// Clips de subtítulos de AlchemyCut (ac_….png / ac_….mov) que están seleccionados en la secuencia.
function ac_getSelectedCaptionClips() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    var sel = seq.getSelection(), out = [], i;
    for (i = 0; i < sel.length; i++) {
      var c = sel[i];
      if (/^ac_.*\.(png|mov)$/i.test(c.name)) out.push({ name: c.name, startSec: c.start.seconds, endSec: c.end.seconds });
    }
    return _ok({ clips: out, total: sel.length });
  } catch (e) { return _err(String(e)); }
}

// Borra de la secuencia los subtítulos de AlchemyCut. arg: { which: 'selected' | 'all' }
// Se borran sin cerrar el hueco (remove(false, false)); Ctrl/Cmd + Z lo deshace.
function ac_removeCaptions(arg) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    var re = /^ac_.*\.(png|mov)$/i, victims = [], i, t, j;
    if (arg && arg.which === 'selected') {
      var sel = seq.getSelection();
      for (i = 0; i < sel.length; i++) if (re.test(sel[i].name)) victims.push(sel[i]);
    } else {
      for (t = 0; t < seq.videoTracks.numTracks; t++) {
        for (j = 0; j < seq.videoTracks[t].clips.numItems; j++) {
          var c = seq.videoTracks[t].clips[j];
          if (re.test(c.name)) victims.push(c);
        }
      }
    }
    var n = 0;
    for (i = victims.length - 1; i >= 0; i--) { try { victims[i].remove(false, false); n++; } catch (e1) {} }
    return _ok({ removed: n, found: victims.length });
  } catch (e) { return _err(String(e)); }
}

// Lleva el cursor de la secuencia a un tiempo (segundos). arg: { sec }
function ac_gotoTime(arg) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    seq.setPlayerPosition(String(Math.round(Math.max(0, arg.sec) * 254016000000)));
    return _ok({ sec: arg.sec });
  } catch (e) { return _err(String(e)); }
}

// arg: { startSec, removed: [{start, end}] }  (start/end relativos al inicio del clip)
function ac_applyCuts(arg) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    var ranges = arg.removed.slice(0).sort(function (x, y) { return y.start - x.start; });
    var removedItems = 0;
    for (var i = 0; i < ranges.length; i++) {
      var a = arg.startSec + ranges[i].start;
      var b = arg.startSec + ranges[i].end;
      _razorAll(qeSeq, seq, b);
      _razorAll(qeSeq, seq, a);
      removedItems += _removeBetween(seq, a, b);
    }
    return _ok({ ranges: ranges.length, removedItems: removedItems });
  } catch (e) { return _err(String(e)); }
}

function _findItem(parent, name) {
  for (var i = 0; i < parent.children.numItems; i++) {
    var it = parent.children[i];
    if (it.name === name || _decode(it.name) === name) return it;
    if (it.type === ProjectItemType.BIN) { var r = _findItem(it, name); if (r) return r; }
  }
  return null;
}

// Importa el .srt al proyecto y, si la versión lo permite, lo crea como pista de captions.
function ac_addCaptions(arg) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    var file = new File(arg.srtPath);
    if (!file.exists) return _err('No existe ' + arg.srtPath);
    app.project.importFiles([arg.srtPath], true, app.project.getInsertionBin(), false);
    var item = _findItem(app.project.rootItem, _decode(file.name));
    if (!item) return _ok({ track: false, note: 'SRT importado al proyecto; arrastralo a la secuencia.' });
    try {
      seq.createCaptionTrack(item, arg.startSec, Sequence.CAPTION_FORMAT_SUBTITLE);
      return _ok({ track: true });
    } catch (e) {
      return _ok({ track: false, note: 'SRT importado al proyecto; arrastralo a la secuencia (' + e + ').' });
    }
  } catch (e) { return _err(String(e)); }
}

// ¿Hay clips en la pista dentro de [a, b]?
function _trackBusy(track, a, b) {
  for (var j = 0; j < track.clips.numItems; j++) {
    var c = track.clips[j];
    if (c.start.seconds < b && c.end.seconds > a) return true;
  }
  return false;
}

// ExtendScript devuelve los nombres de archivo con %XX; los nombres de proyecto no.
function _decode(name) { try { return decodeURIComponent(name); } catch (e) { return name; } }

// Deja el clip que empieza en startSec terminando en endSec. Primero cambia el fin del clip;
// si Premiere no lo acepta, corta con razor y borra la cola. Devuelve true si quedó bien.
// Un cuadro de la secuencia, en segundos. Premiere acomoda cada clip a un cuadro, así que un clip puede quedar hasta un cuadro
// corrido del tiempo pedido; se busca el más cercano en esa ventana (no el primero que entre en 0.05 s).
function _halfFrame(seq) {
  var tb = parseFloat(seq.timebase);
  return tb > 0 ? Math.max(0.01, tb / TICKS) : 0.04;
}
function _trimClip(track, trackIndex, seq, startSec, endSec) {
  var j, tol = _halfFrame(seq) + 0.002;
  var clip = _findClipAt(track, startSec, tol);
  if (!clip) return false;
  if (Math.abs(clip.end.seconds - endSec) < tol) return true;
  try {
    var t = new Time();
    t.seconds = endSec;
    clip.end = t;
    if (Math.abs(clip.end.seconds - endSec) < tol) return true;
  } catch (e1) {}
  try {
    app.enableQE();
    qe.project.getActiveSequence().getVideoTrackAt(trackIndex).razor(_timecode(endSec, parseFloat(seq.timebase)));
    var tails = [];
    for (j = 0; j < track.clips.numItems; j++) {      // solo la cola que dejó el corte, no otros clips de la pista
      if (Math.abs(track.clips[j].start.seconds - endSec) < tol + 0.02) tails.push(track.clips[j]);
    }
    for (j = tails.length - 1; j >= 0; j--) tails[j].remove(false, false);
    return true;
  } catch (e2) { return false; }
}

// ---- Posición y animación (keyframes) de los clips PNG ----
function _findClipAt(track, startSec, tol) {
  tol = tol || 0.03;
  var best = null, bd = 1e9;
  for (var j = track.clips.numItems - 1; j >= 0; j--) {
    var d = Math.abs(track.clips[j].start.seconds - startSec);
    if (d < tol && d < bd) { best = track.clips[j]; bd = d; }
  }
  return best;
}
function _inList(v, list) { for (var i = 0; i < list.length; i++) if (list[i] === v) return true; return false; }
// Los nombres de los efectos cambian con el idioma de Premiere: se busca por nombre (varios idiomas) o por matchName.
function _findComp(clip, names, matchNames) {
  var out = [];
  for (var i = 0; i < clip.components.numItems; i++) {
    var c = clip.components[i], dn = '', mn = '';
    try { dn = c.displayName; } catch (e1) {}
    try { mn = c.matchName; } catch (e2) {}
    out.push(dn);
    if (_inList(dn, names) || _inList(mn, matchNames)) return { comp: c };
  }
  return { comp: null, seen: out.join(', ') };
}
function _findProp(comp, names, idx) {
  for (var j = 0; j < comp.properties.numItems; j++) {
    var dn = '';
    try { dn = comp.properties[j].displayName; } catch (e) {}
    if (_inList(dn, names)) return comp.properties[j];
  }
  return idx !== null && idx < comp.properties.numItems ? comp.properties[idx] : null;
}
function _time(sec) { var t = new Time(); t.seconds = sec; return t; }
// Pone keyframes [[segundos desde el inicio del clip, valor], ...]. Prueba con objetos Time y, si no, con segundos.
function _setKeys(prop, base, keys) {
  prop.setTimeVarying(true);
  for (var k = 0; k < keys.length; k++) {
    var at = base + keys[k][0];
    try { prop.addKey(_time(at)); prop.setValueAtKey(_time(at), keys[k][1], true); }
    catch (e1) { prop.addKey(at); prop.setValueAtKey(at, keys[k][1], true); }
  }
}
// Posiciona el PNG (recortado) en su lugar y le agrega pop / fundido. Devuelve '' si salió bien o el motivo del fallo.
function _animateClip(clip, it, W, H) {
  try {
    var mo = _findComp(clip, ['Motion', 'Movimiento', 'Mouvement', 'Bewegung', 'Movimento'], ['AE.ADBE Motion']);
    if (!mo.comp) return 'no encontré el efecto Movimiento (efectos del clip: ' + mo.seen + ')';
    var pos = _findProp(mo.comp, ['Position', 'Posición', 'Posicion', 'Position', 'Posizione'], 0);
    var scl = _findProp(mo.comp, ['Scale', 'Escala', 'Échelle', 'Skalierung'], 1);
    if (!pos || !scl) return 'no encontré Posición / Escala';
    var cur = pos.getValue(), normalized = (cur[0] <= 2 && cur[1] <= 2);
    pos.setValue(normalized ? [it.cx / W, it.cy / H] : [it.cx, it.cy], true);
    var m = it.motion || {};
    var dur = clip.end.seconds - clip.start.seconds, base = clip.inPoint.seconds;
    var needOp = m.fadeIn || m.fadeOut || m.pop;
    if (m.pop) {
      var d = Math.min(0.2, dur * 0.8);
      _setKeys(scl, base, [[0, 60], [d * 0.5, 108], [d, 100]]);
    } else {
      scl.setValue(100, true);
    }
    if (needOp) {
      var op = _findComp(clip, ['Opacity', 'Opacidad', 'Opacité', 'Deckkraft', 'Opacità'], ['AE.ADBE Opacity']);
      if (!op.comp) return 'no encontré Opacidad';
      var opp = _findProp(op.comp, ['Opacity', 'Opacidad', 'Opacité', 'Deckkraft', 'Opacità'], 0);
      var inD = Math.min(m.fadeIn ? 0.15 : 0.08, dur * 0.4), outD = Math.min(0.12, dur * 0.3), keys = [];
      if (m.fadeIn || m.pop) keys.push([0, 0], [inD, 100]);
      else keys.push([0, 100]);
      if (m.fadeOut) keys.push([dur - outD, 100], [dur, 0]);
      _setKeys(opp, base, keys);
    }
    return '';
  } catch (e) { return String(e); }
}

// Importa los .mov de captions y los coloca en la pista elegida.
// arg: { items: [{ path, startSec, duration }], track: 'auto' | 'new' | '3' }
function ac_addOverlays(arg) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return _err('No hay una secuencia activa.');
    var items = arg.items, i, paths = [];
    if (!items.length) return _err('No hay captions para agregar.');
    for (i = 0; i < items.length; i++) {
      if (!(new File(items[i].path)).exists) return _err('No existe ' + items[i].path);
      paths.push(items[i].path);
    }
    var from = items[0].startSec, to = items[0].startSec + items[0].duration;
    for (i = 1; i < items.length; i++) {
      if (items[i].startSec < from) from = items[i].startSec;
      if (items[i].startSec + items[i].duration > to) to = items[i].startSec + items[i].duration;
    }

    // 1) pista de destino (antes de importar, para no dejar el proyecto a medias si no hay lugar)
    var target = -1, numTracks = seq.videoTracks.numTracks;
    if (arg.track === 'auto') {
      for (var t = numTracks - 1; t >= 0; t--) { if (!_trackBusy(seq.videoTracks[t], from, to)) { target = t; break; } }
      if (target < 0) return _err('No hay una pista de video libre en ese tramo. Elegí “Pista nueva arriba” o liberá una pista.');
    } else if (arg.track === 'new') {
      app.enableQE();
      qe.project.getActiveSequence().addTracks(1, numTracks, 0);
      if (seq.videoTracks.numTracks <= numTracks) return _err('Premiere no pudo crear la pista. Agregá una pista de video a mano y elegila en la lista.');
      target = seq.videoTracks.numTracks - 1;
    } else {
      target = parseInt(arg.track, 10) - 1;
      if (!(target >= 0 && target < numTracks)) return _err('La pista V' + arg.track + ' no existe.');
      if (_trackBusy(seq.videoTracks[target], from, to)) return _err('La pista V' + arg.track + ' ya tiene clips en ese tramo y se pisarían. Elegí otra pista o “Pista nueva arriba”.');
    }

    // 2) importar todo junto en un bin propio y ubicar cada clip en orden cronológico
    var bin;
    try { bin = app.project.rootItem.createBin(arg.bin || 'AlchemyCut captions'); } catch (eBin) { bin = null; }
    if (!bin) bin = app.project.getInsertionBin();
    app.project.importFiles(paths, true, bin, false);
    var byName = {};
    for (var c = 0; c < bin.children.numItems; c++) byName[_decode(bin.children[c].name)] = bin.children[c];
    items.sort(function (x, y) { return x.startSec - y.startSec; });
    var track = seq.videoTracks[target], placed = 0, missing = [], notTrimmed = 0, animFail = 0, animWhy = '';
    for (i = 0; i < items.length; i++) {
      var file = new File(items[i].path);
      var key = _decode(file.name);
      var item = byName[key];
      if (!item) { missing.push(key); continue; }
      var when = new Time();
      when.seconds = items[i].startSec;
      track.overwriteClip(item, when);
      placed++;
      // las imágenes entran con la duración por defecto (unos 5 s): se recorta cada una a lo que dura el caption
      if (arg.still && !_trimClip(track, target, seq, items[i].startSec, items[i].startSec + items[i].duration)) notTrimmed++;
      // posición del PNG recortado y animación de entrada / salida
      if (arg.still && items[i].cx !== undefined) {
        var placedClip = _findClipAt(track, items[i].startSec, _halfFrame(seq) + 0.002);
        var why = placedClip ? _animateClip(placedClip, items[i], arg.W, arg.H) : 'no encontré el clip recién colocado';
        if (why) { animFail++; if (!animWhy) animWhy = why; }
      }
    }
    if (missing.length) return _err('Premiere importó los archivos pero no pude encontrar ' + missing.length + ' en el proyecto (' + missing[0] + ').');
    // comprobación: cada caption tiene que haber quedado en la pista en su lugar
    var lost = 0, tolV = _halfFrame(seq) + 0.002;
    for (i = 0; i < items.length; i++) { if (!_findClipAt(track, items[i].startSec, tolV)) lost++; }
    var notes = [];
    if (lost) notes.push('Ojo: ' + lost + ' de ' + items.length + ' imágenes no quedaron en la pista (suele pasar con palabras que duran muy poco). Revisá la línea de tiempo.');
    if (notTrimmed) notes.push('No pude recortar ' + notTrimmed + ' imágenes a su duración: revisá que no queden captions de más en la pista.');
    if (animFail) notes.push('No pude posicionar / animar ' + animFail + ' clips (' + animWhy + '). Pueden quedar fuera de lugar.');
    return _ok({ track: target + 1, placed: placed, lost: lost, note: notes.join(' ') });
  } catch (e) { return _err(String(e)); }
}
