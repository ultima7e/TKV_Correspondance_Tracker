// POST /api/login {username, password} -> verify (store account or bootstrap
// admin) -> set the session cookie.
const { getUsers } = require('../lib/store');
const { verifyPassword, signToken, sessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Enter a username and password.' });
    const entered = String(username).trim();
    const users = await getUsers();
    // Usernames are case-insensitive: "Sagar", "SaGar" and "sagar" are the same
    // account. Resolve to the stored casing and sign the token with it.
    const storedKey = Object.keys(users).find((k) => k.toLowerCase() === entered.toLowerCase());
    const rec = storedKey ? users[storedKey] : null;
    let ok = false, isAdmin = false, canonical = entered;
    if (rec) {
      ok = verifyPassword(password, rec.pass);
      isAdmin = !!rec.isAdmin;
      if (ok) canonical = storedKey;
    } else if (process.env.ADMIN_USER && entered.toLowerCase() === process.env.ADMIN_USER.toLowerCase()
      && process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) {
      ok = true; isAdmin = true; canonical = process.env.ADMIN_USER;
    }
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    const token = signToken(canonical);
    res.setHeader('Set-Cookie', sessionCookie(token));
    return res.status(200).json({ ok: true, username: canonical, isAdmin });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
