// Builds the "phonebook" the tracker uses to find each letter's PDF.
//
// It reads your local Nutstore letter folders (where ALL letters are visible —
// no 750 limit, because it's your own disk), and writes one small file,
//   Shared Folder/Letter Recording/pdf-index.json
// mapping each letter number -> the exact path of its PDF. The hosted tracker
// reads that small file and fetches each PDF directly (a direct fetch is not
// subject to Nutstore's 750-item listing cap).
//
// It ONLY reads your letters and writes that single index file. Nothing else in
// Nutstore is touched. Run it whenever letters change (or on a schedule).
const fs = require('fs');
const path = require('path');
const os = require('os');

// Local Nutstore root. Portable across devices: NUTSTORE_ROOT env wins, else try
// the standard "<home>/Nutstore/1", else a couple of common fallbacks. This lets
// the exact same script run on any PC that has Nutstore synced.
function detectRoot() {
  if (process.env.NUTSTORE_ROOT) return process.env.NUTSTORE_ROOT;
  const candidates = [
    path.join(os.homedir(), 'Nutstore', '1'),
    path.join(os.homedir(), 'Nutstore'),
    'C:/Users/bhsag/Nutstore/1',
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'Letter Recordings'))) return c;
  }
  return candidates[0];
}
const ROOT = detectRoot();

// tracker category -> folder (relative to ROOT). These relative paths are also
// exactly what the hosted app fetches over WebDAV, so store them as-is.
const CATS = {
  outgoing: 'Letter Recordings/Outgoing Letter',
  incoming: 'Letter Recordings/Incoming Letter',
  eng_employer: 'Letter Recordings/Engineer to Employer Letter',
};
const OUT = path.join(ROOT, 'Shared Folder/Letter Recording/pdf-index.json');

const isAttach = (n) => /attachment|gmail/i.test(n);
const numOf = (n) => { const m = /^\s*0*(\d+)/.exec(n); return m ? String(+m[1]) : null; };
function pdfInFolder(dir, num) {
  let files; try { files = fs.readdirSync(dir); } catch { return null; }
  const pdfs = files.filter((f) => /\.pdf$/i.test(f) && !isAttach(f));
  const re = new RegExp('^\\s*0*' + num + '(?=\\D|$)');
  return pdfs.find((f) => re.test(f)) || pdfs[0] || null;
}
// Everything in the letter folder that ISN'T the letter itself: not the main PDF,
// not a Word source (.doc/.docx), not a temp/hidden file. These are the letter's
// attachments (reports, drawings, .zip/.rar bundles, extra PDFs). Multiple allowed.
function attachmentsInFolder(dir, mainPdf) {
  let files; try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of files) {
    if (!e.isFile()) continue;
    const n = e.name;
    if (n === mainPdf) continue;
    if (/\.docx?$/i.test(n)) continue;
    if (n.startsWith('~$') || n.startsWith('.')) continue;
    out.push(n);
  }
  return out;
}

const index = { builtAt: new Date().toISOString(), root: ROOT, paths: {}, attachments: {} };
for (const [cat, rel] of Object.entries(CATS)) {
  const dir = path.join(ROOT, rel);
  index.paths[cat] = {};
  index.attachments[cat] = {};
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { console.warn('  (skipped ' + cat + ': ' + e.code + ' ' + dir + ')'); continue; }
  for (const e of entries) {
    const num = numOf(e.name);
    if (!num) continue;
    if (e.isDirectory()) {
      const sub = path.join(dir, e.name);
      const pdf = pdfInFolder(sub, num);
      if (pdf) index.paths[cat][num] = (rel + '/' + e.name + '/' + pdf).replace(/\\/g, '/');
      const atts = attachmentsInFolder(sub, pdf);
      if (atts.length) index.attachments[cat][num] = atts.map((fn) => ({ name: fn, path: (rel + '/' + e.name + '/' + fn).replace(/\\/g, '/') }));
    } else if (/\.pdf$/i.test(e.name) && !isAttach(e.name)) {
      index.paths[cat][num] = (rel + '/' + e.name).replace(/\\/g, '/');
    }
  }
}

// SAFETY: never overwrite a good phonebook with an empty one. If this device has
// no letters synced (wrong ROOT / Nutstore not downloaded here), abort and leave
// the existing pdf-index.json untouched.
const totalLetters = Object.values(index.paths).reduce((a, m) => a + Object.keys(m).length, 0);
if (totalLetters === 0) {
  console.error('ABORT: found 0 letters under ' + ROOT + ' — is Nutstore synced here? Set NUTSTORE_ROOT.');
  console.error('Leaving the existing pdf-index.json untouched.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(index));
console.log('Indexed: ' + Object.entries(index.paths).map(([c, m]) => c + '=' + Object.keys(m).length + ' (att ' + Object.keys(index.attachments[c] || {}).length + ')').join(', '));
for (const c of Object.keys(index.paths)) {
  const nums = Object.keys(index.paths[c]).map(Number).sort((a, b) => a - b);
  if (nums.length) console.log('  ' + c + ': ' + nums[0] + '..' + nums[nums.length - 1]);
}
console.log('Wrote ' + OUT);
