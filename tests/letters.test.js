const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('deptsOf splits multi-department letters on "/"', () => {
  const { deptsOf } = require('../lib/letters');
  assert.deepEqual(deptsOf({ department: 'QA/Design' }), ['QA', 'Design']);
  assert.deepEqual(deptsOf({ department: 'Contract' }), ['Contract']);
  assert.deepEqual(deptsOf({}), []);
});

test('filterLettersForUser: admin sees everything', () => {
  const { filterLettersForUser } = require('../lib/letters');
  const letters = [{ id: 1, department: 'Contract' }, { id: 2, department: 'QA/Design' }];
  assert.equal(filterLettersForUser(letters, { isAdmin: true, departments: [] }).length, 2);
});

test('filterLettersForUser: department-scoped user sees matching single- and multi-department letters', () => {
  const { filterLettersForUser } = require('../lib/letters');
  const letters = [
    { id: 1, department: 'Contract' },
    { id: 2, department: 'QA/Design' },
    { id: 3, department: 'EHS' },
  ];
  const result = filterLettersForUser(letters, { isAdmin: false, departments: ['QA'] });
  assert.deepEqual(result.map((l) => l.id), [2]);
});

test('filterLettersForUser: unrestricted non-admin (no departments assigned) sees everything', () => {
  const { filterLettersForUser } = require('../lib/letters');
  const letters = [{ id: 1, department: 'Contract' }, { id: 2, department: 'EHS' }];
  assert.equal(filterLettersForUser(letters, { isAdmin: false, departments: [] }).length, 2);
});

test('readLettersRaw falls back to the tracked sample fixture when Nutstore is not configured', async () => {
  delete process.env.NUTSTORE_USER;
  delete process.env.NUTSTORE_PASSWORD;
  const localOverride = path.join(__dirname, '..', 'data', '.letters_local.json');
  try { fs.unlinkSync(localOverride); } catch { /* already absent */ }
  const { readLettersRaw } = require('../lib/letters');
  const raw = await readLettersRaw();
  const data = JSON.parse(raw);
  assert.equal(Array.isArray(data.letters), true);
  assert.equal(data.letters.length > 0, true);
});
