const { test } = require('node:test');
const assert = require('node:assert/strict');
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
const { saveUsers } = require('../lib/store');
const { signToken, currentUser, hashPassword, verifyPassword } = require('../lib/auth');

test('hashPassword / verifyPassword round-trip', () => {
  const stored = hashPassword('s3cret');
  assert.equal(verifyPassword('s3cret', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
});

test('currentUser resolves a department-scoped viewer with departments[]', async () => {
  await saveUsers({ 'qa.tester': { pass: hashPassword('x'), departments: ['QA', 'Design'], isAdmin: false } });
  const token = signToken('qa.tester');
  const me = await currentUser({ headers: { authorization: 'Bearer ' + token } });
  assert.equal(me.username, 'qa.tester');
  assert.equal(me.isAdmin, false);
  assert.deepEqual(me.departments, ['QA', 'Design']);
});

test('currentUser gives admins an unrestricted (empty) departments list', async () => {
  await saveUsers({ boss: { pass: hashPassword('x'), departments: ['QA'], isAdmin: true } });
  const token = signToken('boss');
  const me = await currentUser({ headers: { authorization: 'Bearer ' + token } });
  assert.equal(me.isAdmin, true);
  assert.deepEqual(me.departments, []);
});

test('currentUser rejects a tampered or missing token', async () => {
  assert.equal(await currentUser({ headers: {} }), null);
  assert.equal(await currentUser({ headers: { authorization: 'Bearer not.a.token' } }), null);
});

test('bootstrap admin (ADMIN_USER) resolves even with an empty store', async () => {
  await saveUsers({});
  process.env.ADMIN_USER = 'root';
  const token = signToken('root');
  const me = await currentUser({ headers: { authorization: 'Bearer ' + token } });
  assert.equal(me.isAdmin, true);
  assert.deepEqual(me.departments, []);
  delete process.env.ADMIN_USER;
});
