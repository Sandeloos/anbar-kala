'use strict';
/**
 * Optimistic locking for records people edit (companies, products, listings, users, warehouses).
 * Each has a `version` that grows by one on every edit. The form sends the version it loaded as
 * `If-Match`; if someone saved in between, the edit is refused with 409 (code "stale") and the
 * name of whoever changed it, instead of silently overwriting their work.
 *
 *  - check(req, row): early refusal when If-Match names an older version. Requests without
 *    If-Match (scripts, older clients) skip this step.
 *  - every edit then runs `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?` with
 *    the version it read, and calls stale() when no row changed: another save landed while this
 *    one was working (e.g. testing a company's API key), so even unchecked requests never lose
 *    an edit silently.
 */
const { HttpError, badRequest } = require('./util');

function createConcurrency({ db }) {
  function stale(row, { entity, label }) {
    const last = row && db.get(`SELECT u.name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                                WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.id DESC LIMIT 1`, entity, String(row.id));
    const who = last && last.name ? ` توسط ${last.name}` : '';
    throw new HttpError(409, `${label} در این فاصله${who} تغییر کرده است. صفحه را تازه کنید و تغییرتان را دوباره ثبت کنید.`, {
      code: 'stale', current_version: row ? row.version : null
    });
  }

  function check(req, row, what) {
    const header = req.headers['if-match'];
    if (header === undefined || header === '' || header === '*') return;
    const expected = Number(String(header).replace(/^W\//, '').replace(/"/g, ''));
    if (!Number.isInteger(expected)) throw badRequest('نسخه‌ی ارسال‌شده (If-Match) معتبر نیست.');
    if (expected !== row.version) stale(row, what);
  }

  return { check, stale };
}

module.exports = { createConcurrency };
