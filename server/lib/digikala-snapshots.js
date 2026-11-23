'use strict';

function createDigikalaSnapshots(db, account) {
  function get(scope, kind, key) {
    const row = db.get('SELECT checked_at, payload FROM dk_read_snapshots WHERE account=? AND kind=? AND lookup_key=?', scope, kind, key);
    return row && { checked_at: row.checked_at, data: JSON.parse(row.payload) };
  }
  function put(scope, kind, key, data) {
    const now = new Date().toISOString();
    db.tx(() => {
      db.run(`INSERT INTO dk_read_snapshots (account,kind,lookup_key,checked_at,payload) VALUES (?,?,?,?,?)
        ON CONFLICT (account,kind,lookup_key) DO UPDATE SET checked_at=excluded.checked_at,payload=excluded.payload`, scope, kind, key, now, JSON.stringify(data));
      db.run("DELETE FROM dk_read_snapshots WHERE kind <> 'catalog' AND checked_at < ?", new Date(Date.now() - 30 * 864e5).toISOString());
    });
    return { checked_at: now, data };
  }
  return { account, get, put };
}

module.exports = { createDigikalaSnapshots };
