/* AlchemyCut — copiar y pegar con el teclado.
 * Dentro de Premiere los atajos Cmd/Ctrl + C, V, X y A se los queda el programa y nunca llegan al panel
 * (solo andaba el clic derecho). Se le pide a Premiere que los deje pasar y se resuelven acá a mano. */
(function () {
  'use strict';
  var req = window.require || (window.cep_node && window.cep_node.require);
  var cp = null, os = null;
  try { cp = req && req('child_process'); os = req && req('os'); } catch (e) {}
  var plat = os && os.platform ? os.platform() : '';

  // 1) que Premiere deje pasar estos atajos al panel
  try {
    if (window.__adobe_cep__ && window.__adobe_cep__.registerKeyEventsInterest) {
      var list = [];
      [65, 67, 86, 88].forEach(function (k) { list.push({ keyCode: k, metaKey: true }); list.push({ keyCode: k, ctrlKey: true }); });
      window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify(list));
    }
  } catch (e) {}

  // 2) portapapeles del sistema
  var UTF8 = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  function readClip() {
    try {
      if (cp && plat === 'darwin') return cp.execFileSync('/usr/bin/pbpaste', [], { env: Object.assign({}, process.env, UTF8), encoding: 'utf8', timeout: 4000 });
      if (cp && plat === 'win32') {
        return cp.execFileSync('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $t=Get-Clipboard -Raw; if($t){[Console]::Out.Write($t)}'],
          { encoding: 'utf8', timeout: 6000, windowsHide: true });
      }
    } catch (e) {}
    return null;
  }
  function writeClip(text) {
    try {
      if (cp && plat === 'darwin') { cp.execFileSync('/usr/bin/pbcopy', [], { input: text, env: Object.assign({}, process.env, UTF8), timeout: 4000 }); return true; }
      if (cp && plat === 'win32') {
        var b64 = Buffer.from(text, 'utf8').toString('base64');
        cp.execFileSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + b64 + '")))'],
          { timeout: 6000, windowsHide: true });
        return true;
      }
    } catch (e) {}
    try { return document.execCommand('copy'); } catch (e) {}
    return false;
  }

  function isText(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return /^(text|number|password|search|tel|url|email)$/i.test(el.type);
  }
  function selected(el) {
    var t = '';
    try { if (typeof el.selectionStart === 'number') t = el.value.substring(el.selectionStart, el.selectionEnd); } catch (e) {}
    if (!t) { try { t = String(window.getSelection()); } catch (e) {} }
    return t;
  }

  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    var k = (e.key || '').toLowerCase(), el = document.activeElement;
    if (!isText(el) || (k !== 'a' && k !== 'c' && k !== 'x' && k !== 'v')) return;
    e.preventDefault();
    if (k === 'a') { el.select(); return; }
    if (k === 'c' || k === 'x') {
      var t = selected(el);
      if (!t) return;
      writeClip(t);
      if (k === 'x' && !el.readOnly) { try { document.execCommand('delete'); } catch (err) {} }
      return;
    }
    // pegar
    if (el.readOnly || el.disabled) return;
    var txt = readClip();
    if (txt == null || txt === '') return;
    if (el.tagName !== 'TEXTAREA') txt = txt.replace(/\r?\n/g, ' ');
    var ok = false;
    try { ok = document.execCommand('insertText', false, txt); } catch (err) {}
    if (!ok && typeof el.setRangeText === 'function' && typeof el.selectionStart === 'number') {
      el.setRangeText(txt, el.selectionStart, el.selectionEnd, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, true);
})();
