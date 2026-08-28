// Live overlay from the master Excel (Letters-Summary.xlsx in Nutstore).
//
// The frozen LetterTracker_Data.json holds all HISTORY and is never changed.
// From a per-category "live boundary" upward, the Excel is the source of truth:
// on every load we fetch it over the same WebDAV account as the data file, parse
// only the rows at/after the boundary, and overlay them onto the JSON. So a new
// letter typed into the Excel shows up on the next app open — no manual upload.
//
// Excel-sourced letters carry _src:'xlsx' and are treated as read-only by the UI
// and stripped on save, so they never get baked into the frozen JSON.
const XLSX = require('xlsx');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
const EXCEL_PATH = process.env.NUTSTORE_EXCEL_PATH ||
  'Shared Folder/Letter Recording/Letters Summary.xlsx';
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

// Per-category boundary: the Excel drives everything from these numbers UP.
// Below them the frozen JSON stays authoritative and untouched. These are the
// exact cut-over points agreed with the project team (Aug 2026).
const SHEETS = {
  incoming: '1. Incoming Letters',
  outgoing: '2. Outgoing Letters',
  eng_employer: "4. Engineer to Employer'sLetter",
};
function tailNum(ln) { const m = /(\d+)\s*$/.exec(String(ln || '')); return m ? +m[1] : null; }
function outNum(ln) { const m = /TKV\/?COM\/?(\d{4})\/?(\d+)/i.exec(String(ln || '').replace(/\s/g, '')); return m ? { year: +m[1], num: +m[2] } : null; }
const liveZone = {
  incoming: (ln) => { const n = tailNum(ln); return n != null && n >= 954; },
  outgoing: (ln) => { const o = outNum(ln); return !!o && (o.year > 2026 || (o.year === 2026 && o.num >= 972)); },
  eng_employer: (ln) => { const n = tailNum(ln); return n != null && n >= 327; },
};

// ---- cell normalization (mirrors the one-time importer) ----
function isoDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  return '';
}
function cleanRefLine(s) { return s.replace(/,?\s*dated[:\s].*/i, '').replace(/\s+/g, ' ').trim(); }
function splitRefs(c) { return c == null ? [] : String(c).split(/[\r\n]+/).map(cleanRefLine).filter(Boolean); }
function splitTags(c) { return c == null ? [] : String(c).split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean); }
function normDeptPart(p) {
  const s = p.trim().toLowerCase().replace(/[.\s]+$/, '');
  if (!s) return null;
  if (s.startsWith('plan') || s === 'schedule' || s === 'scheduling') return 'Planning & Schedule';
  const m = { design: 'Design', desing: 'Design', contract: 'Contract', qa: 'QA', qc: 'QC', ehs: 'EHS', hse: 'EHS', geology: 'Geology', geological: 'Geology', purchase: 'Purchase', construction: 'Construction', survey: 'Survey', technical: 'Technical', social: 'Social', general: 'General', admin: 'Admin', lab: 'Lab', 'all department': 'All' };
  return m[s] || p.trim().replace(/\s+/g, ' ');
}
function normDept(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const parts = String(raw).split(/[\/\r\n]+/).map(normDeptPart).filter(Boolean);
  return [...new Set(parts)].join('/');
}
function text(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }

function mapRow(row, col, category) {
  const g = (name) => { const i = col(name); return i >= 0 ? row[i] : null; };
  const letterNumber = text(g('letter no.'));
  const sinoReplies = splitRefs(g("sinohydro's reply ref.no.") || g("sinohydro's reply ref."));
  const engineerReplies = splitRefs(g("engineer's reply"));
  const hasReply = sinoReplies.length > 0 || engineerReplies.length > 0;
  const pendingStatus = (category === 'incoming' || category === 'outgoing') ? (hasReply ? 'replied' : 'pending') : '';
  return {
    id: 'xlsx:' + category + ':' + letterNumber,   // stable across loads
    createdAt: Date.parse(isoDate(g('send date'))) || 0,
    category,
    letterNumber,
    sendDate: isoDate(g('send date')),
    hardCopyDate: isoDate(g('hard copy received date')) || isoDate(g('hard copy recieve date')),
    subject: text(g('subject')),
    employerRefs: splitRefs(g("employer's ref.")),
    engineerRefs: splitRefs(g('engineer ref.')),
    sinohydroRefs: splitRefs(g('sinohydro ref.')),
    replyRefs: [],
    engineerReplies,
    sinoReplies,
    letterUrl: '',
    attachments: [],
    department: normDept(g('department')),
    status: text(g('status')),
    cc: text(g('cc:')),
    remarks: text(g('remarks')),
    attachment: text(g('attachment')),
    docTypes: splitTags(g('doc type')),
    locations: splitTags(g('location')),
    tags: splitTags(g('tags')),
    pendingStatus,
    _src: 'xlsx',
  };
}

// Parse an .xlsx buffer -> only the live-zone letters. Pure/synchronous so it
// can be unit-tested against a local file without WebDAV.
function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const out = [];
  for (const [category, sheetName] of Object.entries(SHEETS)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const mat = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const H = (mat[1] || []).map((h) => (h == null ? '' : String(h).replace(/\s+/g, ' ').trim().toLowerCase()));
    const col = (n) => H.indexOf(n.toLowerCase());
    for (let r = 2; r < mat.length; r++) {
      const row = mat[r] || [];
      const L = mapRow(row, col, category);
      if (!L.letterNumber) continue;
      if (!liveZone[category](L.letterNumber)) continue;
      out.push(L);
    }
  }
  return out;
}

// Fetch the Excel from Nutstore and parse it; return only the live-zone letters.
// Throws on fetch/parse failure so the caller can fall back to JSON-only.
async function readExcelLive() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return [];   // no creds (local dev) -> no overlay
  const headers = { Authorization: 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64') };
  const res = await fetch(DAV_BASE + encPath(EXCEL_PATH), { headers });
  if (!res.ok) throw new Error(`Nutstore ${res.status} ${res.statusText} for Excel`);
  return parseWorkbook(Buffer.from(await res.arrayBuffer()));
}

// ---- case/spelling alignment against the existing (history) vocabulary ----
// The Excel is typed by hand, so the same location/tag can appear as "SPILLWAY
// TUNNEL" or "MAT/CVT" while history uses "Spillway Tunnel" / "MAT" + "CVT". We
// snap each value to the casing history already uses (case-insensitive). A value
// that isn't known as a whole is split on "/" ONLY when every part is a known
// term (so "MAT/CVT" splits but "Mechanical/Electrical" stays whole).
function buildCaseMap(historyLetters, key) {
  const m = {};
  for (const l of historyLetters) for (const v of (l[key] || [])) {
    if (v && m[String(v).toLowerCase()] == null) m[String(v).toLowerCase()] = v;
  }
  return m;
}
function snapMulti(values, caseMap) {
  const out = [];
  for (const raw of (values || [])) {
    if (!raw) continue;
    const whole = caseMap[String(raw).toLowerCase()];
    if (whole) { out.push(whole); continue; }
    const parts = String(raw).split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => caseMap[p.toLowerCase()])) parts.forEach((p) => out.push(caseMap[p.toLowerCase()]));
    else out.push(raw);
  }
  return [...new Set(out)];
}
// Align Excel letters' locations/tags/docTypes/department to history casing.
// historyLetters should be the frozen (below-boundary) letters — the canonical
// source of correct spelling. Mutates and returns excelLetters.
function normalizeCaseAgainst(excelLetters, allJsonLetters) {
  const history = allJsonLetters.filter((l) => { const z = liveZone[l.category]; return !z || !z(l.letterNumber); });
  const locMap = buildCaseMap(history, 'locations');
  const tagMap = buildCaseMap(history, 'tags');
  const dtMap = buildCaseMap(history, 'docTypes');
  const deptMap = {};
  for (const l of history) if (l.department && deptMap[l.department.toLowerCase()] == null) deptMap[l.department.toLowerCase()] = l.department;
  for (const l of excelLetters) {
    l.locations = snapMulti(l.locations, locMap);
    l.tags = snapMulti(l.tags, tagMap);
    l.docTypes = snapMulti(l.docTypes, dtMap);
    if (l.department && deptMap[l.department.toLowerCase()]) l.department = deptMap[l.department.toLowerCase()];
  }
  return excelLetters;
}

// Overlay Excel letters onto the frozen JSON letters. Any JSON letter that falls
// in a driven live-zone is dropped in favour of the Excel version (unless the
// Excel is missing it — then the JSON copy is kept as a safety net). Everything
// below the boundary is returned untouched.
function mergeExcelLive(jsonLetters, excelLetters) {
  const keyOf = (l) => l.category + '|' + String(l.letterNumber).replace(/\s/g, '');
  const excelKeys = new Set(excelLetters.map(keyOf));
  // "Adopted" letters were originally from Excel but have been edited in the app
  // (persisted with an xlsx: id / _adopted flag). Keep them and drop the Excel
  // copy so the overlay never overwrites the user's edits on reload.
  const isAdopted = (l) => l._adopted || (typeof l.id === 'string' && l.id.indexOf('xlsx:') === 0);
  const adoptedKeys = new Set(jsonLetters.filter(isAdopted).map(keyOf));
  const kept = jsonLetters.filter((l) => {
    if (isAdopted(l)) return true;                                   // app-owned edit -> keep
    const zone = liveZone[l.category];
    if (!zone || !zone(l.letterNumber)) return true;                 // below boundary / not driven -> frozen
    return !excelKeys.has(keyOf(l));                                 // in zone -> Excel wins if present
  });
  const liveExcel = excelLetters.filter((l) => !adoptedKeys.has(keyOf(l)));
  return kept.concat(liveExcel);
}

// Union any new dept/tag/doctype/location values from Excel letters into the
// filter vocabularies so the dropdowns keep working.
function mergeVocab(base, excelLetters, key, pick) {
  const set = new Set(base || []);
  for (const l of excelLetters) for (const v of pick(l)) if (v && !set.has(v)) set.add(v);
  return [...set];
}

module.exports = { readExcelLive, parseWorkbook, mergeExcelLive, mergeVocab, normalizeCaseAgainst, liveZone };
