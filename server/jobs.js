'use strict';
/**
 * Background work, once a minute:
 *  - sync: for every active company with API keys, a full sync when it is due, otherwise an
 *    incremental one. Companies run one after another so a slow site never delays the others
 *    much and no site receives parallel bursts from us. A company whose last runs failed waits
 *    (next_sync_at: 2, 4, 8 … minutes, at most an hour) before it is tried again.
 *  - at night (Tehran): one backup, then the integrity check.
 *  - hourly: forget idempotency keys older than a day.
 * stop() waits for the tick that is running, so a shutdown never cuts a sync in half.
 */

function due(lastIso, minutes, now) {
  return !lastIso || now - new Date(lastIso).getTime() >= minutes * 60e3 - 5e3;
}

const tehranHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tehran', hour: 'numeric', hourCycle: 'h23' }).format(d));

function createJobs(ctx, log) {
  const { db, sync, settings } = ctx;
  let busy = null;
  let stopped = false;
  let lastPrune = 0;

  /** One backup a day, at night (Tehran), if the last one is older than 20 hours; then the integrity check. */
  function nightly() {
    const hour = tehranHour();
    if (hour < 2 || hour > 5) return;
    const last = ctx.backups.list()[0];
    if (last && Date.now() - new Date(last.at).getTime() < 20 * 3600e3) return;
    try {
      const b = ctx.backups.now(settings.get('backup_keep'));
      log.info({ backup: b.name }, 'daily backup');
    } catch (err) {
      log.error({ err }, 'daily backup failed');
    }
    if (ctx.integrity) {
      try {
        const r = ctx.integrity.run();
        if (!r.ok) log.error({ failed: r.results.filter((c) => !c.ok).map((c) => c.id) }, 'integrity check found problems');
      } catch (err) {
        log.error({ err }, 'integrity check failed');
      }
    }
  }

  function housekeeping() {
    if (Date.now() - lastPrune < 3600e3) return;
    lastPrune = Date.now();
    if (ctx.idempotency) ctx.idempotency.prune();
  }

  async function syncDue() {
    const s = settings.all();
    const now = Date.now();
    const companies = db.all(`SELECT id, name, last_full_sync_at, last_incremental_at, next_sync_at FROM companies
                              WHERE active = 1 AND woo_key_enc IS NOT NULL ORDER BY id`);
    for (const c of companies) {
      if (stopped) return;
      if (sync.isRunning(c.id)) continue;
      if (c.next_sync_at && new Date(c.next_sync_at).getTime() > now) continue; // backing off after failures
      try {
        if (due(c.last_full_sync_at, s.full_sync_minutes, now)) await sync.fullSync(c.id);
        else if (due(c.last_incremental_at, s.incremental_sync_minutes, now)) await sync.incrementalSync(c.id);
      } catch (err) {
        // Already recorded on the company and in sync_runs; keep going with the next one
        log.warn({ company: c.id, err: err.message }, 'sync failed');
      }
    }
  }

  async function tick() {
    if (busy || stopped) return busy;
    busy = (async () => {
      try {
        nightly();
        housekeeping();
        await syncDue();
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  let timer = null;
  let first = null;
  return {
    tick,
    get busy() { return Boolean(busy); },
    start() {
      if (timer) return;
      stopped = false;
      first = setTimeout(() => tick().catch((err) => log.error({ err }, 'job tick failed')), 3000);
      first.unref();
      timer = setInterval(() => tick().catch((err) => log.error({ err }, 'job tick failed')), 60e3);
      timer.unref();
    },
    /** Stops scheduling; resolves when the running tick (if any) has finished. */
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (first) clearTimeout(first);
      timer = first = null;
      if (busy) await busy.catch(() => {});
    }
  };
}

module.exports = { createJobs, due };
