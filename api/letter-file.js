// GET /api/letter-file?cat=outgoing&n=986&i=0 — streams the i-th attachment of a
// letter, resolved from the phonebook (the client never supplies a file path).
// Auth-gated. Viewable types open inline; others download.
const { currentUser } = require('../lib/auth');
const { streamAttachment } = require('../lib/pdfs');

module.exports = async (req, res) => {
  try {
    const me = await currentUser(req);
    if (!me) return res.status(401).end('Not authenticated');
    const cat = String((req.query && req.query.cat) || '');
    const num = String((req.query && req.query.n) || '').replace(/\D/g, '');
    const i = parseInt((req.query && req.query.i), 10);
    if (!cat || !num || isNaN(i) || i < 0) return res.status(400).end('cat, n and i are required');
    await streamAttachment(cat, num, i, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).end('Error: ' + (e.message || e));
  }
};
