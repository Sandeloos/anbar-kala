'use strict';
/**
 * The activity log. Every change a person makes is written here with who,
 * when, from where and exactly which fields changed (before → after).
 * Rows are never updated or deleted.
 */
const { nowIso } = require('./util');

/**
 * Field-by-field difference between two rows.
 * fields: { column: 'Persian label' } — only these are compared.
 */
function diff(before, after, fields) {
  const changes = [];
  for (const [field, label] of Object.entries(fields)) {
    const a = before ? before[field] : null;
    const b = after ? after[field] : null;
    const norm = (v) => (v === undefined || v === '' ? null : v);
    if (String(norm(a)) !== String(norm(b))) changes.push({ field, label, from: norm(a), to: norm(b) });
  }
  return changes;
}

function createAudit(db, events) {
  /**
   * audit(req|user, { action, entity, id, summary, changes })
   * `who` may be a Fastify request (uses req.user and req.ip) or a user object / null (system).
   */
  function audit(who, { action, entity, id, summary, changes }) {
    const user = who && who.user !== undefined ? who.user : who;
    const ip = who && who.ip !== undefined ? who.ip : null;
    const info = db.run(`INSERT INTO audit_log (user_id, action, entity, entity_id, summary, changes, ip, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    user ? user.id : null, action, entity, id === undefined || id === null ? null : String(id), summary,
    changes && changes.length ? JSON.stringify(changes) : null, ip, nowIso());
    if (events) events.emit('activity', { id: Number(info.lastInsertRowid), entity, entityId: id, action });
  }
  audit.diff = diff;
  return audit;
}

module.exports = { createAudit, diff };
