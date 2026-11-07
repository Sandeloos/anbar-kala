'use strict';
/**
 * Idempotent writes. The browser sends `Idempotency-Key: <uuid>` with every POST/PUT/DELETE and
 * re-sends the same key when it retries after a dropped connection. The first request runs; a
 * repeat gets the stored answer back (header `Idempotent-Replayed: true`) instead of creating a
 * second order or receiving a line twice. Keys are per user and kept for 24 hours.
 */
const crypto = require('crypto');
const { HttpError } = require('./util');

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const ABANDONED_MS = 120e3;

function createIdempotency({ db }) {
  const hash = (req) => crypto.createHash('sha256')
    .update(`${req.method} ${req.url}\n${req.body === undefined ? '' : JSON.stringify(req.body)}`).digest('hex');

  /** preHandler: replays a finished request or claims the key for this one. */
  async function before(req, reply) {
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) || !req.user) return;
    const key = req.headers['idempotency-key'];
    if (key === undefined) return;
    if (!KEY.test(key)) throw new HttpError(400, 'کلید تکرار درخواست معتبر نیست.');
    const h = hash(req);
    const row = db.get('SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?', req.user.id, key);
    // A request that never finished (the process stopped mid-way; nothing was committed) may run again
    if (row && row.status === null && Date.now() - new Date(row.created_at).getTime() > ABANDONED_MS) {
      db.run('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ?', req.user.id, key);
      return before(req, reply);
    }
    if (row) {
      if (row.request_hash !== h || row.method !== req.method || row.path !== req.url) {
        throw new HttpError(422, 'این کلید قبلاً برای درخواست دیگری به کار رفته است.');
      }
      if (row.status === null) throw new HttpError(409, 'همین درخواست هنوز در حال انجام است؛ چند لحظه صبر کنید.', { code: 'in_progress' });
      reply.header('Idempotent-Replayed', 'true');
      return reply.code(row.status).type('application/json; charset=utf-8').send(row.response);
    }
    db.run(`INSERT INTO idempotency_keys (key, user_id, method, path, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      key, req.user.id, req.method, req.url, h, new Date().toISOString());
    req.idempotency = { key, userId: req.user.id };
  }

  /** onSend: remember the answer (server errors are forgotten so a retry can run again). */
  async function after(req, reply, payload) {
    const idem = req.idempotency;
    if (!idem || idem.done) return payload;
    idem.done = true;
    if (reply.statusCode >= 500 || typeof payload !== 'string') {
      db.run('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ?', idem.userId, idem.key);
    } else {
      db.run('UPDATE idempotency_keys SET status = ?, response = ? WHERE user_id = ? AND key = ?', reply.statusCode, payload, idem.userId, idem.key);
    }
    return payload;
  }

  const prune = () => db.run('DELETE FROM idempotency_keys WHERE created_at < ?', new Date(Date.now() - 24 * 3600e3).toISOString()).changes;

  return { before, after, prune };
}

module.exports = { createIdempotency };
