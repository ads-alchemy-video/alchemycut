'use strict';
// Cortes "precisos": en vez de mirar solo el volumen, usan el momento exacto de cada palabra y, si hay guion,
// eligen la mejor toma de cada frase. Todo acá son funciones puras (sin ffmpeg ni Whisper) para poder probarlas.
const lib = () => require('./lib');

const END_RE = /[.!?…]["')»\]]*$/;
const COMMA_RE = /[,;:—–]["')»\]]*$/;

// ---------- guion en frases ----------
// Cada frase del guion con sus palabras ya normalizadas. Las frases muy cortas ("¡Ya!") se pegan a la siguiente,
// porque una palabra suelta coincidiría con cualquier parte de la grabación.
function scriptSentences(text, minWords = 3) {
  const { foldWord } = lib();
  const lines = String(text || '').replace(/\[[^\]]*\]/g, ' ').split(/\r?\n/)
    .filter((l) => !/^\s*[^.!?¿¡]{1,40}:\s*$/.test(l));
  const raw = [];
  for (const line of lines) {
    const parts = line.match(/[^.!?…]+[.!?…]*["')»]*/g) || [];
    for (const p of parts) if (p.trim()) raw.push(p.trim());
  }
  const toks = (s) => s.split(/\s+/).map((t) => ({ text: t, key: foldWord(t) })).filter((t) => t.key);
  const out = [];
  let acc = null;
  for (const r of raw) {
    const t = toks(r);
    if (!t.length) continue;
    acc = acc ? { text: acc.text + ' ' + r, toks: acc.toks.concat(t) } : { text: r, toks: t };
    if (acc.toks.length >= minWords) { out.push(acc); acc = null; }
  }
  if (acc) { if (out.length) { const last = out[out.length - 1]; last.text += ' ' + acc.text; last.toks = last.toks.concat(acc.toks); } else out.push(acc); }
  return out.map((s) => ({ text: s.text, keys: s.toks.map((t) => t.key) }));
}

// ---------- tomas ----------
// Busca, para cada frase del guion, los tramos de la grabación que la dicen (puede haber varias tomas) y elige
// la mejor toma de cada una respetando el orden del guion. Lo que queda fuera de las tomas elegidas se clasifica:
//   descartada = otra toma de una frase que ya tiene una mejor · fuera = no se parece a nada del guion
//   dudoso = se parece un poco (no se corta sola) · reformulada = frase elegida pero dicha con otras palabras (se queda, se marca)
function matchTakes(rawWords, sentences, { minScore = 0.5, floor = 0.3, goodScore = 0.8 } = {}) {
  const { foldWord, similarity } = lib();
  const n = rawWords.length;
  const keys = rawWords.map((w) => foldWord(w.text));
  const GAP_T = -0.3, MIN_SIM = 0.72;
  const weight = (k) => (k.length >= 4 ? 1 : k.length === 3 ? 0.7 : 0.4);   // las palabras cortas ("de", "la") pesan menos

  const cands = sentences.map((s) => {
    const m = s.keys.length, W = m + 1;
    const wj = s.keys.map(weight);
    const denom = wj.reduce((t, w) => t + 3 * w, 0) || 1;
    const H = new Float32Array((n + 1) * W), ST = new Int32Array((n + 1) * W);
    for (let r = 0; r <= n; r++) ST[r * W] = r;
    for (let j = 1; j <= m; j++) { H[j] = H[j - 1] - 0.5 * wj[j - 1]; ST[j] = 0; }
    for (let r = 1; r <= n; r++) {
      const a = keys[r - 1];
      for (let j = 1; j <= m; j++) {
        let best = H[(r - 1) * W + j] + GAP_T, st = ST[(r - 1) * W + j];
        const left = H[r * W + j - 1] - 0.5 * wj[j - 1];
        if (left > best) { best = left; st = ST[r * W + j - 1]; }
        if (a) {
          const sim = a === s.keys[j - 1] ? 1 : similarity(a, s.keys[j - 1]);
          if (sim >= MIN_SIM) {
            const diag = H[(r - 1) * W + j - 1] + (sim === 1 ? 3 : 3 * sim - 1) * wj[j - 1];
            if (diag >= best) { best = diag; st = ST[(r - 1) * W + j - 1]; }
          }
        }
        H[r * W + j] = best; ST[r * W + j] = st;
      }
    }
    const q = (r) => Math.max(0, Math.min(1, H[r * W + m] / denom));
    const keySet = new Set(s.keys);
    const isHit = (i) => i >= 0 && i < n && keys[i] && (keySet.has(keys[i]) || s.keys.some((k) => similarity(keys[i], k) >= MIN_SIM));
    const found = [];
    for (let r = 1; r <= n; r++) {
      const qr = q(r);
      if (qr < floor || (r < n && qr <= q(r + 1))) continue;
      let from = ST[r * W + m], to = r - 1;
      while (from <= to && !isHit(from)) from++;       // el tramo empieza y termina en una palabra que coincide
      while (to >= from && !isHit(to)) to--;
      if (from > to) continue;
      found.push({ from, to, q: qr });
    }
    found.sort((x, y) => y.q - x.q || y.to - x.to);
    const kept = [];
    for (const c of found) {
      const dup = kept.some((k) => Math.min(k.to, c.to) - Math.max(k.from, c.from) + 1 > 0.5 * Math.min(k.to - k.from + 1, c.to - c.from + 1));
      if (!dup) kept.push(c);
      if (kept.length >= 6) break;
    }
    return kept.sort((x, y) => x.from - y.from);
  });

  // elegir una toma por frase, en orden, maximizando el parecido total (si hay empate, la última toma)
  let states = [{ end: -1, val: 0, path: [] }];
  cands.forEach((list, si) => {
    const next = [];
    for (const st of states) {
      next.push({ end: st.end, val: st.val, path: st.path.concat([null]) });
      for (const c of list) {
        if (c.q < minScore || c.from <= st.end) continue;
        next.push({ end: c.to, val: st.val + c.q + 0.001 * (c.to / Math.max(1, n)), path: st.path.concat([{ si, ...c }]) });
      }
    }
    next.sort((a, b) => a.end - b.end || b.val - a.val);
    states = [];
    let top = -Infinity;
    for (const s of next) if (s.val > top + 1e-9) { states.push(s); top = s.val; }
  });
  const best = states.reduce((a, b) => (b.val > a.val ? b : a), states[0]);
  const chosen = best.path.filter(Boolean);
  const missing = best.path.map((p, si) => (p ? -1 : si)).filter((x) => x >= 0);

  const inSpan = new Array(n).fill(false);
  chosen.forEach((c) => { for (let i = c.from; i <= c.to; i++) inSpan[i] = true; });
  // Una frase reformulada casi nunca empieza ni termina en una palabra del guion: se le suman las palabras pegadas
  // (sin pausa larga) para no dejar la mitad de la frase fuera de la toma.
  const near = (a, b) => rawWords[b].start - rawWords[a].end < 0.5;
  chosen.filter((c) => c.q < goodScore).forEach((c) => {
    for (let k = 0; k < 6 && c.from > 0 && !inSpan[c.from - 1] && near(c.from - 1, c.from); k++) { c.from--; inSpan[c.from] = true; }
    for (let k = 0; k < 6 && c.to < n - 1 && !inSpan[c.to + 1] && near(c.to, c.to + 1); k++) { c.to++; inSpan[c.to] = true; }
  });
  // lo que queda fuera de las tomas se separa en "enunciados" (una pausa larga corta el tramo)
  const stretches = [];
  const chosenSorted = chosen.slice().sort((a, b) => a.from - b.from);
  if (chosen.length) {
    for (let i = 0; i < n;) {
      if (inSpan[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && !inSpan[j + 1] && rawWords[j + 1].start - rawWords[j].end < 0.8) j++;
      let qBest = 0, qRetake = 0;
      cands.forEach((list, si) => list.forEach((c) => {
        if (chosen.some((k) => k.from === c.from && k.to === c.to)) return;
        if (Math.min(c.to, j) - Math.max(c.from, i) < 0) return;
        qBest = Math.max(qBest, c.q);
        const mine = chosen.find((k) => k.si === si);
        if (mine && mine.from > j) qRetake = Math.max(qRetake, c.q);     // la misma frase se volvió a decir después: esto es un intento anterior
      }));
      // ¿ocupa el lugar de una frase que no se encontró? (puede ser esa frase dicha con otras palabras)
      let slot = -1;
      for (const si of best.path.map((p, k) => (p ? -1 : k)).filter((x) => x >= 0)) {
        const prev = chosenSorted.filter((c) => c.si < si).pop(), next = chosenSorted.find((c) => c.si > si);
        if (i > (prev ? prev.to : -1) && j < (next ? next.from : n)) { slot = si; break; }
      }
      let kind = qBest >= minScore || qRetake >= floor ? 'descartada' : qBest >= floor ? 'dudoso' : 'fuera';
      if (kind === 'fuera' && (slot >= 0 || j - i + 1 > 8)) kind = 'dudoso';      // largo o en el lugar de una frase: lo decide la persona
      stretches.push({ from: i, to: j, q: Math.max(qBest, qRetake), kind, slot });
      i = j + 1;
    }
    // si varios tramos caen en el lugar de una misma frase faltante, solo el más largo es "su versión distinta"; los demás son otra cosa
    const bySlot = new Map();
    stretches.filter((t) => t.slot >= 0 && t.kind === 'dudoso' && t.q < floor).forEach((t) => {
      const cur = bySlot.get(t.slot);
      if (!cur || t.to - t.from > cur.to - cur.from) bySlot.set(t.slot, t);
    });
    stretches.forEach((t) => { if (t.slot >= 0 && t.kind === 'dudoso' && t.q < floor && bySlot.get(t.slot) !== t) { t.kind = t.to - t.from + 1 > 8 ? 'dudoso' : 'fuera'; t.slot = -1; } });
  }
  const flagged = chosen.filter((c) => c.q < goodScore).map((c) => ({ si: c.si, q: c.q, from: c.from, to: c.to }));
  return { chosen, stretches, missing, flagged, sentences: sentences.length };
}

// ---------- pausas ----------
function pauseKind(text, gap, havePunct) {
  if (END_RE.test(text)) return 'frase';
  if (COMMA_RE.test(text)) return 'coma';
  if (!havePunct && gap >= 0.5) return 'frase';       // sin puntuación (OpenAI, por ejemplo) se adivina por el largo de la pausa
  return 'palabra';
}

// Recorta cada hueco entre palabras que se quedan al largo de pausa que corresponde. `drop` dice qué palabras se van
// (muletillas, tomas descartadas…); lo que haya entre dos palabras que se quedan se comprime junto.
// guard(a, b) (opcional) devuelve true si en ese tramo hay audio fuerte que Whisper no transcribió: ahí no se corta.
function planPauses(words, duration, drop, o = {}) {
  const {
    keepEnd = 0.3, keepComma = 0.15, keepWord = 0.06, minGap = 0.3, headKeep = 0.15, tailKeep = 0.25, minRemoval = 0.08, minLeft = 0.08,
    guard = null, quietAt = null,
  } = o;
  const { foldWord } = lib();
  const real = (i) => foldWord(words[i].text) !== '';          // los signos sueltos no son palabras
  const kept = [];
  for (let i = 0; i < words.length; i++) if (!drop.has(i) && real(i)) kept.push(i);
  const havePunct = words.filter((w) => /[.,;:!?…]$/.test(w.text)).length >= Math.max(2, words.length * 0.03);
  const ranges = [], skipped = [];
  if (!kept.length) return { ranges, skipped, kept };
  const label = (a, b) => {
    const why = new Map();
    for (let i = a + 1; i < b; i++) if (drop.has(i) && real(i)) { const d = drop.get(i); if (!why.has(d.reason)) why.set(d.reason, []); why.get(d.reason).push(words[i].text); }
    return [...why.entries()].map(([r, ws]) => `${r}: «${ws.slice(0, 6).join(' ')}${ws.length > 6 ? '…' : ''}»`).join(' + ');
  };
  const push = (start, end, reason, extra = {}) => { if (end - start >= minRemoval) ranges.push({ start, end, reason, ...extra }); };

  // El tiempo de Whisper por palabra puede errar por décimas de segundo: el silencio de verdad se mide en el audio.
  const STEP = 0.01, TOL = 0.25;
  // el tramo callado (continuo) que más se superpone con [a, b]; puede salirse un poco de [a, b]
  const quietRun = (a, b) => {
    if (!quietAt) return { start: a, end: b };
    let bestRun = null, run = null;
    for (let t = Math.max(0, a - TOL); t <= Math.min(duration, b + TOL) + 1e-9; t += STEP) {
      if (quietAt(t)) { if (!run) run = { start: t, end: t }; run.end = t + STEP; }
      else if (run) { run = fin(run, a, b); if (!bestRun || run.ov > bestRun.ov) bestRun = run; run = null; }
    }
    if (run) { run = fin(run, a, b); if (!bestRun || run.ov > bestRun.ov) bestRun = run; }
    return bestRun && bestRun.ov > 0.02 ? { start: bestRun.start, end: bestRun.end } : null;
  };
  function fin(r, a, b) { return { ...r, ov: Math.max(0, Math.min(r.end, b) - Math.max(r.start, a)) }; }
  // borde de un corte que borra palabras: se acerca al primer momento callado cerca del tiempo de Whisper
  const edge = (t, dir) => {
    if (!quietAt) return t;
    for (let d = 0; d <= 0.3; d += STEP) { const x = t + dir * d; if (quietAt(x) && quietAt(x + dir * 0.03)) return x; }
    return t;
  };
  // principio y final: el primer y último momento con voz según el audio, si coinciden con la primera/última palabra
  const first = words[kept[0]], last = words[kept[kept.length - 1]];
  let headEdge = first.start, tailEdge = last.end;
  if (quietAt && kept[0] === 0) {
    let t0 = 0; while (t0 < duration && quietAt(t0)) t0 += STEP;
    if (t0 < duration && t0 <= first.end && t0 >= first.start - 0.5) headEdge = t0;
  }
  if (quietAt && kept[kept.length - 1] === words.length - 1) {
    let t1 = duration; while (t1 > 0 && quietAt(t1 - STEP)) t1 -= STEP;
    if (t1 > 0 && t1 >= last.start && t1 <= last.end + 0.5) tailEdge = t1;
  }
  push(0, headEdge - headKeep, kept[0] > 0 && label(-1, kept[0]) ? label(-1, kept[0]) : 'silencio al principio');
  push(tailEdge + tailKeep, duration, kept[kept.length - 1] < words.length - 1 && label(kept[kept.length - 1], words.length) ? label(kept[kept.length - 1], words.length) : 'silencio al final');

  for (let x = 0; x + 1 < kept.length; x++) {
    const a = kept[x], b = kept[x + 1], wa = words[a], wb = words[b];
    const gap = wb.start - wa.end;
    if (gap <= 0 && b - a === 1) continue;
    const droppedBetween = b - a > 1 && label(a, b);
    let tail = wa.text;                                       // la puntuación puede venir en un signo suelto
    for (let i = a + 1; i < b && !real(i); i++) tail += words[i].text;
    const kind = pauseKind(tail, Math.max(gap, 0), havePunct);
    const keep = { frase: keepEnd, coma: keepComma, palabra: keepWord }[kind];
    const left = Math.max(keep, minLeft);
    if (droppedBetween) {
      const s0 = edge(wa.end, +1), e0 = edge(wb.start, -1);
      push(Math.min(s0, e0) + left / 2, Math.max(s0, e0) - left / 2, droppedBetween);
      continue;
    }
    if (gap < minGap) continue;
    if (gap - left < minRemoval) continue;
    if (guard && gap > 0.5 && guard(wa.end, wb.start)) { skipped.push({ start: wa.end, end: wb.start, why: 'hay audio sin transcribir' }); continue; }
    const run = quietRun(wa.end, wb.start);
    if (!run) { if (gap > 0.5) skipped.push({ start: wa.end, end: wb.start, why: 'no hay un silencio claro' }); continue; }
    if (run.end - run.start - left < minRemoval) continue;
    push(run.start + left / 2, run.end - left / 2, `pausa de ${(run.end - run.start).toFixed(2)} s → ${left.toFixed(2)} s (${kind})`);
  }
  ranges.sort((x, y) => x.start - y.start);
  return { ranges, skipped, kept };
}

// ---------- plan completo ----------
// words: palabras con tiempo (con la puntuación del guion donde coincidió) · rawWords: lo que dijo Whisper, mismo orden.
// Devuelve los rangos a quitar (checked) y los dudosos (opcionales) con su explicación.
function planSmart({ words, rawWords, duration, script = '', takes = false, takeMin = 0.5, cutOffScript = true, dropWords = [], guard = null, ...pauseOpts }) {
  const index = new Map(words.map((w, i) => [w, i]));
  const drop = new Map();
  for (const d of dropWords) {                                // { words:[obj], reason }
    for (const w of d.words) { const i = index.get(w); if (i !== undefined && !drop.has(i)) drop.set(i, { reason: d.reason }); }
  }
  let takeInfo = null;
  const optional = [];
  if (takes && script && script.trim() && words.length) {
    const sentences = scriptSentences(script);
    const m = matchTakes(rawWords || words, sentences, { minScore: takeMin });
    takeInfo = { sentences: m.sentences, chosen: m.chosen.length, missing: m.missing.map((si) => sentences[si].text), flagged: m.flagged.map((f) => ({ text: sentences[f.si].text, q: f.q })), unrelated: m.sentences > 0 && !m.chosen.length };
    for (const s of m.stretches) {
      const text = words.slice(s.from, s.to + 1).map((w) => w.text).join(' ');
      const short = text.length > 60 ? text.slice(0, 57) + '…' : text;
      if (s.kind === 'dudoso') {
        const why = s.slot >= 0 ? `posible versión distinta de «${sentences[s.slot].text.slice(0, 50)}»` : 'no seguro';
        optional.push({ start: words[s.from].start, end: words[s.to].end, reason: `${why}: «${short}»`, on: false, kind: 'dudoso' });
      } else if (s.kind === 'descartada' || cutOffScript) {
        const reason = s.kind === 'descartada' ? 'toma descartada' : 'fuera del guion';
        for (let i = s.from; i <= s.to; i++) if (!drop.has(i)) drop.set(i, { reason });
      }
    }
  }
  const pauses = planPauses(words, duration, drop, { ...pauseOpts, guard });
  return { ranges: pauses.ranges, optional, skipped: pauses.skipped, dropped: [...drop.keys()].map((i) => words[i]), takeInfo, keptWords: pauses.kept.length };
}

module.exports = { scriptSentences, matchTakes, planPauses, planSmart, pauseKind };
