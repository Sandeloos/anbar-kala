'use strict';
/** Sandeloos' own warehouses. Never deleted, only deactivated. */
const { z, text, optText, bool } = require('./validate');
const { nowIso, notFound, conflict, badRequest } = require('../lib/util');

const FIELDS = { name: 'نام', notes: 'یادداشت', active: 'فعال' };

module.exports = async function warehouseRoutes(app) {
  const { db, audit } = app.ctx;

  const list = () => db.all(`SELECT w.*,
      (SELECT COUNT(*) FROM companies c WHERE c.warehouse_id = w.id) AS companies,
      (SELECT COUNT(*) FROM products p WHERE p.warehouse_id = w.id AND p.removed_at IS NULL) AS products
    FROM warehouses w ORDER BY w.active DESC, w.id`).map((w) => ({ ...w, active: !!w.active }));

  app.get('/warehouses', async () => ({ items: list() }));

  app.post('/warehouses', async (req) => {
    const body = z.object({ name: text('نام انبار', 60), notes: optText(1000).optional() }).parse(req.body || {});
    if (db.get('SELECT 1 FROM warehouses WHERE name = ?', body.name)) throw conflict('انباری با این نام هست.', { name: 'تکراری است.' });
    const now = nowIso();
    const id = Number(db.run('INSERT INTO warehouses (name, notes, created_at, updated_at) VALUES (?, ?, ?, ?)', body.name, body.notes ?? null, now, now).lastInsertRowid);
    audit(req, { action: 'create', entity: 'warehouse', id, summary: `افزودن انبار «${body.name}»` });
    return { items: list() };
  });

  app.put('/warehouses/:id', async (req) => {
    const before = db.get('SELECT * FROM warehouses WHERE id = ?', Number(req.params.id));
    if (!before) throw notFound('انبار پیدا نشد.');
    const body = z.object({ name: text('نام انبار', 60), notes: optText(1000).optional(), active: bool }).parse(req.body || {});
    if (db.get('SELECT 1 FROM warehouses WHERE name = ? AND id <> ?', body.name, before.id)) throw conflict('انباری با این نام هست.', { name: 'تکراری است.' });
    if (before.active && !body.active && db.get('SELECT COUNT(*) AS n FROM warehouses WHERE active = 1').n <= 1) {
      throw badRequest('دست‌کم یک انبار فعال لازم است.');
    }
    const after = { ...before, name: body.name, notes: body.notes ?? null, active: body.active ? 1 : 0 };
    const yn = (r) => ({ ...r, active: r.active ? 'بله' : 'خیر' });
    const changes = audit.diff(yn(before), yn(after), FIELDS);
    if (changes.length) {
      db.run('UPDATE warehouses SET name = ?, notes = ?, active = ?, updated_at = ? WHERE id = ?', after.name, after.notes, after.active, nowIso(), before.id);
      audit(req, { action: 'update', entity: 'warehouse', id: before.id, summary: `ویرایش انبار «${after.name}»`, changes });
    }
    return { items: list() };
  });
};
