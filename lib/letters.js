// Correspondence Tracker data: reads/writes LetterTracker_Data.json straight
// from Nutstore over WebDAV (same protocol as api/data.js's workbook/XER
// fetches), so the hosted tracker and the desktop file stay one source of
// truth. Local dev without NUTSTORE_USER/PASSWORD falls back to a JSON file
// under data/.
const fs = require('fs');
const path = require('path');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
const LETTERS_PATH = process.env.NUTSTORE_LETTERS_PATH ||
  'Shared Folder/Letter Recording/LetterTracker_Data.json';
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

const SAMPLE_PATH = path.join(__dirname, '..', 'data', 'sample-letters.json');
const LOCAL_OVERRIDE_PATH = path.join(__dirname, '..', 'data', '.letters_local.json');

function davHeaders() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return { Authorization: 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64') };
}

async function readLettersRaw() {
  const headers = davHeaders();
  if (headers) {
    const res = await fetch(DAV_BASE + encPath(LETTERS_PATH), { headers });
    if (!res.ok) throw new Error(`Nutstore responded ${res.status} ${res.statusText} for letters file`);
    return await res.text();
  }
  if (fs.existsSync(LOCAL_OVERRIDE_PATH)) return fs.readFileSync(LOCAL_OVERRIDE_PATH, 'utf8');
  return fs.readFileSync(SAMPLE_PATH, 'utf8');
}

async function writeLettersRaw(text) {
  const headers = davHeaders();
  if (headers) {
    const res = await fetch(DAV_BASE + encPath(LETTERS_PATH), { method: 'PUT', headers, body: text });
    if (!res.ok) throw new Error(`Nutstore PUT failed ${res.status} ${res.statusText} for letters file`);
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
