'use strict';
// Instala lo que AlchemyCut necesita para trabajar sin internet: ffmpeg, Whisper (whisper.cpp) y su modelo.
// Windows: baja ffmpeg y Whisper. Mac: baja ffmpeg y copia el whisper-cli que viene con el plugin (engine/bin/mac).
// En los dos se baja el modelo. Todo queda en la carpeta del usuario (~/.alchemycut), sin permisos de administrador y sin Homebrew.
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { URL } = require('url');     // la de Node (dentro de Premiere el URL global es la del navegador)

const HOME = path.join(os.homedir(), '.alchemycut');
const BIN = path.join(HOME, 'bin');
const WHISPER_DIR = path.join(BIN, 'whisper');
const MODELS = path.join(HOME, 'models');

const WHISPER_RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=40';
// por si GitHub no responde a la consulta: un lanzamiento que se sabe que trae el zip de Windows
const WHISPER_FALLBACK = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const FFMPEG_URLS = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
];
// Mac: ffmpeg y ffprobe estáticos (un solo archivo cada uno), por arquitectura. Se prueba de la versión más nueva a la más vieja.
const MAC_FF = 'https://www.osxexperts.net/';
const MAC_FFMPEG = {
  arm64: ['ffmpeg902arm.zip', 'ffmpeg80arm.zip', 'ffmpeg71arm.zip', 'ffmpeg7arm.zip'],
  x64: ['ffmpeg80intel.zip', 'ffmpeg71intel.zip', 'ffmpeg7intel.zip'],
};
const MAC_FFPROBE = {
  arm64: ['ffprobe902arm.zip', 'ffprobe71arm.zip', 'ffprobe7arm.zip'],
  x64: ['ffprobe80intel.zip', 'ffprobe71intel.zip'],
};
const MAC_WHISPER = path.join(__dirname, 'bin', 'mac', 'whisper-cli');     // viene con el plugin (universal: Apple Silicon e Intel)
const MODEL_URL = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
// tamaños aproximados, solo para avisar cuánto se va a bajar (MB)
const MODEL_MB = { 'large-v3-turbo-q5_0': 574, small: 466, base: 148, 'small-q5_1': 181, 'medium-q5_0': 539 };
const SIZES_MB = process.platform === 'win32' ? { ffmpeg: 115, whisper: 9 } : { ffmpeg: 45, whisper: 0 };

const lib = () => require('./lib');   // carga diferida: lib.js carga a este archivo al final

function modelFile(name) { return path.join(MODELS, `ggml-${name}.bin`); }

// Qué hay y qué falta. `model` es el nombre del modelo elegido en el panel.
function status(model) {
  const L = lib();
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const st = {
    platform: process.platform,
    auto: win || mac,                            // en Windows y Mac se instala desde el panel
    ffmpeg: L.hasBin('ffmpeg') && L.hasBin('ffprobe'),
    whisper: L.hasBin('whisper-cli'),
    model: !!model && fs.existsSync(modelFile(model)),
  };
  st.missing = [];
  if (!st.ffmpeg) st.missing.push('ffmpeg');
  if (!st.whisper) st.missing.push('whisper');
  if (!st.model) st.missing.push('model');
  // lo que se puede bajar desde el panel en esta máquina
  st.installable = st.missing.filter((m) => m === 'model' || win || (mac && (m === 'ffmpeg' || (m === 'whisper' && fs.existsSync(MAC_WHISPER)))));
  st.mb = sizeMB(st.installable, model);
  return st;
}
function sizeMB(list, model) { return list.reduce((t, m) => t + (m === 'model' ? MODEL_MB[model] || 600 : SIZES_MB[m] || 0), 0); }

// ---------- red ----------
// opciones sueltas para https.get (no un objeto URL ni la forma de 3 argumentos): funciona en todas las versiones de Node
function reqOpts(url, headers) {
  const u = new URL(url);
  return { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: (u.pathname || '/') + (u.search || ''), headers };
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(reqOpts(url, { 'User-Agent': 'AlchemyCut', Accept: 'application/vnd.github+json' }), (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('GitHub respondió ' + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Baja a un archivo, siguiendo redirecciones. Escribe en .part y renombra al terminar, así nunca queda un archivo a medias.
function download(url, dest, onProgress, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(reqOpts(url, { 'User-Agent': 'AlchemyCut' }), (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (hops > 8) return reject(new Error('Demasiadas redirecciones al bajar ' + url));
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('No se pudo bajar (' + res.statusCode + '): ' + url)); }
      const total = +res.headers['content-length'] || 0;
      let got = 0;
      const part = dest + '.part';
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(part);
      res.on('data', (d) => { got += d.length; if (onProgress) onProgress(got, total); });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        if (total && got !== total) { try { fs.unlinkSync(part); } catch (e) {} return reject(new Error('La descarga quedó incompleta. Revisá tu conexión y probá de nuevo.')); }
        try { fs.renameSync(part, dest); } catch (e) { return reject(e); }
        resolve();
      });
      res.pipe(out);
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('El servidor no responde. Revisá tu conexión.')));
  });
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err, so, se) => (err ? reject(new Error((se || err.message || '').toString().trim().slice(-300))) : resolve(so)));
  });
}

// zip -> carpeta. tar viene con Windows 10 (1803+) y es más rápido; si no, PowerShell.
async function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try { await exec('tar', ['-xf', zip, '-C', dest]); return; } catch (e) {
    if (process.platform !== 'win32') throw e;
  }
  const q = (p) => "'" + p.replace(/'/g, "''") + "'";
  await exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dest)} -Force`]);
}

function findFile(dir, name, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name);
  if (depth < 4) for (const e of entries) if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), name, depth + 1); if (f) return f; }
  return null;
}
function rmrf(p) {
  try {
    if (fs.rmSync) { fs.rmSync(p, { recursive: true, force: true }); return; }
    const st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) { fs.readdirSync(p).forEach((n) => rmrf(path.join(p, n))); fs.rmdirSync(p); } else fs.unlinkSync(p);
  } catch (e) { /* ya no estaba */ }
}
function copyDirFlat(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) if (e.isFile()) fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
}

// ---------- piezas ----------
async function installFfmpeg(report) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemycut-ffmpeg-'));
  try {
    let lastErr = null, zip = null;
    for (const url of FFMPEG_URLS) {
      const f = path.join(tmp, 'ffmpeg.zip');
      try { await download(url, f, (g, t) => report('ffmpeg', 'Bajando ffmpeg', g, t)); zip = f; break; } catch (e) { lastErr = e; }
    }
    if (!zip) throw lastErr || new Error('No se pudo bajar ffmpeg.');
    report('ffmpeg', 'Descomprimiendo ffmpeg…');
    const out = path.join(tmp, 'x');
    await unzip(zip, out);
    const ff = findFile(out, 'ffmpeg.exe'), fp = findFile(out, 'ffprobe.exe');
    if (!ff || !fp) throw new Error('El paquete de ffmpeg no trae ffmpeg.exe y ffprobe.exe.');
    fs.mkdirSync(BIN, { recursive: true });
    fs.copyFileSync(ff, path.join(BIN, 'ffmpeg.exe'));
    fs.copyFileSync(fp, path.join(BIN, 'ffprobe.exe'));
  } finally { rmrf(tmp); }
}

// Mac: deja ejecutable un programa bajado o copiado (sin la marca de "descargado de internet" y con firma local)
async function macTrust(file) {
  fs.chmodSync(file, 0o755);
  try { await exec('/usr/bin/xattr', ['-c', file]); } catch (e) {}
  try { await exec('/usr/bin/codesign', ['-s', '-', '-f', file]); } catch (e) {}
}

async function installFfmpegMac(report) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemycut-ffmpeg-'));
  try {
    for (const [name, urls, label] of [['ffmpeg', MAC_FFMPEG[arch], 'ffmpeg'], ['ffprobe', MAC_FFPROBE[arch], 'ffprobe']]) {
      let lastErr = null, zip = null;
      for (const u of urls) {
        const f = path.join(tmp, name + '.zip');
        try { await download(MAC_FF + u, f, (g, t) => report('ffmpeg', 'Bajando ' + label, g, t)); zip = f; break; } catch (e) { lastErr = e; }
      }
      if (!zip) throw lastErr || new Error('No se pudo bajar ' + label + '.');
      report('ffmpeg', 'Descomprimiendo ' + label + '…');
      const out = path.join(tmp, 'x-' + name);
      await unzip(zip, out);
      const bin = findFile(out, name);
      if (!bin) throw new Error('El paquete de ' + label + ' no trae el programa.');
      fs.mkdirSync(BIN, { recursive: true });
      const dest = path.join(BIN, name);
      fs.copyFileSync(bin, dest);
      await macTrust(dest);
    }
  } finally { rmrf(tmp); }
}

async function installWhisperMac(report) {
  report('whisper', 'Instalando Whisper…');
  fs.mkdirSync(WHISPER_DIR, { recursive: true });
  const dest = path.join(WHISPER_DIR, 'whisper-cli');
  fs.copyFileSync(MAC_WHISPER, dest);
  await macTrust(dest);
}

async function whisperUrl() {
  try {
    const rels = await getJson(WHISPER_RELEASES);
    for (const r of rels) {
      const a = (r.assets || []).find((x) => x.name === 'whisper-bin-x64.zip');
      if (a) return a.browser_download_url;
    }
  } catch (e) { /* sin API: se usa el lanzamiento conocido */ }
  return WHISPER_FALLBACK;
}

async function installWhisper(report) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemycut-whisper-'));
  try {
    report('whisper', 'Buscando Whisper…');
    const url = await whisperUrl();
    const zip = path.join(tmp, 'whisper.zip');
    await download(url, zip, (g, t) => report('whisper', 'Bajando Whisper', g, t));
    report('whisper', 'Descomprimiendo Whisper…');
    const out = path.join(tmp, 'x');
    await unzip(zip, out);
    const cli = findFile(out, 'whisper-cli.exe');
    if (!cli) throw new Error('El paquete de Whisper no trae whisper-cli.exe.');
    rmrf(WHISPER_DIR);
    copyDirFlat(path.dirname(cli), WHISPER_DIR);       // el .exe y sus .dll tienen que quedar juntos
  } finally { rmrf(tmp); }
}

async function installModel(name, report) {
  if (!/^[\w.-]+$/.test(name || '')) throw new Error('Nombre de modelo no válido.');
  await download(MODEL_URL(name), modelFile(name), (g, t) => report('model', 'Bajando el modelo de Whisper', g, t));
}

// Instala lo que falte. onProgress({ step, label, got, total, pct })
async function install({ model, onProgress, steps } = {}) {
  const st = status(model);
  if (steps) st.installable = st.installable.filter((m) => steps.includes(m));
  const report = (step, label, got, total) => {
    if (onProgress) onProgress({ step, label, got: got || 0, total: total || 0, pct: total ? Math.min(100, Math.round((got / total) * 100)) : null });
  };
  if (!st.installable.length) return status(model);
  const mac = process.platform === 'darwin';
  if (st.installable.includes('ffmpeg')) await (mac ? installFfmpegMac : installFfmpeg)(report);
  if (st.installable.includes('whisper')) await (mac ? installWhisperMac : installWhisper)(report);
  if (st.installable.includes('model')) await installModel(model, report);
  return status(model);
}

module.exports = { status, sizeMB, install, installFfmpegMac, installWhisperMac, installFfmpeg, installWhisper, installModel, download, unzip, findFile, paths: { HOME, BIN, WHISPER_DIR, MODELS }, MODEL_MB };
