'use strict';
/** Small key/value settings with defaults; the manager edits them in the panel. */

const DEFAULTS = {
  // Minutes between full reads of every product of a site (also catches deleted products)
  full_sync_minutes: 60,
  // Minutes between reads of recently modified products
  incremental_sync_minutes: 5,
  // Inbox: a site stock at or below this many items counts as "low"
  low_stock_units: 5,
  // Daily database backups kept on the server
  backup_keep: 14
};
const LIMITS = {
  full_sync_minutes: [15, 24 * 60],
  incremental_sync_minutes: [1, 120],
  low_stock_units: [0, 10000],
  backup_keep: [1, 365]
};

function createSettings(db) {
  function all() {
    const out = { ...DEFAULTS };
    for (const r of db.all('SELECT key, value FROM settings')) {
      if (r.key in DEFAULTS) out[r.key] = typeof DEFAULTS[r.key] === 'number' ? Number(r.value) : r.value;
    }
    return out;
  }
  function set(values) {
    db.tx(() => {
      for (const [k, v] of Object.entries(values)) {
        if (!(k in DEFAULTS) || v === undefined) continue;
        db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
      }
    });
    return all();
  }
  return { all, set, get: (k) => all()[k], DEFAULTS, LIMITS };
}

module.exports = { createSettings, DEFAULTS, LIMITS };
