'use strict';
/**
 * Digikala automatic pricing against a fake seller API: connecting with the RSA key, the formula
 * per listing, dry run, live price, the 30 % approval limit, a refused price (off, stock 0,
 * reference-price ticket, re-activation), token refresh and rate limits.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');
const { createMockDigikala } = require('../../tools/mock-digikala');
const { priceFor, variantIdOf, createMatcher } = require('../../server/lib/digikala');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

async function setup(t, { band } = {}) {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const dk = await createMockDigikala({ publicKey: keys.publicKey, band }).listen(0);
  t.after(() => dk.close());
  const s = await shop(ctx, { count: 3, seed: 41, variableRatio: 0 });
  const comp = await addCompany(ctx, api, s);
  const p = ctx.db.get("SELECT * FROM products WHERE company_id = ? AND type = 'simple' ORDER BY id LIMIT 1", comp.id);
  ctx.db.run('UPDATE products SET units_per_pack = 4 WHERE id = ?', p.id);
  const product = ctx.db.get('SELECT * FROM products WHERE id = ?', p.id);
  const c = ctx.app.ctx;
  const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', comp.id);
  // A site price change, like the plugin would push it
  const sitePrice = (rials) => c.sync.apply(company, [{ ...ctx.db.get('SELECT * FROM products WHERE id = ?', p.id), regular_price: rials, site_modified_at: new Date().toISOString() }], { source: 'webhook' });
  return { ctx, api, dk, c, product, sitePrice };
}

/** The formula price of the test listing (1 of 4 units, 30 %, rounded to 10 000 rials). */
const formulaPrice = (product, regular = product.regular_price) => priceFor({ units: 1, margin_pct: 30, fixed_add: 0, round_to: 10000 }, { regular_price: regular, units_per_pack: 4 }).price;

async function connectAndList(env, { margin = 30, units = 1, variant } = {}) {
  const { api, dk, product } = env;
  assert.equal((await api.put('/api/digikala/settings', { base_url: dk.url })).status, 200);
  const k = await api.post('/api/digikala/key', { private_key: keys.privateKey });
  assert.equal(k.status, 200, JSON.stringify(k.body));
  const con = await api.post('/api/digikala/connect', { client_code: 'abc', challenge: dk.challenge() });
  assert.equal(con.status, 200, JSON.stringify(con.body));
  assert.equal(con.body.status.connected, true);
  dk.addVariant({ id: 501, price_list: variant.price_list, price_sale: variant.price_sale, credit_increase_percentage: 12, marketplace_seller_stock: 7 });
  const li = await api.post('/api/listings', { platform_id: 1, product_id: product.id, code: '501', units, auto_price: true, margin_pct: margin, fixed_add: '', round_to: '1000' });
  assert.equal(li.status, 200, JSON.stringify(li.body));
  return li.body.listing;
}

test('formula: the site price of one sale, plus the margin and a fixed amount, rounded up', () => {
  // 100-piece pack at 4 000 000 rials, a 25-piece listing, 30 % + 150 000 rials, rounded to 10 000
  const f = priceFor({ units: 25, margin_pct: 30, fixed_add: 150000, round_to: 10000 }, { regular_price: 4000000, units_per_pack: 100 });
  assert.deepEqual(f, { base: 1000000, price: 1450000 });
  assert.equal(priceFor({ units: 1, margin_pct: 10, fixed_add: 0, round_to: 10000 }, { regular_price: 123456, units_per_pack: 1 }).price, 140000, 'rounded up');
  assert.equal(priceFor({ units: 1, margin_pct: null }, { regular_price: 1, units_per_pack: 1 }), null);
  assert.equal(variantIdOf('DKPC-12345'), 12345);
  assert.equal(variantIdOf(' 678 '), 678);
  assert.equal(variantIdOf('abc'), null);
});

test('connect: the code from the self-token page is opened with the private key; secrets are stored encrypted', async (t) => {
  const env = await setup(t);
  const { api, dk, ctx } = env;
  assert.equal((await api.post('/api/digikala/connect', { challenge: dk.challenge() })).status, 400, 'no key yet');
  assert.equal((await api.post('/api/digikala/key', { private_key: 'x'.repeat(200) })).status, 400, 'not a key');
  await api.put('/api/digikala/settings', { base_url: dk.url });
  assert.equal((await api.post('/api/digikala/key', { private_key: keys.privateKey })).status, 200);
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrong = crypto.publicEncrypt({ key: other.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from('x')).toString('base64');
  const bad = await api.post('/api/digikala/connect', { challenge: wrong });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /(?:نپذیرفت.*کد تازه|با این کلید خصوصی باز نشد).*جفتِ همین کلید/s, 'a wrong key shows up as a refused code');
  assert.equal((await api.post('/api/digikala/connect', { client_code: 'abc', challenge: dk.challenge() })).status, 200);
  const row = ctx.db.get('SELECT * FROM dk_connection');
  assert.ok(row.private_key_enc && !row.private_key_enc.includes('PRIVATE KEY'), 'key encrypted');
  assert.ok(row.access_token_enc && row.refresh_token_enc);
  const st = (await api.get('/api/digikala')).body.status;
  assert.equal(st.connected, true);
  assert.ok(st.self_token_days_left >= 179);
  // Live needs a connection; the manager only
  await addUser(ctx.db, { username: 'staff', password: 'staff-pass-12', role: 'admin', name: 'کارمند' });
  const admin = client(ctx.app);
  await admin.login('staff', 'staff-pass-12');
  assert.equal((await admin.put('/api/digikala/settings', { mode: 'live' })).status, 403);
});

test('dry run: what would be sent is recorded, nothing changes on Digikala; the manual inbox stays quiet', async (t) => {
  const env = await setup(t);
  const { api, dk, c, product, sitePrice, ctx } = env;
  const now = formulaPrice(product);
  await connectAndList(env, { variant: { price_list: now, price_sale: now } });
  await api.put('/api/digikala/settings', { mode: 'dry_run' });
  sitePrice(product.regular_price + 40000); // a small rise on the site
  await c.digikala.kick();
  const job = c.digikala.jobs()[0];
  assert.equal(job.status, 'dry_run', JSON.stringify(job));
  assert.equal(job.target_price, formulaPrice(product, product.regular_price + 40000));
  assert.equal(job.result.would_send, job.target_price);
  assert.equal(dk.variants.get(501).price_sale, now, 'not sent');
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'price'").n, 0, 'no manual price task: the robot handles it');
});

test('formulas saved while the robot was off are priced when it is switched on, and again from dry run to live', async (t) => {
  const env = await setup(t);
  const { api, dk, c, product } = env;
  const target = formulaPrice(product);
  // Set up exactly like the owner did: formula first, robot still off, no site price change after
  await connectAndList(env, { variant: { price_list: target, price_sale: target - 10000 } });
  assert.equal(c.digikala.jobs().length, 0, 'off: nothing queued');
  await api.put('/api/digikala/settings', { mode: 'dry_run' });
  await c.digikala.kick();
  assert.equal(c.digikala.jobs()[0].status, 'dry_run', 'checked once when switched on');
  assert.equal(dk.variants.get(501).price_sale, target - 10000);
  await api.put('/api/digikala/settings', { mode: 'live' });
  await c.digikala.kick();
  assert.equal(dk.variants.get(501).price_sale, target, 'sent when switched from dry run to live');
  assert.equal(c.digikala.jobs()[0].status, 'sent');
});

test('live: the price is sent with the panel\'s own credit percentage; a change above 30 % waits for approval', async (t) => {
  const env = await setup(t);
  const { api, dk, c, product, sitePrice, ctx } = env;
  const base = Math.round(product.regular_price / 4);
  const target = Math.ceil(Math.round(base * 1.3) / 10000) * 10000;
  await connectAndList(env, { variant: { price_list: target, price_sale: target - 10000 } });
  await api.put('/api/digikala/settings', { mode: 'live' });
  await api.post(`/api/digikala/listings/${ctx.db.get("SELECT id FROM listings WHERE code = '501'").id}/reprice`);
  await c.digikala.kick();
  assert.equal(dk.variants.get(501).price_sale, target);
  assert.equal(dk.variants.get(501).credit_increase_percentage, 12, 'kept the panel value');
  assert.equal(ctx.db.get("SELECT platform_price FROM listings WHERE code = '501'").platform_price, target);
  assert.ok(ctx.db.get("SELECT 1 FROM audit_log WHERE action = 'digikala' AND summary LIKE '%خودکار عوض شد%'"));

  // A big jump (wrong price on the site?) waits for a person
  sitePrice(product.regular_price * 3);
  await c.digikala.kick();
  let j = c.digikala.jobs()[0];
  assert.equal(j.status, 'needs_approval');
  assert.ok(j.change_pct > 30);
  assert.equal(dk.variants.get(501).price_sale, target, 'not sent yet');
  const st = (await api.get('/api/digikala')).body;
  assert.equal(st.status.needs_approval, 1);
  assert.equal((await api.post(`/api/digikala/jobs/${j.id}/approve`)).status, 200);
  await c.digikala.kick();
  j = c.digikala.jobs().find((x) => x.id === j.id);
  // The fake Digikala allows ±20 % around the reference price, so the tripled price is refused
  assert.equal(j.status, 'rejected');
});

test('refused price: variant off, stock 0, reference-price ticket; nothing more until an admin re-activates', async (t) => {
  const env = await setup(t);
  const { api, dk, c, product, sitePrice, ctx } = env;
  const target = formulaPrice(product);
  // Selling close to our price, but Digikala's reference price is far lower: the price is refused
  await connectAndList(env, { variant: { price_list: Math.round(target / 3), price_sale: target - 10000 } });
  const set = await api.put('/api/digikala/settings', { mode: 'live', ticket_sub_category_id: 77 });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const lid = ctx.db.get("SELECT id FROM listings WHERE code = '501'").id;
  await api.post(`/api/digikala/listings/${lid}/reprice`);
  await c.digikala.kick();
  const j = c.digikala.jobs()[0];
  assert.equal(j.status, 'rejected', JSON.stringify(j));
  const v = dk.variants.get(501);
  assert.equal(v.active, false, 'deactivated');
  assert.equal(v.marketplace_seller_stock, 0, 'stock zero');
  assert.equal(dk.tickets.length, 1);
  assert.equal(dk.tickets[0].sub_category_id, 77);
  assert.equal(dk.tickets[0].form.ticketing_input_1214[0].new_reference_price, j.target_price, 'asks for our price as the new reference');
  const l = ctx.db.get('SELECT * FROM listings WHERE id = ?', lid);
  assert.equal(l.dk_state, 'blocked');
  assert.equal(l.dk_stock_before, 7);
  assert.equal((await api.get('/api/digikala')).body.blocked.length, 1);

  // Further site changes are not sent while it is blocked
  const calls = dk.calls.length;
  sitePrice(product.regular_price + 10000);
  await c.digikala.kick();
  assert.equal(dk.calls.length, calls);

  // Digikala approved the reference price: one click
  v.price_list = j.target_price;
  const re = await api.post(`/api/digikala/listings/${lid}/reactivate`);
  assert.equal(re.status, 200, JSON.stringify(re.body));
  await c.digikala.kick();
  assert.equal(v.active, true);
  assert.equal(v.marketplace_seller_stock, 7, 'stock restored');
  assert.equal(v.price_sale, priceFor(ctx.db.get('SELECT * FROM listings WHERE id = ?', lid), ctx.db.get('SELECT * FROM products WHERE id = ?', product.id)).price, 'priced again');
  assert.equal(ctx.db.get('SELECT dk_state FROM listings WHERE id = ?', lid).dk_state, null);
});

test('tokens are refreshed when they expire; rate limits and server errors are retried', async (t) => {
  const env = await setup(t);
  const { api, dk, c, ctx } = env;
  const target = formulaPrice(env.product);
  await connectAndList(env, { variant: { price_list: target, price_sale: target - 10000 } });
  await api.put('/api/digikala/settings', { mode: 'dry_run' });
  const before = ctx.db.get('SELECT refresh_token_enc FROM dk_connection').refresh_token_enc;
  dk.expireTokens();
  dk.failRequests(429, 503);
  await api.post(`/api/digikala/listings/${ctx.db.get("SELECT id FROM listings WHERE code = '501'").id}/reprice`);
  await c.digikala.kick();
  assert.equal(c.digikala.jobs()[0].status, 'dry_run');
  assert.notEqual(ctx.db.get('SELECT refresh_token_enc FROM dk_connection').refresh_token_enc, before, 'new refresh token kept');
  assert.ok(dk.calls.some((x) => x.path === '/auth/refresh-token'));
});

test('User-Agent: DigikalaTrustedBot/SelfToken/<seller code from the token> on every call; a setting overrides it', async (t) => {
  const env = await setup(t);
  const { api, dk } = env;
  dk.userAgent = 'trusted'; // the real rule since 4 Mehr 1405
  const target = formulaPrice(env.product);
  await connectAndList(env, { variant: { price_list: target, price_sale: target } });
  const st = (await api.get('/api/digikala')).body.status;
  assert.equal(st.seller_code, 4242, 'read from the token');
  assert.equal(st.auto_user_agent, 'DigikalaTrustedBot/SelfToken/4242');
  assert.equal(st.self_token_days_left, 359);
  const ok = await api.post('/api/digikala/import/preview');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(dk.calls.at(-1).userAgent, 'DigikalaTrustedBot/SelfToken/4242');

  // A wrong override is refused by Digikala and reported; clearing it goes back to the automatic one
  assert.equal((await api.put('/api/digikala/settings', { user_agent: 'نامعتبر' })).status, 400, 'ASCII only');
  assert.equal((await api.put('/api/digikala/settings', { user_agent: 'SellerApp/2' })).status, 200);
  const refused = await api.post('/api/digikala/import/preview');
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Invalid User-Agent/);
  assert.equal(dk.calls.at(-1).userAgent, 'SellerApp/2');
  assert.equal((await api.put('/api/digikala/settings', { user_agent: '' })).status, 200);
  assert.equal((await api.post('/api/digikala/import/preview')).status, 200);
});

test('import: every variant is read, matched by supplier code or name, and only confirmed ones become listings', async (t) => {
  const env = await setup(t);
  const { api, dk, ctx, product } = env;
  const others = ctx.db.all('SELECT id FROM products WHERE id <> ? ORDER BY id LIMIT 2', product.id);
  const named = (id, name, sku) => ctx.db.run('UPDATE products SET name = ?, sku = ?, search_text = ? WHERE id = ?', name, sku, name.toLowerCase(), id);
  named(product.id, 'لیوان کاغذی ۲۲۰ سی‌سی بسته ۵۰ عددی', 'CUP-220');
  named(others[0].id, 'دستمال کاغذی جیبی', 'TIS-1');
  named(others[1].id, 'بشقاب یکبار مصرف گیاهی', null);
  // The already linked variant 501 comes from connectAndList
  await connectAndList(env, { variant: { price_list: 1000000, price_sale: 1000000 } });
  dk.addVariant({ id: 601, title: 'بسته ۲۵ عددی', product_title: 'لیوان کاغذی ۲۲۰ سی سی', supplier_code: 'cup 220', price_list: 900000, price_sale: 880000 });
  dk.addVariant({ id: 602, product_title: 'بشقاب گیاهی یکبار مصرف', price_list: 500000 });
  dk.addVariant({ id: 603, product_title: 'هدفون بی‌سیم', price_list: 9000000 });
  // Digikala fills supplier_code with the seller code on every variant (seen on the live API): ignored
  dk.addVariant({ id: 604, product_title: 'دستمال کاغذی جیبی', supplier_code: '۴۲۴۲', price_list: 300000 });
  named(others[0].id, 'دستمال کاغذی جیبی', '4242');
  for (let i = 0; i < 60; i++) dk.addVariant({ id: 700 + i, product_title: `کالای آزمایشی ${i}`, price_list: 10000 });

  const r = await api.post('/api/digikala/import/preview');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 65, 'all pages read');
  assert.equal(r.body.already_linked, 1);
  assert.equal(r.body.complete, true);
  assert.ok(Array.isArray(r.body.opportunities));
  assert.ok(r.body.opportunities.every((p) => p.id !== product.id));
  const by = Object.fromEntries(r.body.items.map((x) => [x.variant_id, x]));
  assert.equal(by[501], undefined, 'linked variants are left out');
  assert.equal(by[601].suggestions[0].product_id, product.id);
  assert.equal(by[601].suggestions[0].why, 'sku', 'supplier code = SKU, spaces and case ignored');
  assert.equal(by[601].units_guess, 25);
  assert.equal(by[601].price_sale, 880000);
  assert.equal(by[602].suggestions[0].product_id, others[1].id);
  assert.equal(by[602].suggestions[0].why, 'name');
  assert.deepEqual(by[603].suggestions, [], 'no guess when nothing is close');
  assert.equal(by[604].supplier_code, null, 'the seller code is not a product code');
  assert.equal(by[604].suggestions[0].why, 'name', 'matched by name, not by the seller code');
  assert.equal(r.body.items[0].variant_id, 601, 'best matches first');

  const bad = await api.post('/api/digikala/import', { preview_id: 'nope-nope-nope', rows: [{ variant_id: 601, product_id: product.id, units: 25 }] });
  assert.equal(bad.status, 409, 'an unknown preview is refused');
  const res = await api.post('/api/digikala/import', { preview_id: r.body.preview_id, rows: [
    { variant_id: 601, product_id: product.id, units: 25 },
    { variant_id: 602, product_id: others[1].id, units: '۱' },
    { variant_id: 999, product_id: product.id, units: 1 }
  ] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, 2);
  assert.deepEqual(res.body.skipped.map((s) => s.variant_id), [999]);
  const l = ctx.db.get("SELECT * FROM listings WHERE code = '601'");
  assert.equal(l.product_id, product.id);
  assert.equal(l.units, 25);
  assert.equal(l.platform_price, 880000);
  assert.equal(l.auto_price, 0, 'automatic pricing stays off until a formula is set');
  assert.match(l.title, /لیوان کاغذی/);
  assert.ok(ctx.db.get("SELECT 1 FROM audit_log WHERE entity = 'listing' AND entity_id = ? AND summary LIKE 'ورود آگهی دیجی‌کالا%'", String(l.id)), 'audited');

  // Creating the same one twice does nothing; the next read leaves both out
  const again = await api.post('/api/digikala/import', { preview_id: r.body.preview_id, rows: [{ variant_id: 601, product_id: product.id, units: 25 }] });
  assert.equal(again.body.created, 0);
  const next = await api.post('/api/digikala/import/preview');
  assert.equal(next.body.already_linked, 3);
});


test('matcher: rejects conflicting models and sizes, keeps sale pack separate, and flags ambiguity', () => {
  const product = (id, name, sku = null) => ({ id, name, sku, units_per_pack: 1 });
  const match = createMatcher([
    product(1, 'کابلشو بی متال DTL-2 سایز 120 رادن'),
    product(2, 'کابلشو بی متال DTL-1 سایز 120 رادن'),
    product(3, 'کابلشو بی متال DTL-2 سایز 240 رادن'),
    product(4, 'سیم لخت کن کلاغی مدل 700F رادن'),
    product(5, 'انبر پرس کابلشو رادن مدل KH38 سایز 14 اینچ'),
    product(8, 'سیم لخت کن کلاغی مدل 800F رادن')
  ]);
  const result = match({ title: 'کابلشو بی متال مدل DTL-1-120 بسته 5 عددی | گارانتی اصالت و سلامت فیزیکی کالا' });
  assert.equal(result[0].product_id, 2);
  assert.ok(result.every((x) => x.product_id !== 1 && x.product_id !== 3));
  assert.ok(match({ title: 'انبر پرس کابلشو رادن مدل KH38 سایز 14 اینچ' }).every((x) => x.product_id !== 4));
  assert.ok(match({ title: 'سیم لخت کن کلاغی مدل 700F رادن' }).every((x) => x.product_id !== 8));
  const duplicates = createMatcher([product(6, 'انبر KH38', 'same'), product(7, 'انبر KH38', 'same')]);
  assert.equal(duplicates({ title: 'انبر KH38', supplier_code: 'same' })[0].confident, false);
});

test('description matching breaks name ties without accepting a conflicting model', () => {
  const match = createMatcher([
    { id: 1, name: 'انبر رادن KH38', description: 'مناسب کابل مسی روکش دار فشار قوی' },
    { id: 2, name: 'انبر رادن KH38', description: 'مناسب کابل آلومینیومی بدون روکش فشار ضعیف' },
    { id: 3, name: 'انبر رادن KH39', description: 'مناسب کابل مسی روکش دار فشار قوی' }
  ]);
  const results = match({ title: 'انبر رادن KH38', description: 'مناسب کابل مسی روکش دار فشار قوی' });
  assert.equal(results[0].product_id, 1);
  assert.ok(results[0].description_terms.includes('مسی'));
  assert.ok(results[0].score > results[1].score);
  assert.ok(results.every((s) => s.product_id !== 3));
});

test('import multiplier is saved with packaging and queues an exact price; invalid factors fail', async (t) => {
  const env = await setup(t);
  const { api, dk, ctx, product, c } = env;
  await connectAndList(env, { variant: { price_list: 1000000, price_sale: 1000000 } });
  ctx.db.run('UPDATE products SET regular_price = 4000000, description = ? WHERE id = ?', 'کابل مسی روکش دار', product.id);
  dk.addVariant({ id: 901, title: 'بسته 2 عددی', product_title: 'کابل مسی', description: '<p>کابل مسی روکش دار</p>', price_sale: 2600000 });
  const preview = await api.post('/api/digikala/import/preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.items.find((v) => v.variant_id === 901).description, 'کابل مسی روکش دار');
  const row = { variant_id: 901, product_id: product.id, units: 2, multiplier: '۱٫۳' };
  assert.equal((await api.post('/api/digikala/import', { preview_id: preview.body.preview_id, rows: [{ ...row, multiplier: 0 }] })).status, 400);
  await api.put('/api/digikala/settings', { mode: 'dry_run' });
  const saved = await api.post('/api/digikala/import', { preview_id: preview.body.preview_id, rows: [row] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await c.digikala.kick();
  const listing = ctx.db.get("SELECT * FROM listings WHERE code = '901'");
  assert.equal(listing.auto_price, 1);
  assert.equal(Math.round(listing.margin_pct), 30);
  assert.equal(priceFor(listing, { ...product, regular_price: 4000000 }).price, 2600000);
  assert.ok(ctx.db.get('SELECT * FROM dk_jobs WHERE listing_id = ?', listing.id));
  assert.equal((await api.post('/api/digikala/import', { preview_id: preview.body.preview_id, rows: [row] })).body.created, 0);
});

test('reference requests persist, track real ticket status, and wait for configuration without duplicating tickets', async (t) => {
  const env = await setup(t);
  const { api, dk, c, ctx, product } = env;
  const target = formulaPrice(product);
  await connectAndList(env, { variant: { price_list: Math.round(target / 3), price_sale: target - 10000 } });
  await api.put('/api/digikala/settings', { mode: 'live' });
  await c.digikala.kick();
  let records = (await api.get('/api/digikala/operations')).body.reference;
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'pending');
  assert.match(records[0].error, /زیردسته/);
  const logsBefore = ctx.db.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'digikala'").n;
  assert.equal((await api.post(`/api/digikala/reference/${records[0].id}/check`)).status, 409, 'missing configuration is not a success');
  assert.equal((await api.post(`/api/digikala/reference/${records[0].id}/check`)).status, 409);
  assert.equal(ctx.db.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'digikala'").n, logsBefore, 'unchanged checks do not flood the log');
  await api.put('/api/digikala/settings', { ticket_sub_category_id: 77 });
  const checks = await Promise.all([api.post(`/api/digikala/reference/${records[0].id}/check`), api.post(`/api/digikala/reference/${records[0].id}/check`)]);
  assert.ok(checks.every((r) => r.status === 200));
  assert.equal(dk.tickets.length, 1);
  await c.digikala.reference.poll();
  assert.equal(dk.tickets.length, 1, 'polling never creates a second ticket');
  records = c.digikala.reference.list();
  assert.equal(records[0].status, 'in_progress');
  dk.tickets[0].status = 'resolved';
  await c.digikala.reference.poll();
  assert.equal(c.digikala.reference.list()[0].status, 'resolved');
  assert.equal(ctx.db.get("SELECT dk_state FROM listings WHERE code = '501'").dk_state, 'blocked', 'resolved is not approval of reference price');
  assert.equal((await api.post('/api/digikala/reference/99999/check')).status, 404);
});

test('buybox uses official suggestion, requires explicit approval, rechecks stale prices and preserves an approved reduction', async (t) => {
  const env = await setup(t);
  const { api, dk, c, ctx, product } = env;
  const target = formulaPrice(product);
  const l = await connectAndList(env, { variant: { price_list: target, price_sale: target } });
  await api.put('/api/digikala/settings', { mode: 'dry_run' });
  await c.digikala.kick();
  const v = dk.variants.get(501);
  Object.assign(v, { is_buy_box_winner: false, buy_box_price: target - 5000, suggested_price: target - 8000 });
  assert.equal((await api.post('/api/digikala/buybox/check')).status, 200);
  let b = c.digikala.buybox.list()[0];
  assert.equal(b.suggested_price, target - 8000, 'official suggestion, not competitor minus one');
  assert.equal(v.price_sale, target, 'scanning never sends a price');
  const approve = () => api.post(`/api/digikala/buybox/${l.id}/approve`, { price: target - 8000 });
  assert.equal((await approve()).status, 409, 'dry run does not send');
  await api.put('/api/digikala/settings', { mode: 'live' });
  await c.digikala.kick();
  v.suggested_price = target - 9000;
  assert.equal((await approve()).status, 409, 'a changed suggestion requires new approval');
  v.suggested_price = target - 8000;
  await c.digikala.buybox.scan();
  assert.equal((await approve()).status, 200);
  assert.equal(v.price_sale, target - 8000);
  b = c.digikala.buybox.list()[0];
  assert.equal(b.decided_by, 1);
  assert.equal(b.formula_price - b.current_price, 8000);
  await api.post(`/api/digikala/listings/${l.id}/reprice`);
  await c.digikala.kick();
  assert.equal(v.price_sale, target - 8000, 'automatic pricing keeps the approved reduction');
  assert.equal(c.digikala.buybox.effectivePrice(l.id, target + 10000), target + 10000, 'new base expires the reduction');
  v.is_buy_box_winner = true;
  await c.digikala.buybox.scan();
  assert.equal(c.digikala.buybox.list()[0].suggested_price, null);
  assert.equal((await api.post(`/api/digikala/buybox/${l.id}/approve`, { price: 0 })).status, 400);
  assert.ok(ctx.db.get("SELECT 1 FROM audit_log WHERE summary LIKE 'تأیید پیشنهاد بای‌باکس%'") );
});

test('orders group line-oriented pages, save unmatched orders, retry mapping, and track cancellation without rewriting stock or prices', async (t) => {
  const env = await setup(t);
  const { api, dk, c, ctx, product } = env;
  const target = formulaPrice(product);
  const l = await connectAndList(env, { variant: { price_list: target, price_sale: target } });
  const time = new Date().toISOString();
  const line = (order, variant = 501) => ({ order_id: order, product_variant_id: variant, order_created_at: time, quantity: 2, selling_price: target });
  dk.orders.push(line(1001));
  for (let i = 0; i < 49; i++) dk.orders.push(line(2000 + i, 99999));
  dk.orders.push(line(1001, 502)); // same order, next page
  const sync = await api.post('/api/digikala/orders/sync');
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  let remote = c.digikala.orderSync.list().find((r) => r.remote_id === '1001');
  assert.equal(remote.order_id, null, 'entire order waits for matching, not a partial internal order');
  assert.match(remote.error, /502/);
  assert.equal((await api.post('/api/listings', { platform_id: 1, product_id: product.id, code: '502', units: 2 })).status, 200);
  await api.post('/api/digikala/orders/sync');
  remote = c.digikala.orderSync.list().find((r) => r.remote_id === '1001');
  assert.ok(remote.order_id);
  const lines = ctx.db.all('SELECT * FROM order_lines WHERE order_id = ?', remote.order_id);
  assert.equal(lines.length, 2, 'both pages grouped');
  assert.equal(lines.find((x) => x.listing_id === l.id).qty, 2);
  const frozen = lines[0].site_price;
  await api.post('/api/digikala/orders/sync');
  assert.equal(ctx.db.get("SELECT COUNT(*) n FROM orders WHERE order_number = '1001'").n, 1, 'no duplicate after retries');
  dk.orderHistory.push({ ...line(1001), type: 'canceled', order_status: { key: 'canceled', title: 'لغوشده' } });
  await api.post('/api/digikala/orders/sync');
  remote = c.digikala.orderSync.list().find((r) => r.remote_id === '1001');
  assert.match(remote.remote_status, /لغو/);
  assert.match(remote.error, /بررسی/);
  assert.equal(remote.history.length, 2);
  assert.equal(ctx.db.get('SELECT site_price FROM order_lines WHERE id = ?', lines[0].id).site_price, frozen);
  assert.equal(ctx.db.get('SELECT cancelled_at FROM orders WHERE id = ?', remote.order_id).cancelled_at, null, 'external cancellation never silently rewrites local fulfillment');
});

test('an ambiguous ticket creation is recorded once and never automatically duplicated', async (t) => {
  const env = await setup(t);
  const { api, dk, c, product } = env;
  const target = formulaPrice(product);
  await connectAndList(env, { variant: { price_list: Math.round(target / 3), price_sale: target - 10000 } });
  dk.ticketResponseError = true;
  await api.put('/api/digikala/settings', { mode: 'live', ticket_sub_category_id: 77 });
  await c.digikala.kick();
  const r = c.digikala.reference.list()[0];
  assert.equal(r.status, 'uncertain');
  assert.equal(dk.tickets.length, 1, 'unsafe POST is not retried after 503');
  assert.equal((await api.post(`/api/digikala/reference/${r.id}/check`)).status, 409);
  await c.digikala.reference.poll();
  assert.equal(dk.tickets.length, 1);
});

test('a reference-price refusal of a manually approved buybox suggestion opens the same tracked request workflow', async (t) => {
  const env = await setup(t);
  const { api, dk, c, product, ctx } = env;
  const target = formulaPrice(product);
  const l = await connectAndList(env, { variant: { price_list: target, price_sale: target } });
  await api.put('/api/digikala/settings', { mode: 'live', ticket_sub_category_id: 77 });
  await c.digikala.kick();
  Object.assign(dk.variants.get(501), { is_buy_box_winner: false, suggested_price: Math.round(target / 3), buy_box_price: Math.round(target / 3) });
  await c.digikala.buybox.scan();
  const res = await api.post(`/api/digikala/buybox/${l.id}/approve`, { price: Math.round(target / 3) });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(c.digikala.reference.list().length, 1);
  assert.equal(dk.tickets.length, 1);
  assert.equal(ctx.db.get('SELECT dk_state FROM listings WHERE id = ?', l.id).dk_state, 'blocked');
  assert.equal(c.digikala.buybox.list()[0].suggested_price, null);
});

test('reference forms are discovered from the seller account for each pricing type without a manual category id', async (t) => {
  const env = await setup(t);
  const { api, dk, c, product, ctx } = env;
  const target = formulaPrice(product);
  dk.ticketCategories = [{ id: 13, sub_categories: [
    { id: 113, title: 'فرم درخواست ثبت قیمت مرجع – قیمت پیشنهادی', provider: 'pricing' },
    { id: 111, title: 'فرم درخواست ثبت قیمت مرجع – قیمت چاپ شده', provider: 'pricing' },
    { id: 112, title: 'فرم درخواست ثبت قیمت مرجع – قیمت مصوب', provider: 'pricing' },
    { id: 512, title: 'نحوه تغییر قیمت مرجع', provider: 'sss' }
  ] }];
  await connectAndList(env, { variant: { price_list: Math.round(target / 3), price_sale: target - 10000 } });
  for (const [id, type] of [[502, 'printed'], [503, 'regulated']]) {
    dk.addVariant({ id, price_type: type, price_list: Math.round(target / 3), price_sale: target - 10000 });
    const r = await api.post('/api/listings', { platform_id: 1, product_id: product.id, code: String(id), units: 1, auto_price: true, margin_pct: 30, fixed_add: '', round_to: '1000' });
    assert.equal(r.status, 200);
  }
  await api.put('/api/digikala/settings', { mode: 'live' });
  await c.digikala.kick();
  assert.deepEqual(dk.tickets.map((t) => t.sub_category_id).sort(), [111, 112, 113]);
  assert.ok(c.digikala.reference.list().every((r) => r.status === 'submitted' && r.ticket_id));
  assert.equal(ctx.db.get('SELECT ticket_sub_category_id FROM dk_connection').ticket_sub_category_id, null, 'per-type discovery does not force a global override');
  assert.equal(dk.calls.filter((r) => r.path === '/tickets/categories').length, 1, 'category list is cached across variants');
  const id = c.digikala.reference.list()[0].id;
  await api.post(`/api/digikala/reference/${id}/check`);
  const logs = ctx.db.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'digikala'").n;
  await api.post(`/api/digikala/reference/${id}/check`);
  assert.equal(ctx.db.get("SELECT COUNT(*) n FROM audit_log WHERE action = 'digikala'").n, logs, 'same remote status does not create another audit entry');
});

test('reference form selects the required product branch and refuses incomplete or incompatible forms before posting', () => {
  const { referenceForm } = require('../../server/lib/digikala-reference');
  const fields = [{ type: 'select', name: 'method', is_required: true, extra: { options: [{ value: 'opt_0' }] } },
    { type: 'dynamic_modal', name: 'products', extra: { price_type: 'recommended' }, condition: { field_name: 'method', operation: 'eq', value: 'opt_0' } },
    { type: 'file', name: 'excel', is_required: true, condition: { field_name: 'method', operation: 'eq', value: 'opt_1' } }];
  const variant = { product_id: 10, price_type: 'recommended' };
  assert.equal(referenceForm({ items: fields }, variant, 150000).method, 'opt_0');
  assert.throws(() => referenceForm({ items: [...fields, { name: 'document', label: 'مدرک', is_required: true }] }, variant, 150000), /مدرک/);
  assert.throws(() => referenceForm({ items: fields }, { ...variant, price_type: 'printed' }, 150000), /سازگار/);
  assert.throws(() => referenceForm({ items: fields.slice(1) }, variant, 150000), /شرط/);
});
