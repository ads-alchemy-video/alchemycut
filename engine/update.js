'use strict';
// Actualizador: mira si hay una versión nueva publicada en GitHub (Releases) y, si el usuario lo pide, la instala encima.
// Seguridad: solo HTTPS, solo hosts de GitHub, el zip tiene que coincidir con la huella (SHA-256) que publica version.json,
// y nunca se pisa una copia enlazada para desarrollo. Si algo falla a mitad de camino, se restaura lo anterior.
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');      // la de Node: dentro de Premiere el URL global es la del navegador y https.get no la acepta

const HOSTS = [/^github\.com$/i, /(^|\.)githubusercontent\.com$/i];
const MAX_ZIP = 80 * 1024 * 1024;
const platKey = () => (process.platform === 'win32' ? 'windows' : 'mac');

// "1.10.2" vs "1.9.0": 1 si a > b, -1 si a < b, 0 si iguales
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

function readLocal(extDir) {
  try { return JSON.parse(fs.readFileSync(path.join(extDir, 'version.json'), 'utf8')); } catch (e) { return { version: '0.0.0' }; }
}

// Baja una URL a memoria. opts.insecureForTests solo lo usan las pruebas (http://localhost).
function fetchBuffer(url, opts = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Dirección no válida.')); }
    if (!opts.insecureForTests) {
      if (u.protocol !== 'https:') return reject(new Error('Solo se aceptan descargas por HTTPS.'));
      if (!HOSTS.some((re) => re.test(u.hostname))) return reject(new Error('Descarga bloqueada: ' + u.hostname + ' no es un servidor de GitHub.'));
    }
    const lib = u.protocol === 'http:' ? http : https;
    // opciones sueltas (no un objeto URL): funciona igual en todas las versiones de Node y dentro de Premiere
    const req = lib.get({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: (u.pathname || '/') + (u.search || ''), headers: { 'User-Agent': 'AlchemyCut-updater', Accept: '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (hops > 6) return reject(new Error('Demasiadas redirecciones.'));
        return resolve(fetchBuffer(new URL(res.headers.location, u.href).toString(), opts, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('El servidor respondió ' + res.statusCode + '.')); }
      const total = +res.headers['content-length'] || 0, max = opts.maxBytes || MAX_ZIP;
      if (total > max) { res.resume(); return reject(new Error('El archivo es demasiado grande.')); }
      const chunks = [];
      let got = 0;
      res.on('data', (d) => {
        got += d.length;
        if (got > max) { req.destroy(new Error('El archivo es demasiado grande.')); return; }
        chunks.push(d);
        if (opts.onProgress) opts.onProgress(got, total);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('El servidor no responde.')));
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const baseUrl = (repo) => `https://github.com/${repo}/releases/latest/download`;

// Busca la última versión publicada. Devuelve { current, latest, newer, notes, asset }.
async function check({ extDir, base, insecureForTests } = {}) {
  const local = readLocal(extDir);
  if (!base && !/^[\w.-]+\/[\w.-]+$/.test(local.repo || '')) throw new Error('Esta copia no sabe dónde buscar actualizaciones.');
  const root = base || baseUrl(local.repo);
  const buf = await fetchBuffer(root + '/version.json', { maxBytes: 200 * 1024, insecureForTests });
  let info;
  try { info = JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error('El archivo de versión publicado no se puede leer.'); }
  if (!info || !/^\d+\.\d+\.\d+$/.test(String(info.version))) throw new Error('El archivo de versión publicado no es válido.');
  const asset = info.assets && info.assets[platKey()];
  if (!asset || !/^[\w.-]+\.zip$/.test(String(asset.name)) || !/^[0-9a-f]{64}$/i.test(String(asset.sha256))) throw new Error('La versión publicada no trae el paquete para este sistema.');
  return { current: local.version, latest: info.version, newer: cmpVersion(info.version, local.version) > 0, notes: String(info.notes || ''), asset, base: root };
}

// ---------- copiar archivos ----------
function copyTree(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    try { fs.chmodSync(to, st.mode); } catch (e) { /* no pasa nada */ }
  }
}
// borra un archivo o carpeta (fs.rmSync no existe en las versiones de Node más viejas)
const rmrf = (p) => {
  try {
    if (fs.rmSync) { fs.rmSync(p, { recursive: true, force: true }); return; }
    const st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) { fs.readdirSync(p).forEach((n) => rmrf(path.join(p, n))); fs.rmdirSync(p); } else fs.unlinkSync(p);
  } catch (e) { /* ya no estaba */ }
};

// Instala la versión indicada por check(). onProgress({ label, got, total, pct })
async function install({ extDir, info, onProgress, insecureForTests } = {}) {
  if (!info || !info.newer) throw new Error('No hay una versión nueva para instalar.');
  let st;
  try { st = fs.lstatSync(extDir); } catch (e) { throw new Error('No encuentro la carpeta del plugin.'); }
  if (st.isSymbolicLink()) throw new Error('Esta copia está enlazada para desarrollo: no se actualiza sola.');
  const report = (label, got, total) => { if (onProgress) onProgress({ label, got: got || 0, total: total || 0, pct: total ? Math.min(100, Math.round((got / total) * 100)) : null }); };

  report('Bajando la actualización');
  const buf = await fetchBuffer(info.base + '/' + info.asset.name, { insecureForTests, onProgress: (g, t) => report('Bajando la actualización', g, t) });
  if (info.asset.size && buf.length !== +info.asset.size) throw new Error('La descarga quedó incompleta. Probá de nuevo.');
  if (sha256(buf).toLowerCase() !== String(info.asset.sha256).toLowerCase()) throw new Error('La actualización no coincide con su huella de seguridad: no se instaló.');

  report('Preparando…');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemycut-update-'));
  const backup = path.join(tmp, 'backup');
  const replaced = [];
  try {
    const zip = path.join(tmp, 'update.zip');
    fs.writeFileSync(zip, buf);
    const out = path.join(tmp, 'x');
    await require('./setup').unzip(zip, out);
    const entries = fs.readdirSync(out);
    const rootName = entries.length === 1 && fs.statSync(path.join(out, entries[0])).isDirectory() ? entries[0] : null;
    const root = rootName ? path.join(out, rootName) : out;
    for (const must of ['index.html', 'CSXS/manifest.xml', 'js/main.js', 'engine/lib.js', 'version.json']) {
      if (!fs.existsSync(path.join(root, must))) throw new Error('El paquete descargado está incompleto (' + must + ').');
    }
    const incoming = readLocal(root);
    if (incoming.version !== info.latest) throw new Error('El paquete no es la versión que se anunció.');

    report('Instalando…');
    fs.mkdirSync(backup, { recursive: true });
    for (const name of fs.readdirSync(root)) {
      const dest = path.join(extDir, name), src = path.join(root, name);
      if (fs.existsSync(dest)) { copyTree(dest, path.join(backup, name)); replaced.push({ name, had: true }); } else replaced.push({ name, had: false });
      rmrf(dest);
      copyTree(src, dest);
    }
    // Mac: el whisper-cli que viene en el paquete tiene que poder ejecutarse, y la copia ya instalada se renueva
    if (process.platform === 'darwin') {
      const bundled = path.join(extDir, 'engine', 'bin', 'mac', 'whisper-cli');
      if (fs.existsSync(bundled)) {
        try { fs.chmodSync(bundled, 0o755); } catch (e) {}
        const cpx = require('child_process');
        try { cpx.execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', extDir], { stdio: 'ignore' }); } catch (e) {}
        const installed = path.join(os.homedir(), '.alchemycut', 'bin', 'whisper', 'whisper-cli');
        if (fs.existsSync(installed) && sha256(fs.readFileSync(installed)) !== sha256(fs.readFileSync(bundled))) {
          fs.copyFileSync(bundled, installed); fs.chmodSync(installed, 0o755);
          try { cpx.execFileSync('/usr/bin/xattr', ['-c', installed], { stdio: 'ignore' }); } catch (e) {}
          try { cpx.execFileSync('/usr/bin/codesign', ['-s', '-', '-f', installed], { stdio: 'ignore' }); } catch (e) {}
        }
      }
    }
    return { version: info.latest };
  } catch (err) {
    // volver a lo que había
    for (const r of replaced.reverse()) {
      try { rmrf(path.join(extDir, r.name)); if (r.had) copyTree(path.join(backup, r.name), path.join(extDir, r.name)); } catch (e) { /* mejor esfuerzo */ }
    }
    throw err;
  } finally { rmrf(tmp); }
}

module.exports = { check, install, cmpVersion, readLocal, sha256, fetchBuffer };
