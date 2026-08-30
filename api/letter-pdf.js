// GET /api/letter-pdf?cat=outgoing&n=985 — streams the letter's PDF from Nutstore,
// found by matching the number to the filename. Auth-gated (logged-in users only).
const { currentUser } = require('../lib/auth');
const { streamPdf, debugCategory, debugPath, FOLDERS } = require('../lib/pdfs');

module.exports = async (req, res) => {
  try {
    const me = await currentUser(req);
    if (!me) return res.status(401).end('Not authenticated');
    const cat = String((req.query && req.query.cat) || '');
    const num = String((req.query && req.query.n) || '').replace(/\D/g, '');
    if (!FOLDERS[cat] || !num) return res.status(400).end('cat and n are required');
    if (req.query && req.query.debug) {
      if (!me.isAdmin) return res.status(403).json({ error: 'admin only' });
      if (req.query.path !== undefined) return res.status(200).json(await debugPath(String(req.query.path)));
      return res.status(200).json(await debugCategory(cat, num));
    }
    await streamPdf(cat, num, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).end('Error: ' + (e.message || e));
  }
};
