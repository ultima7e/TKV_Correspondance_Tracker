const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseWorkbook } = require('../lib/excel');
const { matchMisc } = require('../lib/pdfs');

function wbBuffer(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('parseWorkbook parses the Miscellaneous Letters sheet (headers on row 0, subject-keyed)', () => {
  const buf = wbBuffer([
    ['Miscellaneous Letters', [
      ['Date', 'From', 'Subject', 'Attachment', 'Doc Type', 'Tags'],
      [new Date(2026, 8, 8), 'Kailash Helicopter and Services Ltd.', 'Rescue and Evacuation Report', 'yes', 'Progress Report', 'Safety'],
      [null, null, null, null, null, null],   // blank row — no subject, skipped
    ]],
  ]);
  const letters = parseWorkbook(buf);
  assert.equal(letters.length, 1);
  const L = letters[0];
  assert.equal(L.category, 'miscellaneous');
  assert.equal(L.subject, 'Rescue and Evacuation Report');
  assert.equal(L.from, 'Kailash Helicopter and Services Ltd.');
  assert.equal(L.sendDate, '2026-09-08');
  assert.deepEqual(L.docTypes, ['Progress Report']);
  assert.deepEqual(L.tags, ['Safety']);
  assert.equal(L.letterNumber, '');
  assert.equal(L._src, 'xlsx');
  assert.ok(L.id.startsWith('xlsx:miscellaneous:'));
});

test('parseWorkbook resolves the misc tab fuzzily (singular "Letter")', () => {
  const buf = wbBuffer([
    ['Miscellaneous Letter', [   // note: singular
      ['Date', 'From', 'Subject', 'Attachment', 'Doc Type', 'Tags'],
      [new Date(2026, 0, 3), 'X Co.', 'Site Handover Note', '', '', ''],
    ]],
  ]);
  const letters = parseWorkbook(buf);
  assert.equal(letters.length, 1);
  assert.equal(letters[0].subject, 'Site Handover Note');
});

test('parseWorkbook still parses a numbered sheet (regression) alongside misc', () => {
  const buf = wbBuffer([
    ['1. Incoming Letters', [
      ['INCOMING LETTERS', null, null],                 // row 0: title band
      ['Letter No.', 'Send Date', 'Subject'],           // row 1: header
      ['LOT-01/SINOHYDRO-KSNS-JV/960', new Date(2026, 5, 1), 'Some incoming subject'],  // 960 >= 954 -> live
      ['LOT-01/SINOHYDRO-KSNS-JV/100', new Date(2020, 0, 1), 'Old, below boundary'],    // 100 -> frozen, skipped
    ]],
    ['Miscellaneous Letters', [
      ['Date', 'From', 'Subject'],
      [new Date(2026, 8, 8), 'Y Co.', 'A misc letter'],
    ]],
  ]);
  const letters = parseWorkbook(buf);
  const cats = letters.map((l) => l.category).sort();
  assert.deepEqual(cats, ['incoming', 'miscellaneous']);
  assert.equal(letters.find((l) => l.category === 'incoming').letterNumber, 'LOT-01/SINOHYDRO-KSNS-JV/960');
});

test('matchMisc: exact, normalized and fuzzy matches; rejects unrelated', () => {
  const names = ['Rescue and Evacuation Report.pdf', 'Monthly Progress Summary.pdf', 'scan-attachment.pdf', 'notes.txt'];
  assert.equal(matchMisc(names, 'Rescue and Evacuation Report'), 'Rescue and Evacuation Report.pdf');
  assert.equal(matchMisc(names, 'rescue & evacuation report!'), 'Rescue and Evacuation Report.pdf');   // punctuation/case
  assert.equal(matchMisc(names, 'Rescue and Evacuation Report (Final)'), 'Rescue and Evacuation Report.pdf'); // fuzzy
  assert.equal(matchMisc(names, 'Totally Unrelated Xyz Subject'), null);
  assert.equal(matchMisc(names, ''), null);
  assert.equal(matchMisc([], 'anything'), null);
});
