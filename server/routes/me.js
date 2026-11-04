'use strict';
/** The signed-in person's own profile, password, sessions and activity. */
const { z, text, phone, email, password } = require('./validate');
const { verifyPassword, hashPassword, nowIso, badRequest, clampInt } = require('../lib/util');
const { publicUser } = require('./auth');

const PROFILE_FIELDS = { name: 'نام', phone: 'تلفن', email: 'ایمیل' };

module.exports = async function meRoutes(app) {
  const { db, auth, audit, limit } = app.ctx;

  app.put('/me', async (req) => {
    const body = z.object({ name: text('نام', 80), phone: phone.optional(), email: email.optional() }).parse(req.body || {});
    const before = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    const keep = (k) => (body[k] === undefined ? before[k] : body[k]);
    const after = { ...before, name: body.name, phone: keep('phone'), email: keep('email') };
    const changes = audit.diff(before, after, PROFILE_FIELDS);
    if (changes.length) {
      db.run('UPDATE users SET name = ?, phone = ?, email = ?, updated_at = ? WHERE id = ?', after.name, after.phone, after.email, nowIso(), req.user.id);
      audit(req, { action: 'update', entity: 'user', id: req.user.id, summary: 'ویرایش پروفایل', changes });
    }
    return { user: publicUser(db.get('SELECT * FROM users WHERE id = ?', req.user.id)) };
  });

  app.post('/me/password', async (req) => {
    const body = z.object({ current: z.string({ error: 'رمز فعلی را وارد کنید.' }).min(1, 'رمز فعلی را وارد کنید.'), next: password }).parse(req.body || {});
    limit(`pw:${req.user.id}`, 10, 15 * 60e3);
    const row = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!(await verifyPassword(body.current, row.password_hash))) throw badRequest('رمز فعلی درست نیست.', { current: 'رمز فعلی درست نیست.' });
    if (body.current === body.next) throw badRequest('رمز جدید باید با رمز فعلی فرق داشته باشد.', { next: 'با رمز فعلی یکی است.' });
    if (body.next.toLowerCase().includes(row.username.toLowerCase())) throw badRequest('رمز نباید شامل نام کاربری باشد.', { next: 'شامل نام کاربری است.' });
    const now = nowIso();
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?',
      await hashPassword(body.next), now, now, req.user.id);
    const others = auth.endOthers(req.user.id, req.user.session);
    audit(req, { action: 'password', entity: 'user', id: req.user.id, summary: 'تغییر رمز عبور' + (others ? ` (خروج از ${others} دستگاه دیگر)` : '') });
    return { ok: true, signed_out_others: others };
  });

  app.get('/me/sessions', async (req) => {
    const rows = db.all(`SELECT token_hash, created_at, last_seen_at, ip, user_agent FROM sessions
                         WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`, req.user.id, nowIso());
    return { items: rows.map((r) => ({ current: r.token_hash === req.user.session, created_at: r.created_at, last_seen_at: r.last_seen_at, ip: r.ip, user_agent: r.user_agent })) };
  });

  app.delete('/me/sessions/others', async (req) => {
    const n = auth.endOthers(req.user.id, req.user.session);
    if (n) audit(req, { action: 'logout', entity: 'user', id: req.user.id, summary: `خروج از ${n} دستگاه دیگر` });
    return { ended: n };
  });

  app.get('/me/activity', async (req) => {
    const limitN = clampInt(req.query.limit, 1, 100, 30);
    const items = db.all(`SELECT id, action, entity, entity_id, summary, changes, ip, created_at FROM audit_log
                          WHERE user_id = ? ORDER BY id DESC LIMIT ?`, req.user.id, limitN);
    return { items: items.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] })) };
  });
};
