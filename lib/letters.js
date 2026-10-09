// Correspondence Tracker data: reads/writes LetterTracker_Data.json straight
// from Nutstore over WebDAV (same protocol as api/data.js's workbook/XER
// fetches), so the hosted tracker and the desktop file stay one source of
// truth. Local dev without NUTSTORE_USER/PASSWORD falls back to a JSON file
// under data/.
const fs = require('fs');
const path = require('path');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
// NUTSTORE_LETTERS_PATH is the documented name; NUTSTORE_FILE_PATH is accepted
// as an alias so either spelling set in the environment takes effect.
const LETTERS_PATH = process.env.NUTSTORE_LETTERS_PATH ||
  process.env.NUTSTORE_FILE_PATH ||
  'Shared Folder/Letter Recording/LetterTracker_Data.json';
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

const SAMPLE_PATH = path.join(__dirname, '..', 'data', 'sample-letters.json');
const LOCAL_OVERRIDE_PATH = path.join(__dirname, '..', 'data', '.letters_local.json');

function davHeaders() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return { Authorization: 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Nutstore WebDAV occasionally returns transient errors (503 Service Unavailable,
// 429 throttling, 5xx). Retry those with backoff, and keep the last good copy so
// a brief hiccup serves slightly-stale data instead of blanking the whole app.
let _lettersCache = null, _lettersCacheTs = 0;
const LETTERS_TTL = 60000; // ms — reuse a cached copy this long to cut Nutstore requests
async function readLettersRaw() {
  const headers = davHeaders();
  if (headers) {
    if (_lettersCache && Date.now() - _lettersCacheTs < LETTERS_TTL) return _lettersCache;
    const url = DAV_BASE + encPath(LETTERS_PATH);
    const backoff = [400, 900, 1500]; // retries after the first attempt
    for (let i = 0; i <= backoff.length; i++) {
      let res;
      try {
        res = await fetch(url, { headers });
      } catch (netErr) {
        if (i < backoff.length) { await sleep(backoff[i]); continue; }
        if (_lettersCache) return _lettersCache;
        throw netErr;
      }
      if (res.ok) { const text = await res.text(); _lettersCache = text; _lettersCacheTs = Date.now(); return text; }
      const transient = [429, 500, 502, 503, 504].includes(res.status);
      if (transient && i < backoff.length) { await sleep(backoff[i]); continue; }
      // Transient but retries exhausted -> serve last-known-good rather than blank.
      if (transient && _lettersCache) return _lettersCache;
      let body = '';
      try { body = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* ignore */ }
      throw new Error(`Nutstore responded ${res.status} ${res.statusText} for letters file${body ? ' — ' + body : ''}`);
    }
  }
  if (fs.existsSync(LOCAL_OVERRIDE_PATH)) return fs.readFileSync(LOCAL_OVERRIDE_PATH, 'utf8');
  return fs.readFileSync(SAMPLE_PATH, 'utf8');
}

async function writeLettersRaw(text) {
  const headers = davHeaders();
  if (headers) {
    const res = await fetch(DAV_BASE + encPath(LETTERS_PATH), { method: 'PUT', headers, body: text });
    if (!res.ok) throw new Error(`Nutstore PUT failed ${res.status} ${res.statusText} for letters file`);
    _lettersCache = text; _lettersCacheTs = Date.now(); // keep the cache fresh after an admin edit
    return;
  }
  fs.mkdirSync(path.dirname(LOCAL_OVERRIDE_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_OVERRIDE_PATH, text);
}

// A letter's department field is "/"-joined for multi-department letters,
// e.g. "QA/Design" — matches either role.
function deptsOf(letter) {
  return String(letter.department || '').split('/').map((s) => s.trim()).filter(Boolean);
}

function filterLettersForUser(letters, me) {
  if (me.isAdmin || !me.departments || !me.departments.length) return letters;
  const allowed = new Set(me.departments);
  return letters.filter((l) => deptsOf(l).some((d) => allowed.has(d)));
}

module.exports = { readLettersRaw, writeLettersRaw, deptsOf, filterLettersForUser, LETTERS_PATH };
