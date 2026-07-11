// GET: load Correspondence Tracker data, filtered server-side to the caller's
// department roles. POST (admin only): overwrite the tracker data.
const { currentUser } = require('../lib/auth');
const { readLettersRaw, writeLettersRaw, filterLettersForUser } = require('../lib/letters');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const me = await currentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });

    if (req.method === 'GET') {
      const raw = await readLettersRaw();
      const data = raw.trim() ? JSON.parse(raw) : { letters: [], allTags: [], allDocTypes: [], allLocations: [], allDepts: [] };
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        letters: filterLettersForUser(data.letters || [], me),
        allTags: data.allTags || [],
        allDocTypes: data.allDocTypes || [],
        allLocations: data.allLocations || [],
        allDepts: data.allDepts || [],
        savedAt: data.savedAt || null,
        version: data.version || '2.1',
        canEdit: !!me.isAdmin,
        viewerDepartments: me.isAdmin ? [] : (me.departments || []),
      });
    }

    if (req.method === 'POST') {
      if (!me.isAdmin) return res.status(403).json({ error: 'Admin only' });
      const body = req.body || {};
      if (!Array.isArray(body.letters)) return res.status(400).json({ error: 'letters[] is required' });
      const payload = {
        letters: body.letters,
        allTags: Array.isArray(body.allTags) ? body.allTags : [],
        allDocTypes: Array.isArray(body.allDocTypes) ? body.allDocTypes : [],
        allLocations: Array.isArray(body.allLocations) ? body.allLocations : [],
        allDepts: Array.isArray(body.allDepts) ? body.allDepts : [],
        savedAt: new Date().toISOString(),
        version: '2.1',
      };
      await writeLettersRaw(JSON.stringify(payload, null, 2));
      return res.status(200).json({ ok: true, count: payload.letters.length, savedAt: payload.savedAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
};
