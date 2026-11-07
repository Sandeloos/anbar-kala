'use strict';
/**
 * The WordPress plugin and the server must agree on the payload and the
 * signature: run the plugin under PHP with WordPress stand-ins and deliver
 * exactly what it would send. Also checks the zip download.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');

const hasPhp = spawnSync('php', ['-v']).status === 0;

test('plugin push (PHP) is accepted by the server and updates products', { skip: !hasPhp && 'php is not installed' }, async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 2, seed: 1, variableRatio: 0 });
  const company = await addCompany(ctx, api, s);
  const secret = ctx.db.get('SELECT webhook_secret FROM companies WHERE id = ?', company.id).webhook_secret;
  const url = `http://anbar.test/hooks/woo/${company.id}`;

  const out = execFileSync('php', [path.join(__dirname, '..', 'php', 'plugin-harness.php'), url, secret, s.url], { encoding: 'utf8' });
  const sent = JSON.parse(out);
  assert.equal(sent.length, 1, 'one request per page load');
  const req = sent[0];
  assert.equal(req.url, url);
  const body = JSON.parse(req.body);
  assert.deepEqual(body.items.map((i) => i.id).sort(), [11, 12, 20], 'the variable parent is replaced by its variations');
  assert.deepEqual(body.deleted, [30]);

  const res = await ctx.app.inject({
    method: 'POST', url: `/hooks/woo/${company.id}`, payload: req.body,
    headers: { 'content-type': req.headers['Content-Type'], 'x-anbar-timestamp': req.headers['X-Anbar-Timestamp'], 'x-anbar-signature': req.headers['X-Anbar-Signature'] }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().created, 3);
  const v = ctx.db.get('SELECT * FROM products WHERE company_id = ? AND woo_id = 12', company.id);
  assert.equal(v.name, 'لیوان کاغذی & درب - 100 عددی');
  assert.equal(v.regular_price, 4600000);
  assert.equal(v.stock_quantity, 70, 'stock managed by the parent');
  assert.equal(v.attributes, 'تعداد در بسته: 100 عددی');

  // A tampered body fails the signature check
  const bad = await ctx.app.inject({
    method: 'POST', url: `/hooks/woo/${company.id}`, payload: req.body.replace('460000', '1'),
    headers: { 'content-type': 'application/json', 'x-anbar-timestamp': req.headers['X-Anbar-Timestamp'], 'x-anbar-signature': req.headers['X-Anbar-Signature'] }
  });
  assert.equal(bad.statusCode, 401);
});

test('the plugin downloads as a valid zip', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const res = await ctx.app.inject({ method: 'GET', url: '/api/plugin/anbar-connector.zip', headers: { cookie: api.cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  const buf = res.rawPayload;
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes(Buffer.from('anbar-connector/anbar-connector.php')));
  const unzip = spawnSync('python3', ['-c', 'import sys,zipfile,io; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(z.testzip() or "ok"); print(",".join(sorted(z.namelist())))'], { input: buf });
  if (unzip.status === 0) {
    const [check, names] = unzip.stdout.toString().trim().split('\n');
    assert.equal(check, 'ok');
    assert.equal(names, 'anbar-connector/anbar-connector.php,anbar-connector/readme.txt');
  }
});
