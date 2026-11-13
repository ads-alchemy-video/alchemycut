'use strict';
// Motor de AlchemyCut: audio -> silencios / muletillas -> lista de cortes -> captions.
// Sin dependencias; corre igual en Node 16+ (dentro del panel CEP) y en la terminal.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const HOME_BIN = path.join(os.homedir(), '.alchemycut', 'bin');   // acá instala el panel ffmpeg y Whisper en Windows

// Carpetas donde se busca cada programa: las del panel, las habituales del sistema y, al final, el PATH.
function binDirs() {
  const e = process.env;
  const dirs = [HOME_BIN, path.join(HOME_BIN, 'whisper')];
  if (IS_WIN) {
    dirs.push(
      e.LOCALAPPDATA && path.join(e.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      e.ProgramFiles && path.join(e.ProgramFiles, 'ffmpeg', 'bin'),
      'C:\\ffmpeg\\bin',
      e.ProgramData && path.join(e.ProgramData, 'chocolatey', 'bin'),
      path.join(os.homedir(), 'scoop', 'shims'),
      e.SystemRoot && path.join(e.SystemRoot, 'System32')
    );
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  }
  String(e.PATH || e.Path || '').split(path.delimiter).forEach((d) => { if (d) dirs.push(d.replace(/^"|"$/g, '')); });
  return dirs.filter(Boolean);
}

function findBin(name) {
  const file = IS_WIN && !/\.exe$/i.test(name) ? name + '.exe' : name;
  for (const dir of binDirs()) {
    const p = path.join(dir, file);
    try { if (fs.existsSync(p)) return p; } catch (e) { /* carpeta ilegible */ }
  }
  return name;
}
const hasBin = (name) => path.isAbsolute(findBin(name));

function run(bin, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

async function extractAudio(input, start, duration, outFile) {
  const args = ['-y', '-v', 'error'];
  if (start > 0) args.push('-ss', String(start));
  if (duration > 0) args.push('-t', String(duration));
  args.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', outFile);
  const r = await run(findBin('ffmpeg'), args);
  if (r.code !== 0) throw new Error('ffmpeg no pudo extraer el audio: ' + r.stderr.trim());
}

// Arma un .mov con canal alfa (ProRes 4444, el que Premiere lee sin problemas) a partir de PNGs que se escriben en stdin.
// Devuelve { write(buffer), end() }: write respeta la contrapresión de la tubería.
function startOverlayEncoder({ outFile, fps }) {
  const child = spawn(findBin('ffmpeg'), [
    '-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', outFile,
  ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  let failed = null;
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', (e) => (failed = e));
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg no pudo armar el video: ' + stderr.trim().slice(-300)))));
  });
  done.catch(() => {});
  return {
    write(buf) {
      if (failed) return Promise.reject(new Error('ffmpeg cerró la tubería: ' + (stderr.trim().slice(-200) || failed.message)));
      return child.stdin.write(buf) ? Promise.resolve() : new Promise((r) => child.stdin.once('drain', r));
    },
    end() { child.stdin.end(); return done; },
  };
}

// Un cuadro del video (JPG chico) para la vista previa de captions. Falla sin ruido si el archivo es solo audio.
async function extractFrame(input, sec, outFile) {
  const r = await run(findBin('ffmpeg'), [
    '-y', '-v', 'error', '-ss', String(Math.max(0, sec)), '-i', input,
    '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outFile,
  ]);
  return r.code === 0 && fs.existsSync(outFile);
}

// Une en un solo audio los clips elegidos en la secuencia, cada uno en su posición (los huecos entre clips quedan en silencio).
// Así el audio tiene la misma línea de tiempo que la secuencia, aunque los clips ya estén cortados en pedazos.
// clips: [{ path, inSec, startSec, endSec }]  →  { file, base, duration }   (base = inicio del primer clip en la secuencia)
// atempo acepta 0.5–2 por filtro (los ffmpeg viejos no pasan de ahí): se encadena para otras velocidades
function atempoChain(speed) {
  const f = [];
  let s = speed;
  while (s > 2) { f.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { f.push('atempo=0.5'); s /= 0.5; }
  f.push('atempo=' + s.toFixed(5));
  return f.join(',');
}

async function buildTimelineAudio(clips, outFile) {
  const sorted = [...clips].sort((a, b) => a.startSec - b.startSec);
  if (!sorted.length) throw new Error('No hay clips para armar el audio.');
  const base = sorted[0].startSec;
  const paths = [...new Set(sorted.map((c) => c.path))];
  const fmt = 'aformat=sample_fmts=fltp:sample_rates=16000:channel_layouts=mono';
  const parts = [], labels = [];
  let t = base;
  sorted.forEach((c, i) => {
    let start = c.startSec, inSec = c.inSec;
    const speed = c.speed > 0.1 && c.speed < 10 ? c.speed : 1;       // segundos del archivo que se usan por cada segundo de la secuencia
    const overlap = t - start;
    if (overlap > 0) { start += overlap; inSec += overlap * speed; }   // clips que se pisan: se usa lo que no está cubierto
    const dur = c.endSec - start;
    if (dur < 0.01) return;
    const gap = start - t;
    if (gap > 0.01) { parts.push(`anullsrc=r=16000:cl=mono,atrim=0:${gap.toFixed(3)},asetpts=PTS-STARTPTS,${fmt}[g${i}]`); labels.push(`[g${i}]`); }
    // con otra velocidad se toma del archivo dur × speed segundos y se acelera / frena a la duración que tiene en la secuencia
    const tempo = Math.abs(speed - 1) < 0.001 ? '' : `,${atempoChain(speed)},apad=whole_dur=${dur.toFixed(3)},atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS`;
    parts.push(`[${paths.indexOf(c.path)}:a]atrim=start=${inSec.toFixed(3)}:end=${(inSec + dur * speed).toFixed(3)},asetpts=PTS-STARTPTS${tempo},${fmt}[a${i}]`);
    labels.push(`[a${i}]`);
    t = c.endSec;
  });
  if (!labels.length) throw new Error('Los clips elegidos no tienen duración.');
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`);
  const args = ['-y', '-v', 'error'];
  paths.forEach((p) => args.push('-i', p));
  args.push('-filter_complex', parts.join(';'), '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '64k', outFile);
  const r = await run(findBin('ffmpeg'), args);
  if (r.code !== 0) throw new Error('ffmpeg no pudo armar el audio de los clips: ' + r.stderr.trim().slice(-300));
  return { file: outFile, base, duration: t - base };
}

async function audioDuration(file) {
  const r = await run(findBin('ffprobe'), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]);
  const d = parseFloat(r.stdout);
  if (!(d > 0)) throw new Error('ffprobe no pudo leer la duración: ' + r.stderr.trim());
  return d;
}

// Devuelve [{start, end}] en segundos relativos al audio extraído.
async function detectSilences(audioFile, duration, { noiseDb = -35, minSilence = 0.4 } = {}) {
  const r = await run(findBin('ffmpeg'), [
    '-v', 'info', '-i', audioFile,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-',
  ]);
  const out = [];
  let open = null;
  for (const line of r.stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, parseFloat(s[1]));
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && open !== null) {
      out.push({ start: open, end: parseFloat(e[1]) });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}

// Las keys viajan a curl por stdin (-K -) para que no aparezcan en la lista de procesos.
const cfgHeader = (url, header, value) =>
  `url = "${url}"\nheader = "${header}: ${value.replace(/["\\\r\n]/g, '')}"\n`;

// ElevenLabs Scribe: conserva las muletillas, la mejor opción para quitarlas.
async function transcribeElevenLabs(audioFile, { apiKey, language }) {
  if (!apiKey) throw new Error('Falta la API key de ElevenLabs.');
  const args = [
    '-sS', '--fail-with-body', '-K', '-',
    '-F', `file=@${audioFile}`,
    '-F', 'model_id=scribe_v1',
    '-F', 'timestamps_granularity=word',
    '-F', 'tag_audio_events=false',
  ];
  if (language && language !== 'auto') args.push('-F', `language_code=${language}`);
  const r = await run(findBin('curl'), args, { input: cfgHeader('https://api.elevenlabs.io/v1/speech-to-text', 'xi-api-key', apiKey) });
  if (r.code !== 0) throw new Error('Scribe falló: ' + (r.stdout || r.stderr).trim().slice(0, 300));
  return (JSON.parse(r.stdout).words || [])
    .filter((w) => w.type === 'word')
    .map((w) => ({ text: w.text, start: w.start, end: w.end }));
}

const WHISPER_PROMPT = 'Eh, em, mmm, um, uh, o sea, este... Hola, eh, vamos a ver.';
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

// OpenAI whisper-1 con tiempos por palabra. El prompt empuja a Whisper a conservar las muletillas.
async function transcribeOpenAI(audioFile, { apiKey, language, prompt }) {
  if (!apiKey) throw new Error('Falta la API key de OpenAI.');
  if (fs.statSync(audioFile).size > OPENAI_MAX_BYTES) {
    throw new Error('El audio supera los 25 MB que acepta OpenAI (unos 50 min). Usá Whisper local o un tramo más corto.');
  }
  const args = [
    '-sS', '--fail-with-body', '-K', '-',
    '-F', `file=@${audioFile}`,
    '-F', 'model=whisper-1',
    '-F', 'response_format=verbose_json',
    '-F', 'timestamp_granularities[]=word',
    '-F', `prompt=${prompt || WHISPER_PROMPT}`,
  ];
  if (language && language !== 'auto') args.push('-F', `language=${language}`);
  const r = await run(findBin('curl'), args, { input: cfgHeader('https://api.openai.com/v1/audio/transcriptions', 'Authorization', 'Bearer ' + apiKey) });
  if (r.code !== 0) throw new Error('OpenAI falló: ' + (r.stdout || r.stderr).trim().slice(0, 300));
  return (JSON.parse(r.stdout).words || []).map((w) => ({ text: w.word.trim(), start: w.start, end: w.end }));
}

// Whisper local con whisper.cpp (Mac: brew install whisper-cpp; Windows: lo instala el panel). Sin internet, sin key.
const MODEL_DIR = path.join(os.homedir(), '.alchemycut', 'models');
async function transcribeLocal(audioFile, { language, model = 'small', prompt }) {
  const bin = findBin('whisper-cli');
  const modelFile = fs.existsSync(model) ? model : path.join(MODEL_DIR, `ggml-${model}.bin`);
  if (!hasBin('whisper-cli')) {
    throw new Error('Falta Whisper local. Apretá “Instalar ahora” en el aviso de arriba del panel (se instala solo).');
  }
  if (!fs.existsSync(modelFile)) {
    throw new Error(`Falta el modelo de Whisper (${path.basename(modelFile)}). Apretá “Instalar” en el aviso de arriba del panel para bajarlo.`);
  }
  const dir = path.dirname(audioFile);
  const wav = path.join(dir, 'whisper.wav');
  const conv = await run(findBin('ffmpeg'), ['-y', '-v', 'error', '-i', audioFile, '-ar', '16000', '-ac', '1', wav]);
  if (conv.code !== 0) throw new Error('ffmpeg no pudo preparar el audio: ' + conv.stderr.trim());
  const base = path.join(dir, 'whisper');
  try { fs.unlinkSync(base + '.json'); } catch (e) { /* no había */ }
  // -ojf: JSON con el tiempo de cada pedacito de palabra (token). Los tiempos de los tokens salen bastante más cerca del audio
  // que los de "-ml 1 -sow" (que adelantaba palabras enteras sobre las pausas); las palabras se arman juntando tokens.
  // --dtw (alineación por atención del modelo) da el centro de cada palabra con mucha más precisión; necesita -nfa.
  const dtw = dtwPreset(path.basename(modelFile));
  const r = await run(bin, [
    '-m', modelFile, '-f', wav, '-l', language || 'auto',
    '-t', String(Math.max(2, Math.min(8, (os.cpus() || []).length || 4))),
    ...(dtw ? ['--dtw', dtw, '-nfa'] : []),
    '--prompt', prompt || WHISPER_PROMPT, '-ojf', '-of', base, '-np',
  ]);
  if (r.code !== 0 || !fs.existsSync(base + '.json')) {
    throw new Error('whisper-cli falló: ' + (r.stderr || r.stdout).trim().slice(-300));
  }
  const json = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
  return wordsFromTokens(json.transcription || []);
}

// Nombre del modelo → preset de DTW de whisper.cpp (null si no se conoce: se usan los tiempos normales).
function dtwPreset(file) {
  const f = String(file).toLowerCase().replace(/^ggml-/, '').replace(/\.bin$/, '');
  const en = /\.en/.test(f) ? '.en' : '';
  if (/large-v3-turbo/.test(f)) return 'large.v3.turbo';
  const m = f.match(/^(large-v3|large-v2|large-v1|medium|small|base|tiny)/);
  if (!m) return null;
  return m[1].replace('large-v', 'large.v') + en;
}

// Junta los tokens de whisper.cpp en palabras con su tiempo. Una palabra nueva empieza en un token con espacio adelante;
// los signos sueltos (¡ ¿ . , !) se pegan a la palabra de al lado. Los tokens especiales ([_BEG_], [_TT_…]) se ignoran.
function wordsFromTokens(segments) {
  const words = [];
  let cur = null;
  const isWord = (t) => /[\p{L}\p{N}]/u.test(t);
  for (const seg of segments) {
    for (const tk of seg.tokens || []) {
      const text = String(tk.text || '');
      if (!text || /^\[_.*\]$/.test(text)) continue;
      const from = (tk.offsets ? tk.offsets.from : 0) / 1000, to = (tk.offsets ? tk.offsets.to : 0) / 1000;
      const startsWord = /^\s/.test(text);
      if (!cur || (startsWord && cur.hasWord)) {
        cur = { text: '', start: null, end: null, hasWord: false, dtw: [] };
        words.push(cur);
      }
      cur.text += text;
      if (isWord(text)) {
        if (cur.start === null) cur.start = from;
        cur.end = Math.max(cur.end === null ? to : cur.end, to, from);
        cur.hasWord = true;
        if (typeof tk.t_dtw === 'number' && tk.t_dtw >= 0) cur.dtw.push(tk.t_dtw / 100);   // centésimas de segundo
      }
    }
  }
  return words
    .map((w) => ({ text: w.text.trim(), start: w.start === null ? 0 : w.start, end: w.end === null ? 0 : w.end, hasWord: w.hasWord, dtw: w.dtw }))
    .filter((w) => w.text && w.hasWord && !/^\[.*\]$/.test(w.text))
    .map(({ text, start, end, dtw }) => {
      const out = { text, start, end: Math.max(end, start) };
      if (dtw.length) out.mid = (dtw[0] + dtw[dtw.length - 1]) / 2;
      return out;
    });
}

const PROVIDERS = { elevenlabs: transcribeElevenLabs, openai: transcribeOpenAI, local: transcribeLocal };

async function transcribe(audioFile, opts = {}) {
  const fn = PROVIDERS[opts.provider || 'elevenlabs'];
  if (!fn) throw new Error('Proveedor de transcripción desconocido: ' + opts.provider);
  return fn(audioFile, opts);
}

const FILLERS = {
  es: ['eh', 'ehh', 'ehhh', 'em', 'emm', 'ehm', 'mm', 'mmm', 'hm', 'hmm', 'ah', 'aah', 'o sea'],
  en: ['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mm', 'mmm', 'you know'],
};

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function findFillers(words, language) {
  const lists = language === 'auto' || !FILLERS[language] ? [...FILLERS.es, ...FILLERS.en] : FILLERS[language];
  const phrases = lists.map((p) => p.split(' '));
  const toks = words.map((w) => norm(w.text));
  const out = [];
  for (let i = 0; i < words.length; i++) {
    for (const ph of phrases) {
      if (ph.every((t, k) => toks[i + k] === t)) {
        const last = words[i + ph.length - 1];
        out.push({ start: words[i].start, end: last.end, reason: 'muletilla: ' + ph.join(' '), words: words.slice(i, i + ph.length) });
        i += ph.length - 1;
        break;
      }
    }
  }
  return out;
}

function mergeRanges(ranges, gap = 0.02) {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && r.start <= prev.end + gap) {
      prev.end = Math.max(prev.end, r.end);
      if (!prev.reason.includes(r.reason)) prev.reason += ' + ' + r.reason;
    } else out.push({ ...r });
  }
  return out;
}

// ---- Nivel de audio: umbral automático, voces bajas y repeticiones ----

// Audio mono 16 kHz como muestras de 16 bits (para medir volumen por tramo).
function readPcm(audioFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(findBin('ffmpeg'), ['-v', 'error', '-i', audioFile, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg no pudo leer el audio: ' + err.trim()));
      const buf = Buffer.concat(chunks);
      const copy = new Int16Array(Math.floor(buf.length / 2));
      for (let i = 0; i < copy.length; i++) copy[i] = buf.readInt16LE(i * 2);
      resolve(copy);
    });
  });
}

const RATE = 16000;
const percentile = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};
const rmsDb = (pcm, a, b) => {
  const i0 = Math.max(0, Math.floor(a * RATE)), i1 = Math.min(pcm.length, Math.ceil(b * RATE));
  if (i1 <= i0) return -120;
  let sum = 0;
  for (let i = i0; i < i1; i++) { const v = pcm[i] / 32768; sum += v * v; }
  return 10 * Math.log10(sum / (i1 - i0) + 1e-12);
};

// Umbral de silencio según el propio clip: un poco por encima del ruido de fondo. Así las colas de las frases
// (la voz que baja al final) siguen contando como voz, aunque estén muy por debajo del pico.
function autoThreshold(pcm) {
  const frame = 320, levels = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) levels.push(rmsDb(pcm, i / RATE, (i + frame) / RATE));
  const valid = levels.filter((v) => v > -80);   // el silencio digital puro no cuenta como ruido de fondo
  const noise = percentile(valid, 0.1), speech = percentile(valid, 0.9);
  const thr = Math.max(-60, Math.min(-28, noise + 9, speech - 22));
  return { noise, speech, threshold: Math.round(thr * 10) / 10 };
}

// Pico (dBFS) de cada cuadro de 50 ms: es lo que muestran los medidores de Premiere.
function peakEnvelope(pcm, frameMs = 50) {
  const frame = Math.round(RATE * frameMs / 1000), out = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let mx = 0;
    for (let k = i; k < i + frame; k++) { const v = Math.abs(pcm[k]); if (v > mx) mx = v; }
    out.push(20 * Math.log10(mx / 32768 + 1e-6));
  }
  return { env: out, frameSec: frame / RATE };
}

// Pico de la voz principal (dBFS) tal como está en el archivo: casi el más alto, sin contar un golpe suelto.
function measurePeak(pcm) {
  const { env } = peakEnvelope(pcm);
  const sorted = [...env].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(0.995 * (sorted.length - 1))] : -120;
}

// Voces bajas por nivel: todo tramo que se mantiene por debajo de `thresholdDb` (pico) durante al menos `minDur` segundos
// se borra, haya o no palabras ahí. Los picos sueltos más cortos que `blip` dentro del tramo no lo cortan (una tos, un golpe).
// Las colas de las frases no caen en esto porque duran menos que minDur y enseguida vuelve la voz fuerte.
function findQuietLevels(pcm, { thresholdDb = -24, minDur = 1.0, blip = 0.25, pad = 0.05 } = {}) {
  const { env, frameSec } = peakEnvelope(pcm);
  const quiet = env.map((v) => v < thresholdDb);
  const maxBlip = Math.max(1, Math.round(blip / frameSec));
  for (let i = 0; i < quiet.length;) {              // picos cortos rodeados de bajo = bajo
    if (quiet[i]) { i++; continue; }
    let j = i;
    while (j < quiet.length && !quiet[j]) j++;
    if (i > 0 && j < quiet.length && j - i <= maxBlip) for (let k = i; k < j; k++) quiet[k] = true;
    i = j;
  }
  const ranges = [];
  for (let i = 0; i < quiet.length;) {
    if (!quiet[i]) { i++; continue; }
    let j = i;
    while (j < quiet.length && quiet[j]) j++;
    const start = i * frameSec, end = j * frameSec;
    if (end - start >= minDur) ranges.push({ start: start + pad, end: end - pad, reason: `voz baja (< ${thresholdDb} dB)` });
    i = j;
  }
  // Dentro de un tramo largo de voz baja, alguna palabra suelta sube un poco ("ok", "¿qué?"): si los huecos entre tramos son cortos y
  // el conjunto es en su mayoría bajo, se juntan en uno solo. Una frase corta entre dos pausas no cumple esto y se conserva.
  const grouped = [];
  for (let i = 0; i < ranges.length;) {
    let j = i;
    while (j + 1 < ranges.length && ranges[j + 1].start - ranges[j].end <= 2.0 + 2 * pad) j++;
    const span = ranges[j].end - ranges[i].start;
    const quietTotal = ranges.slice(i, j + 1).reduce((n, r) => n + (r.end - r.start), 0);
    if (j > i && span >= 6 && quietTotal / span >= 0.75) grouped.push({ ...ranges[i], end: ranges[j].end });
    else grouped.push(...ranges.slice(i, j + 1));
    i = j + 1;
  }
  const sorted = [...env].sort((a, b) => a - b);
  const mainPeak = sorted.length ? sorted[Math.floor(0.995 * (sorted.length - 1))] : -120;
  return { ranges: grouped.filter((r) => r.end > r.start), mainPeak };
}

const fold = (s) => norm(s.normalize('NFD').replace(/[̀-ͯ]/g, ''));

// Tomas repetidas: si una frase se vuelve a decir enseguida (mismas palabras seguidas), se borra lo anterior y queda la última toma.
// minWords evita falsos positivos con expresiones cortas que se repiten a propósito; maxGap es cuántos segundos de otra cosa
// pueden separar las dos tomas.
function findRepeats(words, { minWords = 4, maxGap = 12, covered = [] } = {}) {
  const ws = (words || []).filter((w) => fold(w.text));
  const tok = ws.map((w) => fold(w.text));
  const overlap = (a, b) => covered.reduce((n, r) => n + Math.max(0, Math.min(b, r.end) - Math.max(a, r.start)), 0);
  const ranges = [], dropped = [];
  for (let i = 0; i < ws.length;) {
    let bestJ = -1, bestL = 0;
    for (let j = i + 1; j < ws.length; j++) {
      let L = 0;
      while (j + L < ws.length && L < j - i && tok[i + L] === tok[j + L]) L++;
      if (L < minWords || tok.slice(i, i + L).join('').length < 14) continue;
      const gap = ws[j].start - ws[i + L - 1].end - overlap(ws[i + L - 1].end, ws[j].start);
      if (gap > maxGap) { if (ws[j].start - ws[i + L - 1].end > maxGap * 4) break; continue; }
      if (L > bestL) { bestL = L; bestJ = j; }
    }
    if (bestJ < 0) { i++; continue; }
    const text = ws.slice(i, i + Math.min(bestL, 6)).map((w) => w.text).join(' ');
    ranges.push({ start: ws[i].start, end: ws[bestJ].start, reason: `repetición: “${text}…”` });
    dropped.push(...ws.slice(i, bestJ));
    i = bestJ;      // sigue desde la toma que queda, por si hay una tercera
  }
  return { ranges, words: dropped };
}

// pad = lo que se deja de aire a cada lado de un silencio para que no suene cortado.
function planCuts({ duration, silences, words, fillers, pad = 0.1, minRemoval = 0.08, extra = [], extraDropped = [] }) {
  const removed = [];
  for (const s of silences) {
    const a = s.start + pad;
    const b = s.end - pad;
    if (b - a >= minRemoval) removed.push({ start: a, end: b, reason: 'silencio' });
  }
  const found = fillers && words ? findFillers(words, fillers) : [];
  // Las palabras que se van del video son solo las muletillas: Whisper estira palabras reales
  // sobre los silencios, así que "cae dentro de un corte" no significa que la palabra se borre.
  const dropped = [...found.flatMap((f) => f.words), ...extraDropped];
  removed.push(...found.map(({ words: _w, ...range }) => range), ...extra);
  const merged = mergeRanges(removed)
    .map((r) => ({ ...r, start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter((r) => r.end - r.start >= minRemoval);
  const keep = [];
  let t = 0;
  for (const r of merged) {
    if (r.start - t > 0.02) keep.push({ start: t, end: r.start });
    t = r.end;
  }
  if (duration - t > 0.02) keep.push({ start: t, end: duration });
  const saved = merged.reduce((n, r) => n + (r.end - r.start), 0);
  return { removed: merged, keep, saved, dropped };
}

function remapTime(t, removed) {
  let shift = 0;
  for (const r of removed) {
    if (r.end <= t) shift += r.end - r.start;
    else if (r.start < t) shift += t - r.start;
  }
  return t - shift;
}

function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

// Palabras con las que no conviene terminar una línea (artículos, preposiciones, conjunciones).
const WEAK_END = new Set((
  'el la los las un una unos unas de del al a en con por para sin sobre y e o u ni que si se su sus mi mis tu tus lo le les me te nos no como pero más muy ' +
  'the an of to in on at for and or but with from by as if that this is are was be my your our their its'
).split(' '));
const isWeak = (w) => WEAK_END.has(norm(w.text));

// Palabras que abren una frase nueva: cortar justo antes de ellas suena natural ("… cansado | de perder horas").
const OPENS_PHRASE = new Set((
  'de del para por con sin sobre desde hasta cuando como si pero porque donde mientras aunque y o que ' +
  'for with without about from until when because while although and or but that where'
).split(' '));
const opensPhrase = (w) => OPENS_PHRASE.has(norm(w.text));

// Parte una oración en líneas de a lo sumo `limit` caracteres, con cortes de lectura natural:
// prefiere cortar tras comas o pausas y evita dejar artículos o preposiciones al final.
function splitSentence(ws, limit, maxDur, maxWords) {
  const n = ws.length;
  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const len = ws.slice(i, j).map((w) => w.text).join(' ').length;
      const single = j - i === 1;
      if (!single && (len > limit || ws[j - 1].end - ws[i].start > maxDur || (maxWords && j - i > maxWords))) break;
      // lo ideal es ~70 % del máximo: líneas parejas y cortas leen mejor que líneas llenas
      let cost = 2 + ((len - limit * 0.7) / limit) ** 2 * 12;
      if (single) cost += 3;
      if (j < n) {
        const last = ws[j - 1];
        const endsClause = /[,;:]$/.test(last.text);
        if (endsClause) cost -= 4;
        if (ws[j].start - last.end > 0.3) cost -= 3;
        if (opensPhrase(ws[j])) cost -= 2;
        if (isWeak(last)) cost += 10;
        if (!endsClause && len < 9) cost += 4; // evita palabras sueltas cortas
      } else if (len < 9 && n > 1) cost += 6; // y evita que la última línea sea una sola palabra corta ("cómo")
      if (best[i] + cost < best[j]) { best[j] = best[i] + cost; from[j] = i; }
    }
  }
  const segs = [];
  for (let j = n; j > 0; j = from[j]) segs.unshift(ws.slice(from[j], j));
  return segs;
}

// Con maxLines = 2, reparte el texto de la línea en dos mitades equilibradas y bien cortadas.
function breakLines(seg, maxChars, maxLines) {
  const text = seg.map((w) => w.text).join(' ');
  if (maxLines < 2 || text.length <= maxChars || seg.length < 2) return text;
  let bestK = 1;
  let bestCost = Infinity;
  for (let k = 1; k < seg.length; k++) {
    const a = seg.slice(0, k).map((w) => w.text).join(' ').length;
    const b = text.length - a - 1;
    const cost = Math.abs(a - b) + (isWeak(seg[k - 1]) ? 12 : 0) + (/[,;:]$/.test(seg[k - 1].text) ? -6 : 0);
    if (cost < bestCost) { bestCost = cost; bestK = k; }
  }
  return seg.slice(0, bestK).map((w) => w.text).join(' ') + '\n' + seg.slice(bestK).map((w) => w.text).join(' ');
}

// Agrupa palabras en captions, ya en el tiempo del video editado (sin los tramos cortados).
// Devuelve [{start, end, text, srcStart}]; srcStart es el tiempo original (para mostrar un cuadro).
function buildCaptions(words, removed, { dropped = [], maxChars = 24, maxLines = 1, maxWords = 0, maxDur = 3, maxGap = 0.8 } = {}) {
  const alive = words
    .filter((w) => !dropped.includes(w))
    .map((w) => ({ text: w.text, fixed: w.fixed, srcStart: w.start, start: remapTime(w.start, removed), end: remapTime(w.end, removed) }));
  // corte obligatorio tras un punto final o una pausa larga
  const sentences = [];
  let cur = [];
  alive.forEach((w, i) => {
    cur.push(w);
    const next = alive[i + 1];
    if (/[.!?…]["')»]*$/.test(w.text) || (next && next.start - w.end > maxGap)) {
      sentences.push(cur);
      cur = [];
    }
  });
  if (cur.length) sentences.push(cur);
  const lines = sentences.flatMap((s) => splitSentence(s, maxChars * maxLines, maxDur, maxWords)).map((seg) => ({
    start: seg[0].start,
    end: seg[seg.length - 1].end,
    srcStart: seg[0].srcStart,
    text: breakLines(seg, maxChars, maxLines),
    words: seg.map((w) => ({ text: w.text, fixed: w.fixed, start: w.start, end: w.end })), // para animar palabra por palabra
  }));
  // sin solapes y con un mínimo legible
  lines.forEach((l, i) => {
    const limit = i + 1 < lines.length ? lines[i + 1].start : Infinity;
    l.end = Math.min(Math.max(l.end, l.start + 0.35), Math.max(limit, l.start + 0.05));
  });
  return lines;
}

function toSrt(lines) {
  return lines.map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}\n`).join('\n');
}


// Whisper suele marcar el inicio de una palabra en cuanto termina la anterior, o sea, adentro de la pausa:
// el caption aparece antes de que se oiga. Con las pausas reales del audio se corre cada inicio hasta donde
// vuelve la voz, y cada final hasta donde la voz se corta. Además, a veces varias palabras seguidas llegan con
// duración cero (todas en el mismo instante): esas se reparten por largo de palabra.
function alignWords(words, silences, { slack = 0.03, tiny = 0.06 } = {}) {
  if (!words || !words.length) return words;
  const out = words.map((w) => {
    let { start, end } = w;
    for (const s of silences || []) {
      if (start >= s.start - 0.05 && start < s.end && s.end - 0.001 > start) {
        // un corrimiento muy grande suele ser una palabra dicha bajito (por debajo del umbral), no una pausa: se deja como está
        if (s.end - start <= 0.6) start = Math.max(start, s.end - slack);
        break;
      }
    }
    if (end < start) end = start;
    for (const s of silences || []) {
      if (end > s.start + 0.02 && end <= s.end + 0.05 && s.start > start + 0.04) { end = s.start + slack; break; }
    }
    return { ...w, start, end: Math.max(start, end) };
  });
  // repartir las palabras colapsadas junto con la primera palabra que sí tiene duración
  for (let i = 0; i < out.length; i++) {
    if (out[i].end - out[i].start >= tiny) continue;
    let j = i;
    while (j < out.length && out[j].end - out[j].start < tiny) j++;
    const last = Math.min(j, out.length - 1);
    const from = out[i].start;
    const to = j < out.length ? out[j].end : from + (j - i) * 0.08;
    const group = out.slice(i, last + 1);
    const total = group.reduce((n, w) => n + Math.max(1, w.text.length), 0);
    let t = from;
    group.forEach((w) => { const d = (to - from) * Math.max(1, w.text.length) / total; w.start = t; w.end = t + d; t += d; });
    i = last;
  }
  return out;
}

// ---- Guion: ayuda al transcriptor y corrección de lo transcripto ----

// Saca las palabras de encima de las pausas. Whisper a veces deja una palabra sobre un silencio (el subtítulo sale antes o
// después que la voz); el centro de la palabra (w.mid, de DTW) sí es confiable. Con las pausas medidas en el audio:
// si el comienzo de una palabra cae en un silencio, pasa al final de ese silencio (donde empieza la voz); si su final cae
// en un silencio, vuelve al principio de ese silencio. Lo que ya está sobre la voz no se toca, y nada pasa del centro de
// la palabra: con ruido de fondo (pocos silencios claros) casi no cambia nada, en vez de arrastrar las palabras.
function snapToSpeech(words, silences, duration, { minSilence = 0.1, minWord = 0.06 } = {}) {
  if (!words || !words.length) return words;
  const n = words.length;
  const mids = words.map((w) => (typeof w.mid === 'number' ? w.mid : (w.start + w.end) / 2));
  const estLen = (w) => Math.max(0.12, Math.min(0.6, 0.065 * foldWord(w.text).length));      // lo que dura una palabra, según sus letras
  let out = words.map((w) => ({ ...w }));
  // 1) El centro de cada palabra (DTW) es lo más confiable. Si el comienzo o el final que dio Whisper no son creíbles respecto
  //    del centro (la palabra "empieza" medio segundo antes de su propio centro), se estiman desde el centro.
  if (words.some((w) => typeof w.mid === 'number')) {
    out.forEach((w, i) => {
      const half = estLen(w) / 2, tol = half + 0.25;
      const close = (j) => j >= 0 && j < n && Math.abs(mids[j] - mids[i]) <= half + estLen(words[j]) / 2 + 0.15;    // la vecina sigue de corrido (sin pausa)
      // entre dos palabras de corrido, el límite queda más cerca del centro de la corta (se reparte según el largo de cada una)
      const edge = (j) => mids[Math.min(i, j)] + (mids[Math.max(i, j)] - mids[Math.min(i, j)]) * (estLen(words[Math.min(i, j)]) / (estLen(words[i]) + estLen(words[j])));
      const estStart = close(i - 1) ? edge(i - 1) : mids[i] - half;
      const estEnd = close(i + 1) ? edge(i + 1) : mids[i] + half;
      const okS = mids[i] - w.start >= 0.02 && mids[i] - w.start <= tol;
      const okE = w.end - mids[i] >= 0.02 && w.end - mids[i] <= tol;
      // de corrido, el límite entre palabras sale mejor de los centros; después de una pausa, el comienzo de Whisper es confiable
      if (close(i - 1) || !okS) w.start = estStart;
      if (close(i + 1) || !okE) w.end = estEnd;
    });
  }
  // 2) Con las pausas medidas en el audio: si el comienzo cae en un silencio pasa al final de ese silencio (donde empieza la voz);
  //    si el final cae en un silencio vuelve al principio. Nada pasa del centro. Con ruido de fondo (pocos silencios claros) casi
  //    no cambia nada, en vez de arrastrar las palabras.
  const sil = [...(silences || [])].filter((s) => s.end - s.start >= minSilence).sort((a, b) => a.start - b.start);
  const startsInSil = (t) => sil.find((s) => t >= s.start - 0.02 && t < s.end - 0.01);
  const endsInSil = (t) => sil.find((s) => t > s.start + 0.01 && t <= s.end + 0.02);
  out = out.map((w, i) => {
    let { start, end } = w;
    const s0 = startsInSil(start);
    if (s0) start = Math.min(s0.end, mids[i] - 0.03);
    else {                                                   // un comienzo apenas después de que terminó un silencio: es el comienzo de la voz
      const near = sil.find((s) => start - s.end >= -0.01 && start - s.end <= 0.15);
      if (near && near.end <= mids[i] - 0.03) start = near.end;
    }
    const s1 = endsInSil(end);
    if (s1) end = Math.max(s1.start, mids[i] + 0.03);
    else {                                                   // y un final apenas antes de un silencio llega hasta ahí
      const near = sil.find((s) => s.start - end >= -0.01 && s.start - end <= 0.15);
      if (near && near.start >= mids[i] + 0.03) end = near.start;
    }
    start = Math.max(0, Math.min(start, mids[i] - 0.01));
    end = Math.min(duration, Math.max(end, mids[i] + 0.01, start + minWord));
    return { ...w, start, end };
  });
  // 3) en orden y sin pisarse
  for (let i = 1; i < n; i++) if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
  for (let i = 0; i + 1 < n; i++) if (out[i].end > out[i + 1].start && out[i + 1].start > out[i].start) out[i].end = out[i + 1].start;
  return out;
}

const foldWord = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const letters = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Texto del guion → palabras. Se quitan las indicaciones entre corchetes y los títulos sueltos tipo "HOOK 1:".
function scriptTokens(text) {
  const clean = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\r?\n/)
    .filter((l) => !/^\s*[^.!?¿¡]{1,40}:\s*$/.test(l))
    .join(' ');
  return clean.split(/\s+/).map((t) => ({ text: t, key: foldWord(t) })).filter((t) => t.key);
}

// Nombres propios y cifras del guion, para que Whisper los escriba bien (no se le pasa el guion entero: tiende a inventar lo que no se dijo).
function scriptPrompt(text, maxChars = 280) {
  const toks = String(text || '').replace(/\[[^\]]*\]/g, ' ').split(/\r?\n/)
    .filter((l) => !/^\s*[^.!?¿¡]{1,40}:\s*$/.test(l)).join(' ').split(/\s+/).filter(Boolean);
  const out = [], seenKeys = new Set();
  let phrase = [];
  const flush = () => {
    if (phrase.length) {
      const t = phrase.join(' ');
      if (!seenKeys.has(t.toLowerCase())) { seenKeys.add(t.toLowerCase()); out.push(t); }
    }
    phrase = [];
  };
  toks.forEach((raw, i) => {
    const w = raw.replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%]+$/gu, '');
    const startsSentence = i === 0 || /[.!?…:]["')»]*$/.test(toks[i - 1]);
    const special = w && (/\d/.test(w) || (/^\p{Lu}/u.test(w) && !startsSentence) || (w.length > 1 && w === w.toUpperCase() && /\p{L}/u.test(w)));
    if (special) phrase.push(w); else flush();
    if (/[.,;:!?…]["')»]*$/.test(raw)) flush();
  });
  flush();
  let prompt = '';
  for (const t of out) { if ((prompt + t).length + 2 > maxChars) break; prompt += (prompt ? ', ' : '') + t; }
  return prompt ? prompt + '.' : '';
}

const levCache = new Map();
function similarity(a, b) {
  if (a === b) return 1;
  const k = a + '|' + b;
  if (levCache.has(k)) return levCache.get(k);
  const n = a.length, m = b.length;
  let r = 0;
  if (Math.min(n, m) >= 3 && Math.abs(n - m) <= 3) {
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
      const cur = [i];
      for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    r = 1 - prev[m] / Math.max(n, m);
  }
  levCache.set(k, r);
  return r;
}

// Alinea las palabras transcriptas con las del guion, en orden, y donde hay coincidencia clara pone la palabra del guion
// (con su ortografía y puntuación) conservando el tiempo de la palabra. Lo que no está en el guion queda tal cual.
// El guion puede tener de más (otros hooks, partes que no se grabaron): se saltea sin costo al principio y al final.
function alignToScript(words, scriptText, { minSim = 0.6 } = {}) {
  const toks = scriptTokens(scriptText);
  const n = words.length, m = toks.length;
  const keys = words.map((w) => foldWord(w.text));
  const none = { words, corrected: 0, matched: 0, total: n, scriptWords: m };
  if (!n || !m || n * m > 40e6) return none;
  const W = m + 1, GAP_S = -0.25, GAP_T = -0.8;
  const dir = new Uint8Array((n + 1) * W);          // 1 = diagonal, 2 = palabra transcripta sin pareja, 3 = palabra del guion salteada
  let prev = new Float32Array(W), cur = new Float32Array(W);
  for (let i = 1; i <= n; i++) {
    cur[0] = prev[0] + GAP_T; dir[i * W] = 2;
    for (let j = 1; j <= m; j++) {
      let best = prev[j] + GAP_T, d = 2;
      const left = cur[j - 1] + GAP_S;
      if (left > best) { best = left; d = 3; }
      const a = keys[i - 1];
      if (a) {
        const sim = similarity(a, toks[j - 1].key);
        if (sim >= minSim) {
          const diag = prev[j - 1] + (sim === 1 ? 3 : 3 * sim - 1);
          if (diag >= best) { best = diag; d = 1; }
        }
      }
      cur[j] = best; dir[i * W + j] = d;
    }
    [prev, cur] = [cur, prev];
  }
  let bj = 0;
  for (let j = 1; j <= m; j++) if (prev[j] > prev[bj]) bj = j;
  const pair = new Array(n).fill(-1);
  for (let i = n, j = bj; i > 0;) {
    const d = dir[i * W + j];
    if (d === 1) { pair[i - 1] = j - 1; i--; j--; }
    else if (d === 3) j--;
    else i--;
  }
  // Una coincidencia aproximada (palabra distinta pero parecida) solo vale si al lado hay otra palabra emparejada en orden:
  // si no, una palabra suelta del video se confunde con una del guion que sí es otra cosa ("hasta" y "gusta").
  for (let i = 0; i < n; i++) {
    if (pair[i] < 0 || keys[i] === toks[pair[i]].key) continue;
    const before = i > 0 && pair[i - 1] === pair[i] - 1, after = i + 1 < n && pair[i + 1] === pair[i] + 1;
    if (!before && !after) pair[i] = -1;
  }
  let corrected = 0, matched = 0;
  const out = words.map((w, i) => {
    if (pair[i] < 0) return w;
    matched++;
    const t = toks[pair[i]].text;
    const changed = letters(t) !== letters(w.text);
    if (changed) corrected++;
    return { ...w, text: t, fixed: changed, orig: w.text };
  });
  return { words: out, corrected, matched, total: n, scriptWords: m };
}

// Flujo completo sobre un tramo [inSec, inSec + durSec] del archivo.
async function analyze(opts) {
  const {
    input, inSec = 0, durSec = 0, noiseDb = -35, minSilence = 0.4, pad = 0.1, autoThresh = false,
    fillers = false, captions = false, language = 'auto', apiKey, provider = 'elevenlabs', model, workDir,
    quietVoices = false, quietLevel = -20, quietMin = 1.0, premierePeak = null, repeats = false, repeatWords = 4, repeatGap = 12,
    cuts = true, audio: prebuilt = null, script = '', scriptFix = true,
    method = 'fast', keepEnd = 0.3, keepComma = 0.15, keepWord = 0.06, minGap = 0.3, takes = false, takeMin = 0.5, cutOffScript = true,
  } = opts;
  const precise = cuts && method === 'precise';          // cortes por palabras (y guion) en vez de por volumen
  const dir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'alchemycut-'));
  let audio = prebuilt;
  if (!audio) { audio = path.join(dir, 'audio.mp3'); await extractAudio(input, inSec, durSec, audio); }
  const duration = await audioDuration(audio);
  const needText = captions || (cuts && (fillers || repeats || precise));
  const pcm = autoThresh || precise || (cuts && quietVoices) ? await readPcm(audio) : null;
  let threshold = noiseDb, level = null;
  if (autoThresh) { level = autoThreshold(pcm); threshold = level.threshold; }
  // Sin cortes (modo subtítulos) no se buscan silencios: solo se usan las pausas para afinar el tiempo de las palabras.
  const silences = cuts && !precise ? await detectSilences(audio, duration, { noiseDb: threshold, minSilence }) : [];
  let words = null;
  if (needText) {
    const hint = script && script.trim() ? scriptPrompt(script) : '';
    words = await transcribe(audio, { provider, apiKey, language, model, prompt: hint || undefined });
    // pausas finas (más cortas que las que se cortan) solo para ajustar el tiempo de las palabras
    const fine = await detectSilences(audio, duration, { noiseDb: threshold, minSilence: 0.06 });
    // con el centro de cada palabra (Whisper local con DTW) se acomodan las palabras dentro de la voz; si no, se afinan por las pausas
    words = words.some((w) => typeof w.mid === 'number') ? snapToSpeech(words, fine, duration) : alignWords(words, fine);
  }
  let rawWords = null, scriptStats = null;
  if (words && script && script.trim() && scriptFix) {
    rawWords = words;
    const fixed = alignToScript(words, script);
    words = fixed.words;
    scriptStats = { corrected: fixed.corrected, matched: fixed.matched, total: fixed.total, scriptWords: fixed.scriptWords };
  }
  if (!cuts) {
    return { input, inSec, duration, silences: 0, threshold, level, mainPeak: null, removed: [], keep: [{ start: 0, end: duration }], saved: 0, dropped: [], words, rawWords, scriptStats };
  }
  const extra = [], extraDropped = [];
  let quiet = { ranges: [], words: [], mainPeak: null }, fileLevel = null, offset = null;
  if (quietVoices) {
    // Premiere muestra el audio con la ganancia y los efectos del clip; el archivo original puede estar más bajo. Si se indica
    // cuánto marca la voz principal en Premiere, se convierte el umbral a los niveles del archivo.
    const mainPeak = measurePeak(pcm);
    offset = typeof premierePeak === 'number' && isFinite(premierePeak) ? premierePeak - mainPeak : 0;
    fileLevel = quietLevel - offset;
    quiet = { ...findQuietLevels(pcm, { thresholdDb: fileLevel, minDur: quietMin, pad }), words: [] };
    quiet.mainPeak = mainPeak;
    extra.push(...quiet.ranges);
    // las palabras que caen en esos tramos tampoco van en los captions
    if (words) quiet.words = words.filter((w) => quiet.ranges.some((r) => (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 <= r.end));
    extraDropped.push(...quiet.words);
  }
  if (precise) {
    // Método preciso: se decide qué palabras se van (muletillas, repeticiones, tomas descartadas) y después se comprime
    // cada hueco entre las que se quedan al largo de pausa que le toca.
    const dropWords = [];
    if (fillers) for (const f of findFillers(words, language)) dropWords.push({ words: f.words, reason: 'muletilla' });
    if (quiet.words.length) dropWords.push({ words: quiet.words, reason: 'voz baja' });
    if (repeats) {
      const gone = new Set([...quiet.words, ...dropWords.flatMap((d) => d.words)]);
      const rep = findRepeats(words.filter((w) => !gone.has(w)), { minWords: repeatWords, maxGap: repeatGap });
      if (rep.words.length) dropWords.push({ words: rep.words, reason: 'repetición' });
    }
    // ¿hay silencio en este cuadro de 10 ms? (con el mismo umbral que los demás cortes)
    const quietAt = pcm ? (t) => rmsDb(pcm, t, t + 0.02) <= threshold : null;
    const smart = require('./smart').planSmart({
      words, rawWords: rawWords || words, duration, script, takes, takeMin, cutOffScript, dropWords, quietAt,
      keepEnd, keepComma, keepWord, minGap, headKeep: Math.max(0.1, pad), tailKeep: Math.max(0.2, pad),
    });
    const plan = planCuts({ duration, silences: [], words, fillers: null, pad, extra: [...smart.ranges, ...extra], extraDropped: [...smart.dropped, ...extraDropped] });
    plan.removed = plan.removed.map((r) => ({ ...r, on: true }));
    const removed = [...plan.removed, ...smart.optional].sort((a, b) => a.start - b.start);
    return {
      input, inSec, duration, silences: 0, threshold, level, mainPeak: quiet.mainPeak, fileLevel, offset, ...plan, removed, words,
      smart: { takeInfo: smart.takeInfo, skipped: smart.skipped, optional: smart.optional.length },
    };
  }
  if (words && repeats) {
    // las muletillas y las voces bajas ya se van: no cuentan como parte de las tomas
    const gone = new Set([...quiet.words, ...(fillers ? findFillers(words, language).flatMap((f) => f.words) : [])]);
    const first = planCuts({ duration, silences, words, fillers: fillers ? language : null, pad, extra });
    const rep = findRepeats(words.filter((w) => !gone.has(w)), { minWords: repeatWords, maxGap: repeatGap, covered: first.removed });
    extra.push(...rep.ranges); extraDropped.push(...rep.words);
  }
  const plan = planCuts({ duration, silences, words, fillers: fillers ? language : null, pad, extra, extraDropped });
  const result = { input, inSec, duration, silences: silences.length, threshold, level, mainPeak: quiet.mainPeak, fileLevel, offset, ...plan };
  if (captions) result.words = words;
  return result;
}

module.exports = {
  atempoChain, wordsFromTokens, snapToSpeech, dtwPreset, analyze, planCuts, findFillers, buildCaptions, toSrt, srtTime, remapTime, mergeRanges,
  foldWord, fold, similarity, findBin, hasBin, detectSilences, alignWords, readPcm, alignToScript, scriptPrompt, scriptTokens, buildTimelineAudio, measurePeak, autoThreshold, findQuietLevels, findRepeats, extractAudio, extractFrame, startOverlayEncoder, audioDuration, transcribe, FILLERS,
};

// instalador de ffmpeg, Whisper y modelos (se carga al final: setup.js usa findBin de este archivo)
module.exports.setup = require('./setup');
module.exports.update = require('./update');
Object.assign(module.exports, require('./smart'));    // scriptSentences, matchTakes, planPauses, planSmart
