'use strict';
// node test/logic.test.js  — prueba planCuts / muletillas / captions con palabras simuladas.
const assert = require('assert');
const { atempoChain, wordsFromTokens, snapToSpeech, dtwPreset, scriptSentences, matchTakes, planPauses, planSmart, planCuts, buildCaptions, toSrt, remapTime, findRepeats, findQuietLevels, alignToScript, scriptPrompt } = require('../engine/lib');

const words = [
  { text: 'Hola,', start: 0.2, end: 0.6 },
  { text: 'eh', start: 0.7, end: 0.95 },
  { text: 'este', start: 1.0, end: 1.3 },
  { text: 'es', start: 1.35, end: 1.5 },
  { text: 'un', start: 1.5, end: 1.6 },
  { text: 'video.', start: 1.6, end: 2.1 },
  { text: 'O', start: 5.0, end: 5.1 },
  { text: 'sea', start: 5.1, end: 5.4 },
  { text: 'seguimos.', start: 5.5, end: 6.2 },
];

const plan = planCuts({
  duration: 7,
  silences: [{ start: 2.2, end: 4.9 }],
  words,
  fillers: 'es',
  pad: 0.1,
});

assert.deepStrictEqual(
  plan.removed.map((r) => [+r.start.toFixed(2), +r.end.toFixed(2)]),
  [[0.7, 0.95], [2.3, 4.8], [5.0, 5.4]],
);
assert.ok(plan.removed[0].reason.startsWith('muletilla: eh'));
assert.ok(plan.removed[2].reason === 'muletilla: o sea');
assert.ok(Math.abs(plan.saved - (0.25 + 2.5 + 0.4)) < 1e-9);
// keep + removed cubren todo el tramo sin solaparse
const total = plan.keep.reduce((n, k) => n + k.end - k.start, 0) + plan.saved;
assert.ok(Math.abs(total - 7) < 0.05);

// 5.5 (justo después de "o sea") pierde 0.25 + 2.5 + 0.4 de lo cortado antes
assert.strictEqual(+remapTime(5.5, plan.removed).toFixed(2), 2.35);
assert.strictEqual(+remapTime(1.0, plan.removed).toFixed(2), 0.75);

const lines = buildCaptions(words, plan.removed, { dropped: plan.dropped });
const text = lines.map((l) => l.text).join(' | ');
assert.ok(!/\beh\b/.test(text) && !/sea/.test(text), 'las muletillas no deben estar en los captions: ' + text);
assert.ok(lines.every((l, i) => i === 0 || l.start >= lines[i - 1].end - 1e-9), 'captions ordenados');
assert.ok(lines[lines.length - 1].end <= 7 - plan.saved + 1e-9);
assert.match(toSrt(lines), /^1\n00:00:00,\d{3} --> /);

// Whisper estira una palabra real sobre un silencio: no debe perderse en los captions
const stretched = [
  { text: 'prueba.', start: 1.5, end: 4.5 },
  { text: 'Y', start: 4.5, end: 4.6 },
];
const p2 = planCuts({ duration: 6, silences: [{ start: 2.2, end: 4.2 }], words: stretched, fillers: 'es' });
assert.deepStrictEqual(
  buildCaptions(stretched, p2.removed, { dropped: p2.dropped }).map((l) => l.text),
  ['prueba.', 'Y'],
);

// Cortes de lectura natural: una línea, nunca más de maxChars, sin terminar en artículo/preposición
const sentence = 'Si estás cansado de perder horas editando cada video, vas a querer ver cómo funciona esta herramienta de la que todos hablan.'
  .split(' ')
  .map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 }));
for (const maxChars of [20, 28, 40]) {
  const out = buildCaptions(sentence, [], { maxChars });
  assert.strictEqual(out.map((l) => l.text).join(' '), sentence.map((w) => w.text).join(' '), 'no se pierde ninguna palabra');
  out.forEach((l) => {
    assert.ok(!l.text.includes('\n') && l.text.length <= maxChars, `línea larga (${maxChars}): ${l.text}`);
  });
  // es una preferencia, no una regla dura: con líneas muy cortas puede quedar alguna
  const weakEnds = out.filter((l) => /\b(de|la|el|que|a|en|y)$/i.test(l.text));
  assert.ok(weakEnds.length <= (maxChars < 24 ? 1 : 0), `terminan en palabra débil (${maxChars}): ${weakEnds.map((l) => l.text)}`);
  const comma = out.findIndex((l) => l.text.endsWith('video,'));
  assert.ok(comma >= 0, 'corta después de la coma');
}
// dos líneas: reparte equilibrado
const two = buildCaptions(sentence.slice(0, 11), [], { maxChars: 28, maxLines: 2 });
assert.ok(two.every((l) => l.text.split('\n').length <= 2 && l.text.split('\n').every((s) => s.length <= 28)));
console.log(buildCaptions(sentence, [], { maxChars: 28 }).map((l) => l.text).join(' | '));


// ---- repeticiones ----
const mk = (txt, t0, step = 0.3) => txt.split(' ').map((text, i) => ({ text, start: t0 + i * step, end: t0 + i * step + step * 0.9 }));
{
  // toma abandonada y repetida enseguida: se borra la primera, queda la segunda
  const take1 = mk('Si estás cansado de perder', 0), take2 = mk('Si estás cansado de perder horas editando cada video', 3);
  const rep = findRepeats([...take1, ...take2], { minWords: 4, maxGap: 12 });
  assert.strictEqual(rep.ranges.length, 1);
  assert.ok(Math.abs(rep.ranges[0].start - 0) < 1e-9 && Math.abs(rep.ranges[0].end - 3) < 1e-9, 'borra desde la primera toma hasta donde empieza la segunda');
  assert.strictEqual(rep.words.length, 5);
  // tres tomas: quedan solo la última
  const three = findRepeats([...mk('Hola a todos bienvenidos al canal', 0), ...mk('Hola a todos bienvenidos al canal de hoy', 4), ...mk('Hola a todos bienvenidos al canal de hoy amigos', 9)], { minWords: 4 });
  assert.strictEqual(three.ranges.length, 2);
  assert.ok(Math.abs(three.ranges[1].end - 9) < 1e-9);
  // una expresión corta que se repite a propósito no se toca
  const keep = findRepeats([...mk('promociones hasta el 30% de descuento', 0), ...mk('Tenemos hasta el 30% off en toda la tienda', 3)], { minWords: 4 });
  assert.strictEqual(keep.ranges.length, 0, 'no confunde "hasta el 30%" con una toma repetida');
  // lejos en el tiempo: no es una repetición inmediata
  const far = findRepeats([...mk('Si estás cansado de perder horas', 0), ...mk('Si estás cansado de perder horas', 60)], { minWords: 4, maxGap: 12 });
  assert.strictEqual(far.ranges.length, 0);
}

// ---- voces bajas por nivel ----
{
  const RATE = 16000, secs = 20, pcm = new Int16Array(RATE * secs);
  // 0–8 s voz fuerte (pico ≈ -11 dB), 8–14 s voz baja (pico ≈ -36 dB), 14–20 s fuerte; con un golpe corto a los 10 s
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE, loud = t < 8 || t >= 14 || (t >= 10 && t < 10.1);
    pcm[i] = Math.round(Math.sin(i * 0.3) * (loud ? 9000 : 500));
  }
  // una cola de frase: cae a nivel bajo solo 0.4 s y vuelve la voz fuerte
  for (let i = Math.round(5 * RATE); i < Math.round(5.4 * RATE); i++) pcm[i] = Math.round(Math.sin(i * 0.3) * 500);
  const q = findQuietLevels(pcm, { thresholdDb: -24, minDur: 1.0 });
  assert.strictEqual(q.ranges.length, 1, 'un solo tramo bajo (el golpe corto no lo parte y la cola de 0.4 s no cuenta)');
  assert.ok(q.ranges[0].start >= 7.9 && q.ranges[0].start <= 8.2 && q.ranges[0].end >= 13.8 && q.ranges[0].end <= 14.1);
  assert.ok(q.mainPeak > -14 && q.mainPeak < -8, 'mide el pico de la voz principal');
  // una frase corta fuerte entre dos pausas largas no se junta con ellas
  const pcm2 = new Int16Array(RATE * 8);
  for (let i = 0; i < pcm2.length; i++) { const t = i / RATE; pcm2[i] = Math.round(Math.sin(i * 0.3) * ((t >= 2.5 && t < 3.5) || t >= 6 ? 9000 : 500)); }
  assert.strictEqual(findQuietLevels(pcm2, { thresholdDb: -24 }).ranges.length, 2, 'las dos pausas quedan separadas y la frase se conserva');
  // si el umbral está por debajo del nivel bajo, no se borra nada
  assert.strictEqual(findQuietLevels(pcm, { thresholdDb: -45 }).ranges.length, 0);
}

// ---- guion ----
{
  const mkw = (txt) => txt.split(' ').map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.35 }));
  const script = 'HOOK 1:\n[Voz en off] En Mandarin Rose comenzamos noviembre con una de nuestras mejores promociones, hasta el 30% de descuento. ¿Qué esperás? Entrá al link.\nCTA:\nOtro hook que no se grabó.';
  const heard = mkw('En mandarín rosa comenzamos noviembre con una de nuestras mejores promociones hasta el 30% de descuento que esperas entra al link');
  const r = alignToScript(heard, script);
  const out = r.words.map((w) => w.text).join(' ');
  assert.strictEqual(out, 'En Mandarin Rose comenzamos noviembre con una de nuestras mejores promociones, hasta el 30% de descuento ¿Qué esperás? Entrá al link.'.replace('descuento ¿Qué', 'descuento. ¿Qué'));
  assert.ok(r.corrected >= 4, 'corrige mandarin, rose, qué, esperás, entrá');
  assert.deepStrictEqual(r.words.map((w) => w.start), heard.map((w) => w.start), 'conserva los tiempos');
  // lo que no está en el guion queda como se dijo
  const extra = alignToScript(mkw('muy bien repetimos la toma en Mandarin Rose comenzamos noviembre'), script);
  assert.ok(extra.words.slice(0, 5).map((w) => w.text).join(' ') === 'muy bien repetimos la toma', 'las indicaciones no se tocan');
  assert.strictEqual(extra.words[6].text, 'Mandarin');
  // guion vacío o ajeno: no cambia nada
  assert.strictEqual(alignToScript(heard, '').corrected, 0);
  assert.strictEqual(alignToScript(mkw('hola que tal como estas hoy'), 'zzz yyy xxx www').corrected, 0);
  // pista para el transcriptor: nombres propios y cifras, no el guion entero
  const hint = scriptPrompt(script);
  assert.ok(/Mandarin Rose/.test(hint) && /30%/.test(hint) && !/Otro hook/.test(hint), hint);
}

{
  // una palabra suelta del video parecida a una del guion que está en otra parte no se toca
  const mkw2 = (txt) => txt.split(' ').map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.35 }));
  const r = alignToScript(mkw2('Tenemos hasta el treinta off en toda la tienda'), 'Si te gusta lo barato, entra al link.');
  assert.strictEqual(r.corrected, 0);
}


// ---------- cortes precisos: pausas, tomas y guion ----------
{
  // palabras de prueba: cada una dura 0.3 s y la pausa se indica aparte
  const build = (spec) => { let t = 0.4; return spec.map(([text, gapAfter = 0.08]) => { const w = { text, start: t, end: t + 0.3 }; t += 0.3 + gapAfter; return w; }); };
  const SCRIPT = 'Hola, esto es una prueba larga del producto nuevo. Aprovechá la oferta de hoy en la tienda online. Gracias por mirar el video completo.';

  // frases del guion: las muy cortas se pegan a la siguiente
  const ss = scriptSentences('HOOK 1:\nHola. Esto es una prueba larga del producto. [pausa] Mirá esto ahora mismo.\n¡Ya!');
  assert.strictEqual(ss.length, 2, JSON.stringify(ss.map((x) => x.text)));
  assert.ok(ss.every((x) => x.keys.length >= 3));

  // pausas según la puntuación: más largo después de un punto que de una coma o entre palabras
  const w1 = build([['Hola,', 0.7], ['esto', 0.7], ['es', 0.08], ['una', 0.9], ['prueba.', 0.9], ['Gracias', 0.1]]);
  const dur = w1[w1.length - 1].end + 3;
  const p1 = planPauses(w1, dur, new Map(), {});
  const cutAt = (a, b) => p1.ranges.find((r) => r.start >= a.end && r.end <= b.start);
  const after = (i) => cutAt(w1[i], w1[i + 1]);
  const left = (i) => { const r = after(i); return r ? (w1[i + 1].start - w1[i].end) - (r.end - r.start) : null; };
  assert.ok(Math.abs(left(0) - 0.15) < 0.01, 'coma deja 0.15: ' + left(0));          // Hola, → 0.7 s a 0.15
  assert.ok(Math.abs(left(1) - 0.08) < 0.01, 'palabra deja 0.08: ' + left(1));         // esto → 0.7 s a 0.08
  assert.strictEqual(after(2), undefined);                                             // 0.08 s < minGap: no se toca
  assert.ok(Math.abs(left(4) - 0.3) < 0.01, 'punto deja 0.30: ' + left(4));           // prueba. → 0.9 s a 0.3
  const head = p1.ranges[0];                                                           // el comienzo queda con 0.15 s de aire
  assert.ok(head.start === 0 && Math.abs(head.end - (w1[0].start - 0.15)) < 1e-9, JSON.stringify(head));
  // el silencio largo del final se corta, dejando un poco de aire
  const tail = p1.ranges[p1.ranges.length - 1];
  assert.ok(tail.end === dur && tail.start > w1[w1.length - 1].end, 'corta el final');
  // nunca se corta adentro de una palabra
  for (const r of p1.ranges) for (const w of w1) assert.ok(r.end <= w.start + 1e-9 || r.start >= w.end - 1e-9, `corte ${r.start}-${r.end} pisa «${w.text}»`);

  // una palabra que se va (muletilla) junta sus dos huecos en una sola pausa
  const w2 = build([['Bueno', 0.2], ['eh', 0.2], ['vamos', 0.1]]);
  const p2 = planPauses(w2, w2[2].end + 0.1, new Map([[1, { reason: 'muletilla' }]]), {});
  const mid = p2.ranges.filter((r) => r.start > w2[0].end);
  assert.strictEqual(mid.length, 1);
  assert.ok(mid[0].reason.indexOf('muletilla') > -1 && mid[0].end < w2[2].start);

  // audio fuerte sin transcribir: la pausa larga no se corta y queda registrada
  const w3 = build([['uno', 1.6], ['dos', 0.1]]);
  const p3 = planPauses(w3, w3[1].end + 0.1, new Map(), { guard: () => true });
  assert.strictEqual(p3.ranges.filter((r) => r.start > w3[0].end).length, 0);
  assert.strictEqual(p3.skipped.length, 1);

  // ---- tomas con guion ----
  // Aprovechá... dicha mal, "a ver", la toma buena, el cierre
  const said = 'Hola esto es una prueba larga del producto nuevo a ver aprovechá la ofer aprovechá la oferta de hoy en la tienda online gracias por mirar el video completo listo corte'.split(' ');
  const wt = build(said.map((t) => [t, 0.1]));
  const m = matchTakes(wt, scriptSentences(SCRIPT));
  assert.strictEqual(m.chosen.length, 3, JSON.stringify(m.chosen));
  assert.strictEqual(m.missing.length, 0);
  const second = m.chosen[1];
  assert.strictEqual(wt[second.from].text, 'aprovechá');
  assert.ok(second.from >= 14, 'queda la última toma (la completa): ' + second.from);
  const kinds = m.stretches.map((s) => s.kind + ':' + wt.slice(s.from, s.to + 1).map((w) => w.text).join(' '));
  assert.ok(kinds.some((k) => /^(fuera|descartada|dudoso):a ver aprovechá la ofer$/.test(k)), kinds.join(' | '));
  assert.ok(kinds.some((k) => /^fuera:listo corte$/.test(k)), kinds.join(' | '));

  // plan completo: se va la toma mala, "a ver" y "listo corte"; las pausas se comprimen
  const plan = planSmart({ words: wt, rawWords: wt, duration: wt[wt.length - 1].end + 1, script: SCRIPT, takes: true });
  const dropped = plan.dropped.map((w) => w.text).join(' ');
  assert.ok(/a ver/.test(dropped) && /listo corte/.test(dropped) && !/producto|oferta|completo/.test(dropped), dropped);
  assert.ok(plan.ranges.some((r) => /fuera del guion|toma descartada/.test(r.reason)));

  // frase reformulada: se queda y se marca
  const para = build('Hola esto es una prueba larga del producto nuevo no te pierdas la promo de hoy en la tienda online gracias por mirar el video completo'.split(' ').map((t) => [t, 0.1]));
  const mp = matchTakes(para, scriptSentences(SCRIPT));
  assert.strictEqual(mp.chosen.length, 3);
  assert.ok(mp.flagged.length >= 1 && mp.flagged[0].si === 1, JSON.stringify(mp.flagged));
  const pp = planSmart({ words: para, rawWords: para, duration: para[para.length - 1].end + 1, script: SCRIPT, takes: true });
  assert.ok(!/pierdas|promo/.test(pp.dropped.map((w) => w.text).join(' ')), 'la reformulada no se borra');

  // una grabación que no tiene nada que ver con el guion no se toca
  const other = build('el clima de mañana estará soleado con vientos suaves del norte durante toda la tarde'.split(' ').map((t) => [t, 0.1]));
  const po = planSmart({ words: other, rawWords: other, duration: other[other.length - 1].end + 1, script: SCRIPT, takes: true });
  assert.strictEqual(po.dropped.length, 0);
  assert.ok(po.takeInfo.unrelated);

  // fuera del guion se puede dejar: queda solo en las pausas
  const keepOff = planSmart({ words: wt, rawWords: wt, duration: wt[wt.length - 1].end + 1, script: SCRIPT, takes: true, cutOffScript: false });
  assert.ok(!/listo corte/.test(keepOff.dropped.map((w) => w.text).join(' ')));
}

// ---------- tiempos de las palabras ----------
{
  // tokens de whisper.cpp → palabras: signos pegados, tokens especiales ignorados, centro por DTW
  const tk = (text, from, to, dtw) => ({ text, offsets: { from: from * 1000, to: to * 1000 }, t_dtw: dtw === undefined ? -1 : Math.round(dtw * 100) });
  const ws = wordsFromTokens([{ tokens: [tk('[_BEG_]', 0, 0), tk(' ¡', 0, 0.1), tk('Hola', 0.6, 0.9, 0.78), tk('!', 0.9, 0.95), tk(' lar', 1.4, 1.6, 1.5), tk('ga', 1.6, 1.8, 1.7), tk('.', 1.8, 1.8), tk('[_TT_150]', 1.8, 1.8)] }]);
  assert.deepStrictEqual(ws.map((w) => w.text), ['¡Hola!', 'larga.']);
  assert.ok(Math.abs(ws[0].mid - 0.78) < 1e-9 && Math.abs(ws[1].mid - 1.6) < 1e-9);
  assert.strictEqual(dtwPreset('ggml-large-v3-turbo-q5_0.bin'), 'large.v3.turbo');
  assert.strictEqual(dtwPreset('ggml-small.bin'), 'small');
  assert.strictEqual(dtwPreset('ggml-base.en.bin'), 'base.en');
  assert.strictEqual(dtwPreset('raro.bin'), null);

  // una palabra que Whisper dejó sobre una pausa pasa a la voz; lo que ya está sobre la voz no se toca
  const sil = [{ start: 0, end: 0.6 }, { start: 1.2, end: 2.0 }];
  const heard = [
    { text: 'Hola', start: 0.0, end: 0.3, mid: 0.8 },       // Whisper puso el comienzo en el silencio inicial; su centro dice que está en la voz
    { text: 'esto', start: 0.9, end: 1.5, mid: 1.0 },       // su final cae en la pausa de 1.2 a 2.0
    { text: 'sigue', start: 2.1, end: 2.4, mid: 2.25 },     // empieza apenas después de la pausa: es el comienzo de la voz
    { text: 'bien', start: 2.5, end: 2.8, mid: 2.65 },      // ya está sobre la voz
  ];
  const sn = snapToSpeech(heard, sil, 3.5);
  assert.ok(Math.abs(sn[0].start - 0.6) < 1e-9, 'empieza donde empieza la voz: ' + sn[0].start);
  assert.ok(sn[0].end >= 0.8 + 0.01 - 1e-9, 'no termina antes de su centro');
  assert.ok(Math.abs(sn[1].end - 1.2) < 1e-9, 'termina donde empieza la pausa: ' + sn[1].end);
  assert.ok(Math.abs(sn[2].start - 2.0) < 1e-9, 'sigue empieza donde termina la pausa: ' + sn[2].start);
  assert.ok(Math.abs(sn[3].start - 2.5) < 0.1 && Math.abs(sn[3].end - 2.8) < 0.1, 'sobre la voz casi no cambia: ' + JSON.stringify(sn[3]));
  for (let i = 1; i < sn.length; i++) assert.ok(sn[i].start >= sn[i - 1].start, 'en orden');
  // sin pausas claras (ruido de fondo) no cambia nada
  const ns = snapToSpeech(heard, [], 3.5);
  ns.forEach((w, i) => assert.ok(w.start <= heard[i].mid && w.end >= heard[i].mid && Math.abs(w.start - Math.max(heard[i].start, 0)) < 0.7));
}

// ---------- velocidad de los clips ----------
{
  assert.strictEqual(atempoChain(1.25), 'atempo=1.25000');
  assert.strictEqual(atempoChain(4), 'atempo=2.0,atempo=2.00000');
  assert.strictEqual(atempoChain(0.25), 'atempo=0.5,atempo=0.50000');
  // el audio de un clip al 125 % dura 1/1.25 en la secuencia y toma 1.25 s del archivo por cada segundo de secuencia
  const f = (sp) => atempoChain(sp).split(',').reduce((p, x) => p * parseFloat(x.split('=')[1]), 1);
  [0.3, 0.5, 0.8, 1.25, 2, 3.5, 5].forEach((sp) => assert.ok(Math.abs(f(sp) - sp) < 1e-3, 'cadena de atempo para ' + sp));
}

console.log('OK\n' + toSrt(lines));
