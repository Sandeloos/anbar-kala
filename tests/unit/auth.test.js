'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, addUser, client } = require('./helpers');

test('sign in, session cookie, CSRF header, sign out', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);

  assert.equal((await api.get('/api/dashboard')).status, 401);
  const wrong = await api.login('boss', 'nope-nope');
  assert.equal(wrong.status, 401);
  assert.ok(wrong.body.fields.password);
  const unknown = await api.login('ghost', 'whatever-1');
  assert.equal(unknown.status, 401, 'unknown users get the same answer');

  const ok = await api.login('BOSS', 'secret-pass-1');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'manager');
  assert.match(ok.headers['set-cookie'], /HttpOnly/i);
  assert.match(ok.headers['set-cookie'], /SameSite=Strict/i);
  assert.equal((await api.get('/api/dashboard')).status, 200);

  // A state-changing request without the X-Anbar header is refused
  const res = await ctx.app.inject({ method: 'PUT', url: '/api/me', headers: { cookie: api.cookie, 'content-type': 'application/json' }, payload: '{"name":"x"}' });
  assert.equal(res.statusCode, 403);

  const log = ctx.db.get("SELECT * FROM audit_log WHERE action = 'login'");
  assert.ok(log, 'sign-ins are logged');

  await api.post('/api/auth/logout');
  assert.equal((await api.get('/api/dashboard')).status, 401);
});

test('too many wrong passwords lock that username for a while', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  for (let i = 0; i < 8; i++) assert.equal((await api.login('boss', 'wrong-' + i)).status, 401);
  const locked = await api.login('boss', 'secret-pass-1');
  assert.equal(locked.status, 429);
});

test('manager creates an admin with a one-time password that must be changed', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const boss = client(ctx.app);
  await boss.login();

  const bad = await boss.post('/api/users', { name: 'علی', username: 'علی', role: 'admin' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.username);

  const made = await boss.post('/api/users', { name: 'علی رضایی', username: 'ali', role: 'admin', phone: '۰۹۱۲۱۲۳۴۵۶۷' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.user.phone, '09121234567');
  const temp = made.body.temp_password;
  assert.equal(temp.length, 10);
  assert.equal((await boss.post('/api/users', { name: 'x', username: 'ali', role: 'admin' })).status, 409);

  const ali = client(ctx.app);
  const login = await ali.login('ali', temp);
  assert.equal(login.body.user.must_change_password, true);
  assert.equal((await ali.get('/api/dashboard')).status, 403, 'nothing works until the password is changed');
  const weak = await ali.post('/api/me/password', { current: temp, next: 'short' });
  assert.equal(weak.status, 400);
  const changed = await ali.post('/api/me/password', { current: temp, next: 'a-better-password' });
  assert.equal(changed.status, 200);
  assert.equal((await ali.get('/api/dashboard')).status, 200);

  // Admins cannot manage users or settings
  assert.equal((await ali.post('/api/users', { name: 'y', username: 'yy1', role: 'admin' })).status, 403);
  assert.equal((await ali.put('/api/settings', { full_sync_minutes: 30, incremental_sync_minutes: 5 })).status, 403);
  const names = await ali.get('/api/users');
  assert.equal(names.body.items[0].username, undefined, 'admins only see names');

  // Deactivating signs the user out
  const id = made.body.user.id;
  const off = await boss.put(`/api/users/${id}`, { name: 'علی رضایی', username: 'ali', role: 'admin', active: false });
  assert.equal(off.status, 200);
  assert.equal((await ali.get('/api/dashboard')).status, 401);
  const entry = ctx.db.get("SELECT * FROM audit_log WHERE entity = 'user' AND action = 'update' ORDER BY id DESC");
  const changes = JSON.parse(entry.changes);
  assert.deepEqual(changes.map((c) => c.label), ['فعال']);
  assert.equal(changes[0].from, 'بله');
  assert.equal(changes[0].to, 'خیر');
});

test('the last manager cannot be demoted or deactivated; managers cannot lock themselves out', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  const id = await addUser(ctx.db);
  const boss = client(ctx.app);
  await boss.login();
  const r = await boss.put(`/api/users/${id}`, { name: 'مدیر', username: 'boss', role: 'admin', active: true });
  assert.equal(r.status, 400);
});

test('profile edits are logged field by field; password change signs out other devices', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const a = client(ctx.app);
  const b = client(ctx.app);
  await a.login();
  await b.login();
  const sessions = await a.get('/api/me/sessions');
  assert.equal(sessions.body.items.length, 2);
  assert.equal(sessions.body.items.filter((s) => s.current).length, 1);

  const p = await a.put('/api/me', { name: 'مدیر کل', phone: '09120000000', email: 'boss@example.com' });
  assert.equal(p.status, 200);
  const mine = await a.get('/api/me/activity');
  const upd = mine.body.items.find((i) => i.action === 'update');
  assert.deepEqual(upd.changes.map((c) => c.field).sort(), ['email', 'name', 'phone']);

  const wrong = await a.post('/api/me/password', { current: 'nope', next: 'new-password-1' });
  assert.equal(wrong.status, 400);
  const ok = await a.post('/api/me/password', { current: 'secret-pass-1', next: 'new-password-1' });
  assert.equal(ok.body.signed_out_others, 1);
  assert.equal((await b.get('/api/dashboard')).status, 401);
  assert.equal((await a.get('/api/dashboard')).status, 200);
});

test('warehouses: Sandeloos and Radloos exist; add, rename, keep one active; activity log filters', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const list = await api.get('/api/warehouses');
  assert.deepEqual(list.body.items.map((w) => w.name), ['سندلوس', 'رادلوس']);
  const add = await api.post('/api/warehouses', { name: 'انبار شمال' });
  assert.equal(add.body.items.length, 3);
  assert.equal((await api.post('/api/warehouses', { name: 'سندلوس' })).status, 409);
  const id = add.body.items.find((w) => w.name === 'انبار شمال').id;
  await api.put(`/api/warehouses/${id}`, { name: 'انبار شمال', active: false });
  await api.put('/api/warehouses/2', { name: 'رادلوس', active: false });
  const last = await api.put('/api/warehouses/1', { name: 'سندلوس', active: false });
  assert.equal(last.status, 400, 'one warehouse must stay active');

  const acts = await api.get('/api/activity?entity=warehouse');
  assert.equal(acts.body.total, 3);
  const search = await api.get('/api/activity?q=' + encodeURIComponent('شمال'));
  assert.ok(search.body.total >= 2);
});
