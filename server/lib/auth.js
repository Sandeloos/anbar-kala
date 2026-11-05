'use strict';
/**
 * Staff sessions and rate limits.
 * A random token in an httpOnly cookie (SameSite=Strict), 12 hours sliding;
 * only its SHA-256 is stored. Every state-changing API call must also carry the
 * X-Anbar header, which other sites cannot add without a CORS grant (never given).
 */
const { token, sha256, nowIso, HttpError } = require('./util');

const SESSION_HOURS = 12;
const COOKIE = 'anbar_session';

function createLimiter({ factor = 1 } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60000).unref();
  /** Throws 429 after `max` calls per `windowMs` for this key. */
  function limit(key, max, windowMs, message = 'تعداد تلاش‌ها زیاد است؛ چند دقیقه بعد دوباره امتحان کنید.') {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    if (h.n > max * factor) throw new HttpError(429, message, { retryAfter: Math.ceil((h.reset - now) / 1000) });
  }
  limit.reset = (key) => hits.delete(key);
  return limit;
}

function createAuth({ db, config }) {
  const cookieOptions = () => ({ path: '/', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: SESSION_HOURS * 3600 });

  function start(reply, req, userId) {
    const t = token();
    const now = new Date();
    db.run(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
    sha256(t), userId, now.toISOString(), new Date(now.getTime() + SESSION_HOURS * 3600e3).toISOString(), now.toISOString(),
    req.ip || '', String(req.headers['user-agent'] || '').slice(0, 300));
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now.toISOString(), userId);
    reply.setCookie(COOKIE, t, cookieOptions());
    return sha256(t);
  }

  /** The signed-in user for this request, or null. */
  function userFrom(req) {
    const t = req.cookies && req.cookies[COOKIE];
    if (!t) return null;
    const hash = sha256(t);
    const row = db.get(`SELECT u.id, u.username, u.name, u.role, u.phone, u.email, u.active, u.must_change_password,
                               s.expires_at, s.last_seen_at
                        FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.token_hash = ? AND s.expires_at > ?`, hash, nowIso());
    if (!row || !row.active) return null;
    const now = Date.now();
    // Sliding expiry, written at most once a minute
    if (now - new Date(row.last_seen_at).getTime() > 60000) {
      db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?',
        new Date(now).toISOString(), new Date(now + SESSION_HOURS * 3600e3).toISOString(), hash);
    }
    return {
      id: row.id, username: row.username, name: row.name, role: row.role, phone: row.phone, email: row.email,
      mustChangePassword: !!row.must_change_password, session: hash
    };
  }

  function end(req, reply) {
    const t = req.cookies && req.cookies[COOKIE];
    if (t) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(t));
    reply.clearCookie(COOKIE, { path: '/' });
  }

  /** Signs the user out everywhere except (optionally) the given session. */
  function endOthers(userId, keepHash) {
    return db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, keepHash || '').changes;
  }

  setInterval(() => { try { db.run('DELETE FROM sessions WHERE expires_at < ?', nowIso()); } catch { /* closed */ } }, 3600e3).unref();

  return { start, userFrom, end, endOthers, COOKIE };
}

module.exports = { createAuth, createLimiter, COOKIE };
