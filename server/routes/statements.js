'use strict';
/** Monthly statements: overview, one month (draft or issued), issue, paid, void, Excel. */
const { z, text, optText, intIn } = require('./validate');
const { badRequest } = require('../lib/util');
const { isMonth, monthOf, monthsBetween, monthLabel, parseDateTime } = require('../lib/jalali');

module.exports = async function statementRoutes(app) {
  const { db, statements } = app.ctx;

  app.get('/statements/overview', async () => {
    const first = db.get('SELECT MIN(ordered_at) AS t FROM orders').t;
    const now = new Date().toISOString();
    const months = monthsBetween(monthOf(first || now), monthOf(now)).map((m) => ({ month: m, label: monthLabel(m) }));
    return { companies: statements.overview(), months };
  });

  app.get('/statements/month', async (req) => {
    const companyId = Number(req.query.company);
    if (!companyId) throw badRequest('شرکت را انتخاب کنید.');
    if (!isMonth(req.query.month)) throw badRequest('ماه معتبر نیست.');
    return statements.view(companyId, req.query.month);
  });

  app.post('/statements', async (req) => {
    const b = z.object({
      company_id: intIn('شرکت', 1, 1e9),
      month: z.string().refine(isMonth, 'ماه معتبر نیست.'),
      note: optText(1000).optional()
    }).parse(req.body || {});
    statements.issue(req, b.company_id, b.month, b.note);
    return statements.view(b.company_id, b.month);
  });

  app.post('/statements/:id/paid', async (req) => {
    const b = z.object({
      reference: optText(200).optional(),
      paid_at: z.preprocess((v) => (v ? parseDateTime(v) : undefined), z.string({ error: 'تاریخ معتبر نیست.' }).optional())
    }).parse(req.body || {});
    statements.markPaid(req, req.params.id, b);
    const s = db.get('SELECT company_id, month FROM statements WHERE id = ?', Number(req.params.id));
    return statements.view(s.company_id, s.month);
  });

  app.post('/statements/:id/void', { config: { manager: true } }, async (req) => {
    const b = z.object({ reason: text('دلیل ابطال', 500) }).parse(req.body || {});
    statements.voidStatement(req, req.params.id, b.reason);
    const s = db.get('SELECT company_id, month FROM statements WHERE id = ?', Number(req.params.id));
    return statements.view(s.company_id, s.month);
  });

  /** The month as an Excel file (the issued statement, or the draft). */
  app.get('/statements/excel', async (req, reply) => {
    const companyId = Number(req.query.company);
    if (!companyId || !isMonth(req.query.month)) throw badRequest('شرکت و ماه را مشخص کنید.');
    const buf = await statements.excel(companyId, req.query.month);
    // An ASCII name: Chrome turns non-Latin names in this header into a bare "download" with no extension
    const name = `anbar-statement-${req.query.month}-company-${companyId}.xlsx`;
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${name}"`).send(buf);
  });
};
