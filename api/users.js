// Admin-only user management. GET list · POST create/update · DELETE remove.
// Password hashes are never returned to the client. A user is either an admin
// (full access) or a department-scoped viewer (read-only, sees only letters
// matching their departments; empty departments = sees every letter).
const { getUsers, saveUsers } = require('../lib/store');
const { currentUser, hashPassword } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const me = await currentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    if (!me.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const users = await getUsers();

    if (req.method === 'GET') {
      const list = Object.entries(users).map(([username, r]) => ({
        username, departments: r.departments || [], isAdmin: !!r.isAdmin,
      })).sort((a, b) => a.username.localeCompare(b.username));
      return res.status(200).json({ users: list });
    }

    if (req.method === 'POST') {
      const { username, password, departments, isAdmin } = req.body || {};
      const name = typeof username === 'string' ? username.trim() : '';
      if (!name) return res.status(400).json({ error: 'Username is required.' });
      // Usernames are case-insensitive: editing an account by a different casing
      // updates that same record instead of creating a near-duplicate that would
      // make login ambiguous.
      const existingKey = Object.keys(users).find((k) => k.toLowerCase() === name.toLowerCase());
      const existing = existingKey ? users[existingKey] : null;
      if (!existing && !password) return res.status(400).json({ error: 'A password is required for a new user.' });
      const rec = existing || {};
      if (password) rec.pass = hashPassword(password);
      if (Array.isArray(departments)) rec.departments = [...new Set(departments.map((d) => String(d).trim()).filter(Boolean))];
      else if (!rec.departments) rec.departments = [];
      rec.isAdmin = !!isAdmin;
      users[existingKey || name] = rec;
      await saveUsers(users);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const u = (req.query && req.query.u) || (req.body && req.body.username);
      if (!u) return res.status(400).json({ error: 'username required' });
      const key = Object.keys(users).find((k) => k.toLowerCase() === String(u).toLowerCase()) || u;
      if (key.toLowerCase() === String(me.username).toLowerCase()) return res.status(400).json({ error: "You can't delete your own account." });
      delete users[key];
      await saveUsers(users);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const msg = String(e.message || e);
    if (/EROFS|read-only|KV (get|set) failed|ENOENT/i.test(msg)) {
      return res.status(503).json({ error: 'User database not connected yet. In Vercel, add a KV / Upstash Redis store (Storage → Create → Upstash for Redis → Connect to project), then redeploy.' });
    }
    return res.status(500).json({ error: msg });
  }
};
