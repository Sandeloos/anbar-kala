'use strict';
/**
 * Digikala automatic pricing. The connection (key, token, mode, limits) is for the manager;
 * approving a large change, re-activating a refused variant and "check now" for any admin.
 */
const { toLatinDigits } = require('../lib/util');
const { z, intIn, optText } = require('./validate');

module.exports = async function digikalaRoutes(app) {
  const { digikala } = app.ctx;
  const manager = { config: { manager: true } };
  const reportDates = z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() });

  app.get('/digikala/order-report', async (req) => digikala.orderReport.orders(reportDates.extend({
    company: z.coerce.number().int().positive().optional(), q: optText(180).optional()
  }).parse(req.query)));
  app.get('/digikala/seller-packages', async (req) => digikala.orderReport.packages(reportDates.parse(req.query)));
  app.get('/digikala/seller-packages/:id', async (req) => {
    const id = intIn('شناسهٔ محموله', 1, Number.MAX_SAFE_INTEGER).parse(req.params.id);
    return digikala.orderReport.packageDetails(id);
  });

  app.get('/digikala', async (req) => ({
    status: digikala.status(),
    attention: digikala.jobs({ status: 'attention', limit: 100 }).filter((j) => j.status === 'needs_approval' || j.status === 'failed'),
    blocked: digikala.blocked(),
    packaging_count: app.ctx.packaging.count(),
    recent: digikala.jobs({ limit: Number(req.query.limit) || 60 })
  }));

  app.put('/digikala/settings', manager, async (req) => {
    const b = z.object({
      mode: z.enum(['off', 'dry_run', 'live'], { error: 'حالت را انتخاب کنید.' }).optional(),
      max_change_pct: intIn('سقف تغییر خودکار', 1, 300).optional(),
      ticket_sub_category_id: z.preprocess((v) => (v === '' || v === undefined ? undefined : v === null ? null : Number(v)), z.number().int().positive().nullable().optional()),
      base_url: z.preprocess((v) => (v ? String(v).trim() : undefined), z.url({ protocol: /^https?$/, error: 'آدرس معتبر نیست.' }).optional()),
      user_agent: z.preprocess((v) => (v === undefined ? undefined : String(v ?? '').trim()),
        z.string().max(300, 'User-Agent خیلی بلند است.').regex(/^[\x20-\x7e]*$/, 'فقط حروف و نشانه‌های انگلیسی.').optional())
    }).parse(req.body || {});
    return { status: digikala.setSettings(req, b) };
  });

  app.post('/digikala/key', manager, async (req) => {
    const b = z.object({ private_key: z.string({ error: 'متن کلید خصوصی را بگذارید.' }).min(100, 'متن کلید خصوصی کامل نیست.').max(20000) }).parse(req.body || {});
    return { status: digikala.setKey(req, b.private_key) };
  });

  app.post('/digikala/connect', manager, async (req) => {
    const b = z.object({
      client_code: optText(200).optional(),
      challenge: z.string({ error: 'کد اعتبارسنجی را بگذارید.' }).min(20, 'کد اعتبارسنجی کامل نیست.').max(20000)
    }).parse(req.body || {});
    return { status: await digikala.connect(req, b) };
  });

  app.post('/digikala/jobs/:id/approve', async (req) => { digikala.approve(req, req.params.id); return { ok: true }; });
  app.post('/digikala/jobs/:id/reject', async (req) => { digikala.reject(req, req.params.id); return { ok: true }; });

  app.post('/digikala/listings/:id/reactivate', async (req) => {
    const b = z.object({ stock: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), intIn('موجودی', 0, 1000000).optional()) }).parse(req.body || {});
    return { listing: await digikala.reactivate(req, req.params.id, b) };
  });

  /* Import: read every seller variant with suggested site products, then create the confirmed listings */
  app.post('/digikala/import/preview', async () => digikala.importPreview());

  app.post('/digikala/import', async (req) => {
    const b = z.object({
      preview_id: z.string({ error: 'فهرست خوانده نشده.' }).min(8).max(64),
      rows: z.array(z.object({
        variant_id: intIn('کد تنوع', 1, 1e12),
        product_id: intIn('کالای سایت', 1, 1e9),
        units: intIn('تعداد عدد در هر فروش', 1, 100000),
        auto_price: z.boolean().optional(),
        multiplier: z.preprocess((v) => v === undefined ? undefined : Number(toLatinDigits(String(v)).replace(/٫/g, '.')), z.number().min(0.5).max(11).optional())
      }), { error: 'چیزی انتخاب نشده.' }).min(1, 'دست‌کم یک تنوع را انتخاب کنید.').max(5000)
    }).parse(req.body || {});
    return digikala.importCreate(req, b.preview_id, b.rows);
  });

  app.post('/digikala/listings/:id/reprice', async (req) => ({ job: digikala.reprice(req, req.params.id) }));

  app.get('/digikala/operations', async (req) => ({ reference: digikala.reference.list(), buybox: digikala.buybox.list(),
    orders: req.query.from && req.query.to ? digikala.orderSync.list(z.object({ from: z.iso.datetime(), to: z.iso.datetime() }).parse(req.query)) : [], sync: digikala.orderSync.state() }));
  app.post('/digikala/reference/:id/check', async (req) => { await digikala.reference.refresh(req, req.params.id); return { ok: true }; });
  app.post('/digikala/buybox/check', async () => { await digikala.buybox.scan(); return { ok: true }; });
  app.post('/digikala/buybox/:id/approve', async (req) => {
    const b = z.object({ price: intIn('قیمت پیشنهادی', 1, Number.MAX_SAFE_INTEGER) }).parse(req.body || {});
    await digikala.buybox.approve(req, req.params.id, b.price);
    return { ok: true };
  });
  app.post('/digikala/orders/sync', async (req) => digikala.orderSync.sync(req));
};
