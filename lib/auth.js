// Auth primitives: password hashing, signed session tokens, and resolving the
// current user from a request. No external deps (Node crypto only). isAdmin and
// departments are looked up fresh from the store on every request, so access
// changes made in the admin panel take effect immediately.
const crypto = require('crypto');
const { getUsers } = require('./store');

const TTL = 12 * 3600; // session lifetime, seconds
const secret = () => process.env.AUTH_SECRET || 'dev-insecure-secret-change-me';

const hmac = (data) => crypto.createHmac('sha256', secret()).update(data).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signToken(username) {
  const payload = b64u(JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + TTL }));
  return `${payload}.${b64u(hmac(payload))}`;
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = b64u(hmac(payload));
  const a = Buffer.from(sig || '', 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data; // { u, exp }
}

// Token from an Authorization: Bearer header or the session cookie.
function readToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)cort_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Resolve the authenticated user (fresh from the store) or null.
// { username, isAdmin, departments }. departments is empty for admins and for
// unrestricted viewers (both see every letter). A bootstrap admin (env
// ADMIN_USER) works even with an empty store so the first login can create
// real accounts.
async function currentUser(req) {
  const t = verifyToken(readToken(req));
  if (!t) return null;
  const users = await getUsers();
  // Case-insensitive lookup so a token issued for any casing resolves, and so
  // stored mixed-case usernames keep working with no data migration.
  const key = Object.keys(users).find((k) => k.toLowerCase() === String(t.u).toLowerCase());
  const rec = key ? users[key] : null;
  if (rec) {
    return {
      username: key,
      isAdmin: !!rec.isAdmin,
      departments: rec.isAdmin ? [] : (rec.departments || []),
    };
  }
  if (process.env.ADMIN_USER && String(t.u).toLowerCase() === process.env.ADMIN_USER.toLowerCase()) {
    return { username: process.env.ADMIN_USER, isAdmin: true, departments: [] };
  }
  return null;
}

const sessionCookie = (token) =>
  `cort_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${TTL}; Secure`;
const clearCookie = () => 'cort_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';

module.exports = {
  TTL, hashPassword, verifyPassword, signToken, verifyToken,
  readToken, currentUser, sessionCookie, clearCookie,
};
