'use strict';
/**
 * POST /hooks/woo/:company — called by the "Anbar connector" WordPress plugin
 * the moment a product's price, stock, name or status changes on the site.
 *
 * Headers: X-Anbar-Timestamp (unix seconds) and
 *          X-Anbar-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the company's webhook secret>
 * Body:    { "items": [ WooCommerce-REST-shaped products/variations (variations carry "parent") ],
 *            "deleted": [ ids ], "ping": true? }
 *
 * A signed request is accepted once: the timestamp must be within 5 minutes and the same
 * signature is refused for 10 minutes after its first use, so a captured request cannot be
 * replayed to put an old price back.
 */
const crypto = require('crypto');
const { safeEqual, HttpError } = require('../lib/util');

module.exports = async function hooks(app) {
  const { db, sync, limit, events, metrics } = app.ctx;
  const seen = new Map(); // signature → expiry (ms)
  const WINDOW_S = 300;
  function firstUse(sig) {
    const now = Date.now();
    if (seen.size > 5000) for (const [k, t] of seen) if (t < now) seen.delete(k);
    if ((seen.get(sig) || 0) > now) return false;
    seen.set(sig, now + 2 * WINDOW_S * 1000);
    return true;
  }
  const count = (result) => metrics && metrics.inc('anbar_webhooks_total', { result });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body;
    try { done(null, body ? JSON.parse(body) : {}); } catch { done(new HttpError(400, 'invalid JSON')); }
  });

  app.post('/hooks/woo/:company', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const id = Number(req.params.company);
    limit(`hook:${id}:${req.ip}`, 600, 60e3);
    const comp = Number.isInteger(id) ? db.get('SELECT * FROM companies WHERE id = ?', id) : null;
    const ts = Number(req.headers['x-anbar-timestamp']);
    const sig = String(req.headers['x-anbar-signature'] || '').replace(/^sha256=/, '');
    // Same answer for "no such company" and "bad signature", so the endpoint reveals nothing
    const deny = () => { count('denied'); return reply.code(401).send({ error: 'invalid signature' }); };
    if (!comp || !comp.active || !ts || !sig) return deny();
    if (Math.abs(Date.now() / 1000 - ts) > WINDOW_S) { count('stale'); return reply.code(401).send({ error: 'stale timestamp' }); }
    const expected = crypto.createHmac('sha256', comp.webhook_secret).update(`${ts}.${req.rawBody || ''}`).digest('hex');
    if (!safeEqual(expected, sig)) return deny();
    if (!firstUse(`${comp.id}:${sig}`)) { count('replayed'); return reply.code(409).send({ error: 'replayed request' }); }

    const body = req.body || {};
    if (body.ping) {
      db.run('UPDATE companies SET last_webhook_at = ? WHERE id = ?', new Date().toISOString(), comp.id);
      events.emit('company', { id: comp.id });
      count('ping');
      return { ok: true, company: comp.name };
    }
    const stats = sync.applyPush(comp, body);
    count('applied');
    return { ok: true, seen: stats.seen, created: stats.created, priceChanges: stats.priceChanges, stockChanges: stats.stockChanges, removed: stats.removed };
  });
};
