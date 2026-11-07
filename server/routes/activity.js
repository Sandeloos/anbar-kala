'use strict';
/** The activity log: who changed what and when, with field-level before/after. */
const { clampInt, searchKey } = require('../lib/util');

module.exports = async function activityRoutes(app) {
  const { db } = app.ctx;

  app.get('/activity', async (req) => {
    const q = req.query || {};
    const per = clampInt(q.per, 10, 200, 50);
    const page = clampInt(q.page, 1, 100000, 1);
    const where = [];
    const params = [];
    if (q.user === 'system') where.push('a.user_id IS NULL');
    else if (q.user) { where.push('a.user_id = ?'); params.push(Number(q.user)); }
    if (q.entity) { where.push('a.entity = ?'); params.push(String(q.entity)); }
    if (q.entity_id) { where.push('a.entity_id = ?'); params.push(String(q.entity_id)); }
    if (q.action) { where.push('a.action = ?'); params.push(String(q.action)); }
    if (q.hide_logins === '1') where.push("a.action <> 'login'");
    if (q.from) { where.push('a.created_at >= ?'); params.push(new Date(q.from).toISOString()); }
    if (q.to) { where.push('a.created_at < ?'); params.push(new Date(q.to).toISOString()); }
    const sql = `FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    let rows;
    let total;
    const term = searchKey(q.q || '');
    if (term) {
      // Persian spellings vary, so filter in JS over a bounded window instead of SQL LIKE
      const all = db.all(`SELECT a.*, u.name AS user_name ${sql} ORDER BY a.id DESC LIMIT 5000`, ...params)
        .filter((r) => searchKey(`${r.summary} ${r.changes || ''} ${r.user_name || ''}`).includes(term));
      total = all.length;
      rows = all.slice((page - 1) * per, page * per);
    } else {
      total = db.get(`SELECT COUNT(*) AS n ${sql}`, ...params).n;
      rows = db.all(`SELECT a.*, u.name AS user_name ${sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    }
    return {
      items: rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] })),
      total, page, pages: Math.max(1, Math.ceil(total / per))
    };
  });
};
