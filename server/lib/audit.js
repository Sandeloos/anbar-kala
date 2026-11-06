'use strict';
/**
 * The activity log. Every change a person makes is written here with who,
 * when, from where and exactly which fields changed (before → after).
 * Rows are never updated or deleted (triggers in migration 005), and each row is written
 * in the same transaction as the change it describes.
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

/**
 * strict (development and tests): audit() outside a transaction is a programming error — the
 * change it describes and its log line must commit or roll back together. In production the row
 * is still written (a log line is never lost) and the mistake is reported through onLoose.
 */
function createAudit(db, events, { strict = true, onLoose = () => {} } = {}) {
  /**
   * audit(req|user, { action, entity, id, summary, changes })
   * `who` may be a Fastify request (uses req.user and req.ip) or a user object / null (system).
   */
  function audit(who, { action, entity, id, summary, changes }) {
    if (!db.inTransaction) {
      const err = new Error(`audit(${action} ${entity}) outside a transaction: wrap the change and its audit in db.tx()`);
      if (strict) throw err;
      onLoose(err);
    }
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
