'use strict';
/**
 * Companies under contract and the connection to their WooCommerce sites.
 * A company is saved only after its site answered with the given API keys;
 * the first full sync starts right away in the background.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { zip } = require('../lib/zip');
const { z, text, optText, phone, bool, intIn } = require('./validate');
const { normaliseSiteUrl, nowIso, notFound, badRequest, conflict, PRICE_UNITS, clampInt } = require('../lib/util');
const { unitFromSite } = require('../lib/woo');

const CURRENCY = z.enum(['toman', 'rial'], { error: 'واحد پول را انتخاب کنید.' });
const UNIT = z.enum(Object.keys(PRICE_UNITS), { error: 'واحد قیمت سایت را انتخاب کنید.' });
const siteUrl = z.preprocess((v) => normaliseSiteUrl(v) || v, z.string({ error: 'آدرس سایت را وارد کنید.' })
  .refine((s) => normaliseSiteUrl(s) === s, 'آدرس سایت معتبر نیست.'));
const keyField = (label) => z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string({ error: `${label} را وارد کنید.` }).min(10, `${label} معتبر نیست.`).max(200));

const FIELDS = {
  name: 'نام', site_url: 'آدرس سایت', currency: 'واحد پول گزارش', price_unit: 'واحد قیمت سایت', warehouse: 'انبار اضافه‌ها',
  contact_name: 'نام رابط', contact_phone: 'تلفن رابط', notes: 'یادداشت', active: 'فعال'
};
const CURRENCY_LABEL = { toman: 'تومان', rial: 'ریال' };

module.exports = async function companyRoutes(app) {
  const { db, audit, sync, secrets, events } = app.ctx;

  function webhookUrl(req, id) {
    const base = app.ctx.config.publicUrl || `${req.protocol}://${req.headers.host}`;
    return `${base}/hooks/woo/${id}`;
  }
  function view(c, req) {
    const counts = db.get(`SELECT COUNT(*) AS products,
        SUM(CASE WHEN stock_status = 'outofstock' THEN 1 ELSE 0 END) AS out_of_stock,
        SUM(CASE WHEN configured_at IS NULL THEN 1 ELSE 0 END) AS needs_setup
      FROM products WHERE company_id = ? AND removed_at IS NULL`, c.id);
    const changes = db.get(`SELECT COUNT(*) AS n FROM price_history h JOIN products p ON p.id = h.product_id
      WHERE p.company_id = ? AND h.price_changed = 1 AND h.source <> 'import' AND h.observed_at >= ?`, c.id, new Date(Date.now() - 864e5).toISOString()).n;
    const wh = c.warehouse_id ? db.get('SELECT id, name FROM warehouses WHERE id = ?', c.warehouse_id) : null;
    return {
      id: c.id, name: c.name, site_url: c.site_url, currency: c.currency, price_unit: c.price_unit, site_currency: c.site_currency,
      key_hint: c.key_hint, api_style: c.api_style, auth_mode: c.auth_mode, warehouse: wh,
      contact_name: c.contact_name, contact_phone: c.contact_phone, notes: c.notes, active: !!c.active,
      sync_state: sync.isRunning(c.id) ? 'running' : c.sync_state, sync_error: c.sync_error,
      last_full_sync_at: c.last_full_sync_at, last_incremental_at: c.last_incremental_at, last_webhook_at: c.last_webhook_at,
      products: counts.products || 0, out_of_stock: counts.out_of_stock || 0, needs_setup: counts.needs_setup || 0, price_changes_24h: changes,
      webhook_url: req ? webhookUrl(req, c.id) : null, webhook_secret: c.webhook_secret,
      created_at: c.created_at, updated_at: c.updated_at
    };
  }
  const one = (id) => {
    const c = db.get('SELECT * FROM companies WHERE id = ?', Number(id));
    if (!c) throw notFound('شرکت پیدا نشد.');
    return c;
  };
  const warehouseName = (id) => (id ? (db.get('SELECT name FROM warehouses WHERE id = ?', id) || {}).name : null);
  /** Background sync started from the panel; failures are stored on the company. */
  function kick(id, kind, userId) {
    const fn = kind === 'incremental' ? sync.incrementalSync : sync.fullSync;
    fn(id, { userId }).catch((err) => app.log.warn({ company: id, err: err.message }, 'sync failed'));
  }

  app.get('/companies', async (req) => {
    const rows = db.all('SELECT * FROM companies ORDER BY active DESC, name');
    return { items: rows.map((c) => view(c, req)) };
  });

  app.get('/companies/:id', async (req) => {
    const c = one(req.params.id);
    const runs = db.all('SELECT * FROM sync_runs WHERE company_id = ? ORDER BY id DESC LIMIT 15', c.id);
    return { company: view(c, req), runs };
  });

  /** Checks a site and keys without saving anything. */
  app.post('/companies/test', async (req) => {
    const body = z.object({ site_url: siteUrl, key: keyField('کلید مصرف‌کننده'), secret: keyField('رمز مصرف‌کننده') }).parse(req.body || {});
    const r = await sync.detect({ siteUrl: body.site_url, key: body.key, secret: body.secret });
    return { ...r, price_unit: unitFromSite(r.siteCurrency), site_url: body.site_url };
  });

  const companyBody = (partial) => z.object({
    name: text('نام شرکت', 120),
    site_url: siteUrl,
    key: partial ? z.string().optional() : keyField('کلید مصرف‌کننده'),
    secret: partial ? z.string().optional() : keyField('رمز مصرف‌کننده'),
    currency: CURRENCY,
    price_unit: UNIT,
    warehouse_id: z.preprocess((v) => (v === '' || v === undefined ? null : v), intIn('انبار', 1, 1e9).nullable()),
    contact_name: optText(120).optional(),
    contact_phone: phone.optional(),
    notes: optText(2000).optional(),
    active: partial ? bool : bool.optional()
  });

  app.post('/companies', async (req) => {
    const body = companyBody(false).parse(req.body || {});
    if (db.get('SELECT 1 FROM companies WHERE site_url = ?', body.site_url)) throw conflict('این سایت قبلاً ثبت شده است.', { site_url: 'تکراری است.' });
    if (body.warehouse_id && !warehouseName(body.warehouse_id)) throw badRequest('انبار پیدا نشد.', { warehouse_id: 'پیدا نشد.' });
    const found = await sync.detect({ siteUrl: body.site_url, key: body.key, secret: body.secret });
    const now = nowIso();
    const info = db.run(`INSERT INTO companies (name, site_url, currency, price_unit, woo_key_enc, woo_secret_enc, key_hint, api_style, auth_mode,
        webhook_secret, warehouse_id, contact_name, contact_phone, notes, site_currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    body.name, body.site_url, body.currency, body.price_unit, secrets.encrypt(body.key), secrets.encrypt(body.secret), body.key.slice(-4),
    found.apiStyle, found.authMode, crypto.randomBytes(24).toString('base64url'), body.warehouse_id ?? null,
    body.contact_name ?? null, body.contact_phone ?? null, body.notes ?? null, found.siteCurrency, now, now);
    const id = Number(info.lastInsertRowid);
    audit(req, { action: 'create', entity: 'company', id, summary: `افزودن شرکت «${body.name}» (${body.site_url})` });
    kick(id, 'full', req.user.id);
    events.emit('company', { id });
    return { company: view(one(id), req) };
  });

  app.put('/companies/:id', async (req) => {
    const before = one(req.params.id);
    const body = companyBody(true).parse(req.body || {});
    const dupe = db.get('SELECT id FROM companies WHERE site_url = ? AND id <> ?', body.site_url, before.id);
    if (dupe) throw conflict('این سایت برای شرکت دیگری ثبت شده است.', { site_url: 'تکراری است.' });
    if (body.warehouse_id && !warehouseName(body.warehouse_id)) throw badRequest('انبار پیدا نشد.', { warehouse_id: 'پیدا نشد.' });
    const newKey = body.key && body.key.trim();
    const newSecret = body.secret && body.secret.trim();
    if ((newKey && !newSecret) || (!newKey && newSecret)) throw badRequest('کلید و رمز API را با هم وارد کنید.', { secret: 'هر دو لازم است.' });
    let conn = { api_style: before.api_style, auth_mode: before.auth_mode, site_currency: before.site_currency };
    const keysChanged = !!newKey;
    if (keysChanged || body.site_url !== before.site_url) {
      const found = await sync.detect({
        siteUrl: body.site_url,
        key: newKey || secrets.decrypt(before.woo_key_enc),
        secret: newSecret || secrets.decrypt(before.woo_secret_enc)
      });
      conn = { api_style: found.apiStyle, auth_mode: found.authMode, site_currency: found.siteCurrency };
    }
    const keep = (k) => (body[k] === undefined ? before[k] : body[k]);
    const after = {
      ...before, ...body, contact_name: keep('contact_name'), contact_phone: keep('contact_phone'), notes: keep('notes'),
      warehouse_id: body.warehouse_id ?? null, active: body.active ? 1 : 0
    };
    const label = (r) => ({ ...r, currency: CURRENCY_LABEL[r.currency], price_unit: PRICE_UNITS[r.price_unit].label, warehouse: warehouseName(r.warehouse_id), active: r.active ? 'بله' : 'خیر' });
    const changes = audit.diff(label(before), label(after), FIELDS);
    if (keysChanged) changes.push({ field: 'key', label: 'کلید API', from: `…${before.key_hint || ''}`, to: `…${newKey.slice(-4)}` });
    db.run(`UPDATE companies SET name = ?, site_url = ?, currency = ?, price_unit = ?, warehouse_id = ?, contact_name = ?, contact_phone = ?,
              notes = ?, active = ?, api_style = ?, auth_mode = ?, site_currency = ?, updated_at = ?,
              woo_key_enc = COALESCE(?, woo_key_enc), woo_secret_enc = COALESCE(?, woo_secret_enc), key_hint = COALESCE(?, key_hint)
            WHERE id = ?`,
    after.name, after.site_url, after.currency, after.price_unit, after.warehouse_id, after.contact_name, after.contact_phone,
    after.notes, after.active, conn.api_style, conn.auth_mode, conn.site_currency, nowIso(),
    keysChanged ? secrets.encrypt(newKey) : null, keysChanged ? secrets.encrypt(newSecret) : null, keysChanged ? newKey.slice(-4) : null,
    before.id);
    if (changes.length) audit(req, { action: 'update', entity: 'company', id: before.id, summary: `ویرایش شرکت «${after.name}»`, changes });
    // A different price unit changes every stored number: re-read everything with the new unit
    if (before.price_unit !== after.price_unit || keysChanged || body.site_url !== before.site_url) {
      if (!sync.isRunning(before.id)) kick(before.id, 'full', req.user.id);
    }
    events.emit('company', { id: before.id });
    return { company: view(one(before.id), req) };
  });

  app.post('/companies/:id/sync', async (req, reply) => {
    const c = one(req.params.id);
    const kind = (req.body && req.body.kind) === 'incremental' ? 'incremental' : 'full';
    if (sync.isRunning(c.id)) throw conflict('همگام‌سازی این شرکت همین حالا در حال انجام است.');
    kick(c.id, kind, req.user.id);
    audit(req, { action: 'sync', entity: 'company', id: c.id, summary: `${kind === 'full' ? 'همگام‌سازی کامل' : 'همگام‌سازی تغییرات'} «${c.name}» به‌صورت دستی` });
    return reply.code(202).send({ started: true });
  });

  app.get('/companies/:id/runs', async (req) => {
    const c = one(req.params.id);
    return { items: db.all('SELECT * FROM sync_runs WHERE company_id = ? ORDER BY id DESC LIMIT ?', c.id, clampInt(req.query.limit, 1, 200, 30)) };
  });

  /** The WordPress plugin as an installable zip (built from wordpress-plugin/ on each download). */
  app.get('/plugin/anbar-connector.zip', async (req, reply) => {
    const dir = path.join(app.ctx.config.root, 'wordpress-plugin', 'anbar-connector');
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'))
      .map((f) => ({ name: `anbar-connector/${f}`, data: fs.readFileSync(path.join(dir, f)) }));
    return reply.type('application/zip').header('Content-Disposition', 'attachment; filename="anbar-connector.zip"').send(zip(files));
  });

  app.post('/companies/:id/webhook-secret', async (req) => {
    const c = one(req.params.id);
    const secret = crypto.randomBytes(24).toString('base64url');
    db.run('UPDATE companies SET webhook_secret = ?, updated_at = ? WHERE id = ?', secret, nowIso(), c.id);
    audit(req, { action: 'update', entity: 'company', id: c.id, summary: `ساخت رمز جدید افزونه برای «${c.name}» (رمز قبلی دیگر کار نمی‌کند)` });
    return { company: view(one(c.id), req) };
  });
};
