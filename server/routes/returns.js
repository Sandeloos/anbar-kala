'use strict';
/** Customer returns: record, decide (keep / back to the company / damaged), undo, void. */
const { z, text, optText, intIn } = require('./validate');
const { parseDateTime } = require('../lib/jalali');

module.exports = async function returnRoutes(app) {
  const { returns } = app.ctx;

  app.get('/returns', async (req) => {
    const q = req.query || {};
    return { items: returns.list({ status: q.status || 'waiting', company: q.company, q: q.q }) };
  });

  /** How many units of a line can still be returned / credited (for the return form). */
  app.get('/order-lines/:id/returns', async (req) => {
    const c = returns.lineCounts(req.params.id);
    return { shipped: c.shipped, returned: c.returned, returnable: c.returnable, billable: c.billable, credited: c.credited, creditable: c.creditable };
  });

  app.post('/order-lines/:id/returns', async (req) => {
    const b = z.object({
      units: intIn('تعداد', 1, 1000000),
      warehouse_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
      reason: optText(500).optional(),
      returned_at: z.preprocess((v) => (v ? parseDateTime(v) : undefined), z.string({ error: 'تاریخ معتبر نیست.' }).optional())
    }).parse(req.body || {});
    return { return: returns.create(req, Number(req.params.id), b) };
  });

  app.post('/returns/:id/decide', async (req) => {
    const b = z.object({ disposition: z.enum(['kept', 'to_company', 'damaged'], { error: 'تصمیم را انتخاب کنید.' }), note: optText(500).optional() }).parse(req.body || {});
    return { return: returns.decide(req, req.params.id, b) };
  });

  app.post('/returns/:id/undo', async (req) => ({ return: returns.undoDecision(req, req.params.id) }));

  app.post('/returns/:id/void', async (req) => {
    const b = z.object({ reason: text('دلیل', 500) }).parse(req.body || {});
    return { return: returns.voidReturn(req, req.params.id, b.reason) };
  });
};
