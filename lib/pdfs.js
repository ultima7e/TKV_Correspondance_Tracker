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
};
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
function davAuth() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64');
}
const decodeXml = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");

const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';
// List the immediate child names of a WebDAV folder (files + subfolders), minus
// the folder itself. Throws on HTTP error so callers can fall back / report.
async function listNamesRaw(pathStr) {
  const auth = davAuth();
  if (!auth) return [];
  const res = await fetch(DAV_BASE + encPath(pathStr) + '/', {
    method: 'PROPFIND',
    headers: { Authorization: auth, Depth: '1', 'Content-Type': 'application/xml' },
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

// For each letter, set letterUrl to the streaming endpoint when a PDF for it
// exists. Only lists each category folder once (cached). Never throws.
async function attachPdfUrls(letters) {
  const cats = [...new Set(letters.map((l) => l.category))].filter((c) => FOLDERS[c]);
  const listings = {};
  await Promise.all(cats.map(async (c) => { try { listings[c] = await listCategory(c); } catch { listings[c] = null; } }));
  for (const l of letters) {
    const names = listings[l.category];
    if (!names) continue;
    const n = tailNum(l.letterNumber);
    if (n && names.some((name) => numRe(n).test(name))) {
      l.letterUrl = `/api/letter-pdf?cat=${encodeURIComponent(l.category)}&n=${encodeURIComponent(n)}`;
    }
  }
  return letters;
}

// Find the PDF for cat+num and stream it inline. Writes the HTTP response.
async function streamPdf(cat, num, res) {
  const auth = davAuth();
  if (!auth || !FOLDERS[cat]) { res.status(500).end('Storage not configured'); return; }
  let path;
  try { path = await resolvePdf(cat, num); } catch (e) { res.status(502).end('Storage error: ' + e.message); return; }
  if (!path) {
    res.setHeader('Content-Type', 'text/html');
    res.status(404).end('<p style="font-family:sans-serif;padding:2rem;color:#64748b">No PDF found for this letter yet. Upload it to the letter’s folder in Nutstore with the number at the start of the filename.</p>');
    return;
  }
  const r = await fetch(DAV_BASE + encPath(path), { headers: { Authorization: auth } });
  if (!r.ok) { res.status(502).end(`Fetch failed ${r.status}`); return; }
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${num}.pdf"`);
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

module.exports = { attachPdfUrls, streamPdf, resolvePdf, hasPdf, debugCategory, FOLDERS };
