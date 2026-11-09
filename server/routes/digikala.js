'use strict';
/**
 * Digikala automatic pricing. The connection (key, token, mode, limits) is for the manager;
 * approving a large change, re-activating a refused variant and "check now" for any admin.
 */
const { z, intIn, optText } = require('./validate');

module.exports = async function digikalaRoutes(app) {
  const { digikala } = app.ctx;
  const manager = { config: { manager: true } };

  app.get('/digikala', async (req) => ({
    status: digikala.status(),
    attention: digikala.jobs({ status: 'attention', limit: 100 }).filter((j) => j.status === 'needs_approval' || j.status === 'failed'),
    blocked: digikala.blocked(),
    recent: digikala.jobs({ limit: Number(req.query.limit) || 60 })
  }));

  app.put('/digikala/settings', manager, async (req) => {
    const b = z.object({
      mode: z.enum(['off', 'dry_run', 'live'], { error: 'حالت را انتخاب کنید.' }).optional(),
      max_change_pct: intIn('سقف تغییر خودکار', 1, 300).optional(),
      ticket_sub_category_id: z.preprocess((v) => (v === '' || v === undefined ? undefined : v === null ? null : Number(v)), z.number().int().positive().nullable().optional()),
      base_url: z.preprocess((v) => (v ? String(v).trim() : undefined), z.url({ protocol: /^https?$/, error: 'آدرس معتبر نیست.' }).optional())
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

  app.post('/digikala/listings/:id/reprice', async (req) => ({ job: digikala.reprice(req, req.params.id) }));
};
