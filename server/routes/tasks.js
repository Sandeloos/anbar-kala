'use strict';
/** The inbox: what to change on Digikala / Basalam after a company site changed. */
const { z, optText, text, amount } = require('./validate');
const { toRial } = require('../lib/util');

module.exports = async function taskRoutes(app) {
  const { tasks } = app.ctx;

  app.get('/tasks', async (req) => {
    const q = req.query || {};
    return { items: tasks.list({ status: q.status || 'open', platform: q.platform, kind: q.kind, company: q.company }) };
  });

  /** platform_price is typed in tomans, like every platform price in the app. */
  app.post('/tasks/:id/done', async (req) => {
    const b = z.object({
      platform_price: z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), amount('قیمت در پلتفرم').nullable()).optional(),
      note: optText(500).optional()
    }).parse(req.body || {});
    const price = b.platform_price === null || b.platform_price === undefined ? null : toRial(b.platform_price, 'toman');
    return { task: tasks.done(req, req.params.id, { platformPrice: price, note: b.note }) };
  });

  app.post('/tasks/:id/dismiss', async (req) => {
    const b = z.object({ note: text('دلیل', 500) }).parse(req.body || {});
    return { task: tasks.dismiss(req, req.params.id, b.note) };
  });
};
