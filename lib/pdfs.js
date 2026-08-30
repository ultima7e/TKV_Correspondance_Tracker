// Auto-link letter PDFs by number — no manual URL pasting.
//
// Every letter PDF in Nutstore is named starting with the letter's number
// (e.g. "985- Subject.pdf", "327- ... (2).pdf"). We list the category's folder
// over WebDAV, find the file whose name starts with the letter's tail number
// (leading zeros ok, next char non-digit, attachments excluded), and point the
// letter's Preview at /api/letter-pdf which streams that file. So the moment a
// PDF is uploaded, its Preview works — nothing to paste.
const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
const FOLDERS = {
  outgoing: process.env.NUTSTORE_OUT_DIR || 'Shared Folder/Letter Recording/Outgoing Letter',
  incoming: process.env.NUTSTORE_IN_DIR || 'Shared Folder/Letter Recording/Incoming Letter/From Engineer',
  eng_employer: process.env.NUTSTORE_ENG_DIR || 'Shared Folder/Letter Recording/Incoming Letter/Engineer to Employer',
};
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
function davAuth() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64');
}

const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>';
async function listFolderRaw(cat) {
  const auth = davAuth();
  const folder = FOLDERS[cat];
  if (!auth || !folder) return [];
  const res = await fetch(DAV_BASE + encPath(folder) + '/', {
    method: 'PROPFIND',
    headers: { Authorization: auth, Depth: '1', 'Content-Type': 'application/xml' },
    body: PROPFIND_BODY,
  });
  if (!res.ok) throw new Error(`PROPFIND ${res.status} ${res.statusText}`);
  const xml = await res.text();
  // Prefer <displayname> (raw filename); fall back to <href> basenames.
  let names = [...xml.matchAll(/<[a-z0-9]*:?displayname>([^<]*)<\/[a-z0-9]*:?displayname>/gi)].map((m) => m[1]);
  if (!names.some((n) => /\.pdf$/i.test(n))) {
    names = [...xml.matchAll(/<[a-z0-9]*:?href>([^<]+)<\/[a-z0-9]*:?href>/gi)].map((m) => {
      try { const parts = m[1].split('/').filter(Boolean); return decodeURIComponent(parts[parts.length - 1]); } catch { return ''; }
    });
  }
  return names.filter((n) => /\.pdf$/i.test(n));
}

// Short in-memory cache so repeated loads on a warm instance don't re-list.
const _cache = {};
const TTL = 60000;
async function listFolder(cat) {
  const c = _cache[cat];
  if (c && Date.now() - c.ts < TTL) return c.files;
  const files = await listFolderRaw(cat);
  _cache[cat] = { ts: Date.now(), files };
  return files;
}

const isAttach = (n) => /attachment/i.test(n);
function matchName(files, num) {
  const re = new RegExp('^\\s*0*' + num + '(?=\\D|$)');
  return (files || []).find((f) => re.test(f) && !isAttach(f)) || null;
}
const tailNum = (ln) => { const m = /(\d+)\s*$/.exec(String(ln || '')); return m ? m[1] : null; };

// For each letter, if a matching PDF exists in its folder, set letterUrl to our
// streaming endpoint. Lists each needed folder once. Never throws.
async function attachPdfUrls(letters) {
  const cats = [...new Set(letters.map((l) => l.category))].filter((c) => FOLDERS[c]);
  const listings = {};
  await Promise.all(cats.map(async (c) => { try { listings[c] = await listFolder(c); } catch { listings[c] = null; } }));
  for (const l of letters) {
    const files = listings[l.category];
    if (!files) continue;
    const n = tailNum(l.letterNumber);
    if (n && matchName(files, n)) l.letterUrl = `/api/letter-pdf?cat=${encodeURIComponent(l.category)}&n=${encodeURIComponent(n)}`;
  }
  return letters;
}

// Find the PDF for cat+num and stream it inline. Writes the HTTP response.
async function streamPdf(cat, num, res) {
  const auth = davAuth();
  if (!auth || !FOLDERS[cat]) { res.status(500).end('Storage not configured'); return; }
  let files;
  try { files = await listFolder(cat); } catch (e) { res.status(502).end('Storage error: ' + e.message); return; }
  const name = matchName(files, num);
  if (!name) {
    res.setHeader('Content-Type', 'text/html');
    res.status(404).end('<p style="font-family:sans-serif;padding:2rem;color:#64748b">No PDF found for this letter yet. Upload it to Nutstore with the letter number at the start of the filename.</p>');
    return;
  }
  const r = await fetch(DAV_BASE + encPath(FOLDERS[cat]) + '/' + encodeURIComponent(name), { headers: { Authorization: auth } });
  if (!r.ok) { res.status(502).end(`Fetch failed ${r.status}`); return; }
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${num}.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.status(200).end(buf);
}

module.exports = { attachPdfUrls, streamPdf, listFolder, matchName, FOLDERS };
