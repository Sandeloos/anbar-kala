'use strict';
/**
 * People who use the software (manager only). Users are never deleted, only
 * deactivated, so the activity log always knows who did what. New users and
 * password resets get a one-time password that must be changed at first sign-in.
 */
const { z, text, phone, email, username, bool } = require('./validate');
const { hashPassword, tempPassword, nowIso, notFound, badRequest, conflict } = require('../lib/util');

const ROLE = z.enum(['manager', 'admin'], { error: 'نقش معتبر نیست.' });
const FIELDS = { name: 'نام', username: 'نام کاربری', role: 'نقش', phone: 'تلفن', email: 'ایمیل', active: 'فعال' };
const ROLE_LABEL = { manager: 'مدیر', admin: 'ادمین' };

function row(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, phone: u.phone, email: u.email, active: !!u.active,
    must_change_password: !!u.must_change_password, created_at: u.created_at, last_login_at: u.last_login_at,
    last_seen_at: u.last_seen_at || null, version: u.version
  };
}

module.exports = async function userRoutes(app) {
  const { db, audit, auth, concurrency } = app.ctx;
  const manager = { config: { manager: true } };

  // Everyone may see the list of names (filters in the activity log); details are for the manager
  app.get('/users', async (req) => {
    const rows = db.all(`SELECT u.*, (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
                         FROM users u ORDER BY u.active DESC, u.role = 'manager' DESC, u.name`);
    if (req.user.role !== 'manager') return { items: rows.map((u) => ({ id: u.id, name: u.name, role: u.role, active: !!u.active })) };
    return { items: rows.map(row) };
  });

  app.post('/users', manager, async (req) => {
    const body = z.object({ name: text('نام', 80), username, role: ROLE, phone: phone.optional(), email: email.optional() }).parse(req.body || {});
    if (db.get('SELECT 1 FROM users WHERE username = ?', body.username)) throw conflict('این نام کاربری قبلاً گرفته شده است.', { username: 'تکراری است.' });
    const pw = tempPassword();
    const now = nowIso();
    const info = db.run(`INSERT INTO users (username, name, role, phone, email, password_hash, must_change_password, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    body.username, body.name, body.role, body.phone ?? null, body.email ?? null, await hashPassword(pw), now, now);
    const id = Number(info.lastInsertRowid);
    audit(req, { action: 'create', entity: 'user', id, summary: `افزودن کاربر «${body.name}» (${ROLE_LABEL[body.role]})` });
    return { user: row(db.get('SELECT * FROM users WHERE id = ?', id)), temp_password: pw };
  });

  app.put('/users/:id', manager, async (req) => {
    const before = db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!before) throw notFound('کاربر پیدا نشد.');
    concurrency.check(req, before, { entity: 'user', label: 'این کاربر' });
    const body = z.object({ name: text('نام', 80), username, role: ROLE, phone: phone.optional(), email: email.optional(), active: bool }).parse(req.body || {});
    if (before.id === req.user.id && (!body.active || body.role !== 'manager')) {
      throw badRequest('نمی‌توانید نقش یا وضعیت حساب خودتان را تغییر دهید.');
    }
    if (before.role === 'manager' && (body.role !== 'manager' || !body.active)) {
      const managers = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'manager' AND active = 1").n;
      if (managers <= 1) throw badRequest('دست‌کم یک مدیر فعال باید بماند.');
    }
    const dupe = db.get('SELECT id FROM users WHERE username = ? AND id <> ?', body.username, before.id);
    if (dupe) throw conflict('این نام کاربری قبلاً گرفته شده است.', { username: 'تکراری است.' });
    // Fields left out keep their value; an empty value clears them
    const keep = (k) => (body[k] === undefined ? before[k] : body[k]);
    const after = { ...before, ...body, phone: keep('phone'), email: keep('email'), active: body.active ? 1 : 0 };
    const changes = audit.diff({ ...before, role: ROLE_LABEL[before.role], active: before.active ? 'بله' : 'خیر' },
      { ...after, role: ROLE_LABEL[after.role], active: after.active ? 'بله' : 'خیر' }, FIELDS);
    if (changes.length) {
      db.run('UPDATE users SET name = ?, username = ?, role = ?, phone = ?, email = ?, active = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?',
        after.name, after.username, after.role, after.phone, after.email, after.active, nowIso(), before.id, before.version).changes ||
        concurrency.stale(db.get('SELECT * FROM users WHERE id = ?', before.id), { entity: 'user', label: 'این کاربر' });
      if (!after.active) auth.endOthers(before.id, null);
      audit(req, { action: 'update', entity: 'user', id: before.id, summary: `ویرایش کاربر «${after.name}»`, changes });
    }
    return { user: row(db.get('SELECT * FROM users WHERE id = ?', before.id)) };
  });

  app.post('/users/:id/reset-password', manager, async (req) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!u) throw notFound('کاربر پیدا نشد.');
    if (u.id === req.user.id) throw badRequest('رمز خودتان را از صفحه‌ی پروفایل عوض کنید.');
    const pw = tempPassword();
    db.run('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?', await hashPassword(pw), nowIso(), u.id);
    const ended = auth.endOthers(u.id, null);
    audit(req, { action: 'password', entity: 'user', id: u.id, summary: `رمز موقت جدید برای «${u.name}»` + (ended ? ' و خروج از همه‌ی دستگاه‌ها' : '') });
    return { temp_password: pw };
  });
};
