// Auto-link letter PDFs by number — no manual URL pasting.
//
// Letters live in `Letter Recordings/<Category>/`, ONE SUBFOLDER PER LETTER named
// starting with the letter number (e.g. "986_Submission ...", "959_SINOHYDRO_ ..."),
// with the PDF inside it (same name .pdf). Some older items are loose PDFs in the
// category folder instead, so we handle both shapes. Given a letter's tail number
// we find its subfolder (or loose PDF) and stream the PDF via /api/letter-pdf, so
// Preview works the moment the PDF is filed — nothing to paste.
const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
const FOLDERS = {
  outgoing: process.env.NUTSTORE_OUT_DIR || 'Letter Recordings/Outgoing Letter',
  incoming: process.env.NUTSTORE_IN_DIR || 'Letter Recordings/Incoming Letter',
  eng_employer: process.env.NUTSTORE_ENG_DIR || 'Letter Recordings/Engineer to Employer Letter',
  // Miscellaneous letters have no number; their PDFs are flat files named after
  // the letter Subject (e.g. "Rescue and Evacuation Report.pdf").
  miscellaneous: process.env.NUTSTORE_MISC_DIR || 'Letter Recordings/Miscellaneous Letter',
};
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
function davAuth() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64');
}
const decodeXml = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");

// The "phonebook": a small file (built locally by scripts/build-pdf-index.js)
// mapping category -> letter number -> exact PDF path. Reading one small file
// sidesteps Nutstore's 750-item directory-listing cap entirely.
const INDEX_PATH = process.env.NUTSTORE_PDF_INDEX || 'Shared Folder/Letter Recording/pdf-index.json';
let _index = null, _indexAtt = null, _indexTs = 0;
async function loadIndex() {
  if (_index && Date.now() - _indexTs < 60000) return _index;
  const auth = davAuth();
  if (!auth) return _index;
  try {
    const r = await fetch(DAV_BASE + encPath(INDEX_PATH), { headers: { Authorization: auth } });
    if (!r.ok) return _index;                 // keep last good copy on a hiccup
    const data = JSON.parse(await r.text());
    _index = data && data.paths ? data.paths : {};
    _indexAtt = data && data.attachments ? data.attachments : {};
    _indexTs = Date.now();
  } catch { /* keep last good copy */ }
  return _index;
}
// Attachments map (cat -> num -> [{name, path}]); populated by loadIndex.
function indexAttachments() { return _indexAtt || {}; }

const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';
// List the immediate child names of a WebDAV folder (files + subfolders), minus
// the folder itself. Throws on HTTP error so callers can fall back / report.
async function listNamesRaw(pathStr, depth = '1') {
  const auth = davAuth();
  if (!auth) return [];
  const url = DAV_BASE + (pathStr ? encPath(pathStr) + '/' : '');
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: auth, Depth: depth, 'Content-Type': 'application/xml' },
    body: PROPFIND_BODY,
  });
  if (!res.ok) throw new Error(`PROPFIND ${res.status} ${res.statusText} for "${pathStr}"`);
  const xml = await res.text();
  let names = [...xml.matchAll(/<[a-z0-9]*:?displayname>([^<]*)<\/[a-z0-9]*:?displayname>/gi)].map((m) => decodeXml(m[1]));
  if (!names.length) {
    names = [...xml.matchAll(/<[a-z0-9]*:?href>([^<]+)<\/[a-z0-9]*:?href>/gi)].map((m) => {
      try { const p = m[1].replace(/\/+$/, '').split('/'); return decodeURIComponent(p[p.length - 1]); } catch { return ''; }
    });
  }
  const self = pathStr.split('/').filter(Boolean).pop();
  return names.filter((n) => n && n !== self);
}

// Cache category-folder listings briefly (they're the hot path; per-letter
// subfolders are only listed on an actual Preview click).
const _cache = {};
const TTL = 60000;
async function listCategory(cat) {
  const c = _cache[cat];
  if (c && Date.now() - c.ts < TTL) return c.names;
  const names = await listNamesRaw(FOLDERS[cat]);
  _cache[cat] = { ts: Date.now(), names };
  return names;
}

// Skip attachment scans and Gmail printouts — they aren't the letter itself.
const isAttach = (n) => /attachment|gmail/i.test(n);
const isFile = (n) => /\.[a-z0-9]{1,5}$/i.test(n);
const numRe = (num) => new RegExp('^\\s*0*' + num + '(?=\\D|$)');
const tailNum = (ln) => { const m = /(\d+)\s*$/.exec(String(ln || '')); return m ? m[1] : null; };

// Does the category folder contain an entry (subfolder or loose PDF) for this
// number? Cheap check used to decide whether to show Preview. Never throws.
async function hasPdf(cat, num) {
  try { return listCategory(cat).then((names) => names.some((n) => numRe(num).test(n))); }
  catch { return false; }
}

// Resolve the actual PDF path for cat+num: a loose PDF in the folder, or the PDF
// inside the letter's subfolder. Returns the WebDAV path or null.
async function resolvePdf(cat, num) {
  if (!FOLDERS[cat]) return null;
  const top = await listCategory(cat);
  const hits = top.filter((n) => numRe(num).test(n));
  if (!hits.length) return null;
  const flat = hits.find((n) => /\.pdf$/i.test(n) && !isAttach(n));
  if (flat) return FOLDERS[cat] + '/' + flat;
  const sub = hits.find((n) => !isFile(n)) || hits[0];
  const inner = await listNamesRaw(FOLDERS[cat] + '/' + sub);
  const pdf = inner.find((n) => /\.pdf$/i.test(n) && !isAttach(n) && numRe(num).test(n))
    || inner.find((n) => /\.pdf$/i.test(n) && !isAttach(n));
  return pdf ? FOLDERS[cat] + '/' + sub + '/' + pdf : null;
}

// The letter-identifying part of an indexed path (its subfolder/file name minus
// the leading number and extension), used to sanity-check the phonebook points
// at the same letter as the record.
function pathLetterName(p) {
  const parts = String(p).split('/');
  const name = parts[2] || parts[parts.length - 1] || '';
  return name.replace(/\.pdf$/i, '').replace(/^\s*0*\d+[)\s_.\-]*/, '');
}
const sigWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3);
// True if the phonebook folder name plausibly matches the record subject (so we
// can trust overriding a stored link). Folders too short to judge default true.
function sameLetter(recSubject, folderName) {
  const A = new Set(sigWords(recSubject));
  const B = sigWords(folderName);
  if (B.length < 2) return true;                 // too short to judge -> trust it
  let hit = 0; for (const w of B) if (A.has(w)) hit++;
  return hit / B.length >= 0.2;                  // rejects clear mismatches (~0), keeps reworded-but-same
}

// ---- Miscellaneous letters: matched by SUBJECT, not number ----
const normName = (s) => String(s || '').toLowerCase().replace(/\.pdf$/i, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
// Pick the misc-folder PDF that best matches a letter subject. An exact
// (normalized) filename wins; otherwise the PDF whose significant words are
// mostly shared with the subject, above a confidence threshold. Returns the
// filename or null. Pure — unit-tested without WebDAV.
function matchMisc(names, subject) {
  const target = normName(subject);
  if (!target) return null;
  const pdfs = (names || []).filter((n) => /\.pdf$/i.test(n) && !isAttach(n));
  const exact = pdfs.find((n) => normName(n) === target);
  if (exact) return exact;
  const tw = new Set(target.split(' ').filter((w) => w.length > 3));
  if (!tw.size) return null;
  let best = null, bestScore = 0;
  for (const n of pdfs) {
    const nw = normName(n).split(' ').filter((w) => w.length > 3);
    if (!nw.length) continue;
    let hit = 0; for (const w of nw) if (tw.has(w)) hit++;
    const score = hit / nw.length;
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return bestScore >= 0.6 ? best : null;
}
// Resolve the WebDAV path of the misc PDF for a subject (lists the flat folder).
async function resolveMiscPdf(subject) {
  const names = await listCategory('miscellaneous');
  const hit = matchMisc(names, subject);
  return hit ? FOLDERS.miscellaneous + '/' + hit : null;
}

// Point each letter's Preview at the phonebook PDF (built from the real files by
// number). Applied ONLY when the folder plausibly refers to the same letter, so
// a mis-filed folder never swaps in a wrong PDF — even for letters that had no
// link before. Reads one small index file (no listing cap). Misc letters resolve
// by subject against the flat misc folder. Never throws.
async function attachPdfUrls(letters) {
  const idx = (await loadIndex()) || {};
  let miscNames = null;
  if (letters.some((l) => l.category === 'miscellaneous')) {
    try { miscNames = await listCategory('miscellaneous'); } catch { miscNames = []; }
  }
  for (const l of letters) {
    if (l.category === 'miscellaneous') {
      if (miscNames && miscNames.length && matchMisc(miscNames, l.subject)) {
        l.letterUrl = `/api/letter-pdf?cat=miscellaneous&subj=${encodeURIComponent(l.subject)}`;
      }
      continue;
    }
    const n = tailNum(l.letterNumber);
    const path = n && idx[l.category] ? idx[l.category][n] : null;
    if (path && sameLetter(l.subject, pathLetterName(path))) {
      l.letterUrl = `/api/letter-pdf?cat=${encodeURIComponent(l.category)}&n=${encodeURIComponent(n)}`;
      // Same folder, same letter -> its attachment files are authoritative too.
      const list = (indexAttachments()[l.category] || {})[n];
      if (list && list.length) {
        l.attachments = list.map((a, i) => ({ name: a.name, url: `/api/letter-file?cat=${encodeURIComponent(l.category)}&n=${encodeURIComponent(n)}&i=${i}` }));
      }
    }
  }
  return letters;
}

// Stream the i-th attachment of a letter (resolved from the phonebook, so the
// client never supplies a path). Inline for viewable types, download otherwise.
const ATT_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dwg: 'application/acad' };
async function streamAttachment(cat, num, i, res) {
  const auth = davAuth();
  if (!auth) { res.status(500).end('Storage not configured'); return; }
  await loadIndex();
  const list = (indexAttachments()[cat] || {})[num];
  const att = list && list[i];
  if (!att || !att.path) { res.status(404).end('Attachment not found'); return; }
  const r = await fetch(DAV_BASE + encPath(att.path), { headers: { Authorization: auth } });
  if (!r.ok) { res.status(502).end(`Fetch failed ${r.status}`); return; }
  const buf = Buffer.from(await r.arrayBuffer());
  const name = String(att.name || 'attachment').replace(/[\r\n"]/g, '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  const inline = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
  res.setHeader('Content-Type', ATT_MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.status(200).end(buf);
}

// Find the PDF for cat+num and stream it inline. Writes the HTTP response.
// Prefers the phonebook (exact path, no listing cap); falls back to a folder
// listing for small folders not covered by the index.
async function streamPdf(cat, num, res, subj) {
  const auth = davAuth();
  if (!auth || !FOLDERS[cat]) { res.status(500).end('Storage not configured'); return; }
  let path = null;
  if (cat === 'miscellaneous') {
    // Misc letters have no number — resolve by matching the subject to the
    // flat PDF filenames in the misc folder.
    try { path = await resolveMiscPdf(subj); } catch (e) { res.status(502).end('Storage error: ' + e.message); return; }
  } else {
    const idx = await loadIndex();
    if (idx && idx[cat] && idx[cat][num]) path = idx[cat][num];
    if (!path) { try { path = await resolvePdf(cat, num); } catch (e) { res.status(502).end('Storage error: ' + e.message); return; } }
  }
  if (!path) {
    res.setHeader('Content-Type', 'text/html');
    const hint = cat === 'miscellaneous'
      ? 'No PDF found for this letter yet. Upload it to the Miscellaneous folder in Nutstore, named to match the letter’s Subject.'
      : 'No PDF found for this letter yet. Upload it to the letter’s folder in Nutstore with the number at the start of the filename.';
    res.status(404).end(`<p style="font-family:sans-serif;padding:2rem;color:#64748b">${hint}</p>`);
    return;
  }
  const r = await fetch(DAV_BASE + encPath(path), { headers: { Authorization: auth } });
  if (!r.ok) { res.status(502).end(`Fetch failed ${r.status}`); return; }
  const buf = Buffer.from(await r.arrayBuffer());
  const fname = String(num || subj || 'letter').replace(/[^a-z0-9 _.-]/gi, '_').slice(0, 80);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fname}.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.status(200).end(buf);
}

// Diagnostic: what does the app's account actually see in the category folder?
async function debugCategory(cat, num) {
  if (!FOLDERS[cat]) return { error: 'unknown cat ' + cat };
  try {
    const names = await listNamesRaw(FOLDERS[cat]); // uncached
    const numeric = names.map((n) => { const m = /^\s*0*(\d+)/.exec(n); return m ? +m[1] : null; }).filter((x) => x != null).sort((a, b) => a - b);
    return {
      folder: FOLDERS[cat],
      count: names.length,
      highestNumber: numeric[numeric.length - 1] || null,
      lowestNumber: numeric[0] || null,
      matches: names.filter((n) => numRe(num).test(n)),
      near: names.filter((n) => /^\s*0*98\d/.test(n)),
      first5: names.slice(0, 5),
      last5: names.slice(-5),
    };
  } catch (e) { return { folder: FOLDERS[cat], error: e.message }; }
}

// Diagnostic: list ANY WebDAV path the app account can reach (admin-only use).
async function debugPath(pathStr, depth) {
  try {
    const names = await listNamesRaw(pathStr, depth || '1');
    const numeric = names.map((n) => { const m = /^\s*0*(\d+)/.exec(n); return m ? +m[1] : null; }).filter((x) => x != null).sort((a, b) => a - b);
    return { path: pathStr, depth: depth || '1', count: names.length, highestNumber: numeric[numeric.length - 1] || null, has985: names.some((n) => /^\s*0*985/.test(n)), has986: names.some((n) => /^\s*0*986/.test(n)) };
  } catch (e) { return { path: pathStr, depth: depth || '1', error: e.message }; }
}

// Diagnostic: can the app fetch a specific file by its exact path? (GET is not
// subject to the 750-item listing cap.) HEAD avoids downloading the whole PDF.
async function debugGet(pathStr) {
  const auth = davAuth();
  if (!auth) return { error: 'no auth' };
  try {
    const r = await fetch(DAV_BASE + encPath(pathStr), { method: 'HEAD', headers: { Authorization: auth } });
    return { path: pathStr, status: r.status, ok: r.ok, contentType: r.headers.get('content-type'), size: r.headers.get('content-length') };
  } catch (e) { return { path: pathStr, error: e.message }; }
}

module.exports = { attachPdfUrls, streamPdf, streamAttachment, resolvePdf, resolveMiscPdf, matchMisc, hasPdf, debugCategory, debugPath, debugGet, FOLDERS };
