// Scan the codex.exe binary for reasoning-history-related config key strings.
// Reads in chunks, extracts printable ASCII runs >= 6 chars, filters for keywords.
const fs = require('fs');
const BIN = 'C:/Users/hyt/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';

const buf = fs.readFileSync(BIN);
console.log('size:', buf.length);

// Collect printable runs
const runs = [];
let cur = '';
for (let i = 0; i < buf.length; i++) {
  const c = buf[i];
  if (c >= 0x20 && c < 0x7f) {
    cur += String.fromCharCode(c);
  } else {
    if (cur.length >= 6) runs.push(cur);
    cur = '';
  }
}
if (cur.length >= 6) runs.push(cur);
console.log('runs:', runs.length);

const kw = /(reasoning|ResponseInput|item_ids|history_item|send_history|keep.*history|strip|drop)/i;
const hits = runs.filter(r => kw.test(r) && r.length < 120);
const uniq = [...new Set(hits)];
console.log('unique hits:', uniq.length);
// Show the most config-key-like ones
const keyLike = uniq.filter(r => /^[a-z0-9_\. ]+$/.test(r) || r.includes('='));
keyLike.slice(0, 80).forEach(r => console.log(' -', r));
