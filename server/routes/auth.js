'use strict';
const { z } = require('./validate');
const { verifyPassword, HttpError } = require('../lib/util');

// Compared against when the username does not exist, so timing does not reveal valid usernames
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, phone: u.phone || null, email: u.email || null,
    must_change_password: !!(u.mustChangePassword ?? u.must_change_password)
  };
}

module.exports = async function authRoutes(app) {
  const { db, auth, audit, limit } = app.ctx;

  app.post('/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = z.object({
      username: z.string({ error: 'نام کاربری را وارد کنید.' }).trim().min(1, 'نام کاربری را وارد کنید.').max(64),
      password: z.string({ error: 'رمز عبور را وارد کنید.' }).min(1, 'رمز عبور را وارد کنید.').max(200)
    }).parse(req.body || {});
    const name = body.username.toLowerCase();
    limit(`login-ip:${req.ip}`, 30, 15 * 60e3);
    limit(`login-user:${name}`, 8, 15 * 60e3, 'برای این نام کاربری تلاش ناموفق زیاد بوده؛ ۱۵ دقیقه بعد دوباره امتحان کنید.');
    const user = db.get('SELECT * FROM users WHERE username = ?', name);
    const ok = await verifyPassword(body.password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'نام کاربری یا رمز عبور درست نیست.', { fields: { password: 'نام کاربری یا رمز عبور درست نیست.' } });
    if (!user.active) throw new HttpError(403, 'حساب شما غیرفعال شده است؛ با مدیر تماس بگیرید.');
    limit.reset(`login-user:${name}`);
    db.tx(() => {
      auth.start(reply, req, user.id);
      audit({ user, ip: req.ip }, { action: 'login', entity: 'user', id: user.id, summary: 'ورود به نرم‌افزار' });
    });
    return { user: publicUser(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    auth.end(req, reply);
    return { ok: true };
  });

  app.get('/auth/me', { config: { public: true } }, async (req) => {
    const user = auth.userFrom(req);
    return { user: user ? publicUser(user) : null };
  });
};

module.exports.publicUser = publicUser;
