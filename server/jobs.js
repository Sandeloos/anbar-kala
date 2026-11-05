'use strict';
/**
 * Background sync. Once a minute: for every active company with API keys,
 * run a full sync when it is due, otherwise an incremental one when that is due.
 * Companies run one after another so a slow site never delays the others much
 * and no site receives parallel bursts from us.
 */

function due(lastIso, minutes, now) {
  return !lastIso || now - new Date(lastIso).getTime() >= minutes * 60e3 - 5e3;
}

function createJobs(ctx, log) {
  const { db, sync, settings } = ctx;
  let busy = false;

  /** One backup a day, at night (Tehran), if the last one is older than 20 hours. */
  function dailyBackup() {
    const hour = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tehran', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    if (hour < 2 || hour > 5) return;
    const last = ctx.backups.list()[0];
    if (last && Date.now() - new Date(last.at).getTime() < 20 * 3600e3) return;
    try {
      const b = ctx.backups.now(settings.get('backup_keep'));
      log.info({ backup: b.name }, 'daily backup');
    } catch (err) {
      log.error({ err }, 'daily backup failed');
    }
  }

  async function tick() {
    dailyBackup();
    if (busy) return;
    busy = true;
    try {
      const s = settings.all();
      const now = Date.now();
      const companies = db.all(`SELECT id, name, last_full_sync_at, last_incremental_at FROM companies
                                WHERE active = 1 AND woo_key_enc IS NOT NULL ORDER BY id`);
      for (const c of companies) {
        if (sync.isRunning(c.id)) continue;
        try {
          if (due(c.last_full_sync_at, s.full_sync_minutes, now)) await sync.fullSync(c.id);
          else if (due(c.last_incremental_at, s.incremental_sync_minutes, now)) await sync.incrementalSync(c.id);
        } catch (err) {
          // Already recorded on the company and in sync_runs; keep going with the next one
          log.warn({ company: c.id, err: err.message }, 'sync failed');
        }
      }
    } finally {
      busy = false;
    }
  }

  let timer = null;
  return {
    tick,
    start() {
      if (timer) return;
      setTimeout(() => tick().catch(() => {}), 3000).unref();
      timer = setInterval(() => tick().catch(() => {}), 60e3);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}

module.exports = { createJobs, due };
