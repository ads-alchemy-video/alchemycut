#!/usr/bin/env node
'use strict';
// Uso: node engine/cli.js <video> [--silence-db -35] [--min-silence 0.4] [--pad 0.1]
//        [--fillers] [--captions out.srt] [--lang es] [--json]
// La key de ElevenLabs se lee de ELEVENLABS_API_KEY (solo hace falta con --fillers/--captions).
const fs = require('fs');
const { analyze, buildCaptions, toSrt } = require('./lib');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const val = (n, d) => (argv.includes('--' + n) ? argv[argv.indexOf('--' + n) + 1] : d);
const optValues = ['captions', 'lang', 'provider', 'model', 'max-chars', 'max-lines'].map((n) => val(n));
const input = argv.find((a) => !a.startsWith('--') && !/^-?[\d.]+$/.test(a) && !optValues.includes(a));

if (!input) {
  console.error('Uso: node engine/cli.js <video> [--fillers] [--captions out.srt] [--lang es] [--json]');
  process.exit(2);
}

analyze({
  input,
  noiseDb: parseFloat(val('silence-db', '-35')),
  minSilence: parseFloat(val('min-silence', '0.4')),
  pad: parseFloat(val('pad', '0.1')),
  fillers: flag('fillers'),
  captions: flag('captions'),
  language: val('lang', 'auto'),
  provider: val('provider', 'elevenlabs'),
  model: val('model', 'small'),
  apiKey: val('provider', 'elevenlabs') === 'openai' ? process.env.OPENAI_API_KEY : process.env.ELEVENLABS_API_KEY,
})
  .then((r) => {
    if (flag('captions')) {
      const lines = buildCaptions(r.words, r.removed, { dropped: r.dropped, maxChars: parseInt(val('max-chars', '24'), 10), maxLines: parseInt(val('max-lines', '1'), 10) });
      fs.writeFileSync(val('captions'), toSrt(lines));
    }
    if (flag('json')) return console.log(JSON.stringify(r, null, 2));
    console.log(`Duración: ${r.duration.toFixed(2)}s · silencios: ${r.silences} · cortes: ${r.removed.length} · ahorro: ${r.saved.toFixed(2)}s`);
    for (const c of r.removed) console.log(`  - ${c.start.toFixed(2)}–${c.end.toFixed(2)}  ${c.reason}`);
  })
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
