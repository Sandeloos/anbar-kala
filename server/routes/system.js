'use strict';
/** System health, backups and the integrity check (manager only). */
const fs = require('fs');
const path = require('path');
const { notFound } = require('../lib/util');

const pkg = require('../../package.json');
const started = new Date().toISOString();

module.exports = async function systemRoutes(app) {
  const { db, backups, config, settings, integrity } = app.ctx;
  const manager = { config: { manager: true } };

  app.get('/system', manager, async () => {
    const dbFile = path.join(config.dataDir, 'anbar.db');
    const size = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
    const counts = db.get(`SELECT (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM order_lines) AS lines, (SELECT COUNT(*) FROM stock_moves) AS moves,
      (SELECT COUNT(*) FROM price_history) AS history, (SELECT COUNT(*) FROM audit_log) AS audit`);
    return {
      version: pkg.version, node: process.version, started_at: started, production: config.production, public_url: config.publicUrl || null,
      db_size: size, counts, backups: backups.list(), backup_keep: settings.get('backup_keep'),
      migrations: db.get('PRAGMA user_version').user_version,
      integrity: integrity.last()
    };
  });

  /** The last integrity report (it runs every night after the backup). */
  app.get('/system/integrity', manager, async () => ({ report: integrity.last() }));

  /** Runs the integrity check now. */
  app.post('/system/integrity', manager, async (req) => {
    const report = integrity.run();
    const failed = report.results.filter((c) => !c.ok);
    app.ctx.audit(req, {
      action: 'check', entity: 'settings', id: null,
      summary: failed.length ? `بررسی سلامت داده‌ها: ${failed.length} مورد مشکل (${failed.map((c) => c.label).join('، ')})` : 'بررسی سلامت داده‌ها: همه‌چیز درست است'
    });
    return { report };
  });

  app.post('/system/backup', manager, async (req) => {
    const b = backups.now(settings.get('backup_keep'));
    app.ctx.audit(req, { action: 'backup', entity: 'settings', id: null, summary: `نسخه‌ی پشتیبان دستی: ${b.name}` });
    return { backup: b, backups: backups.list() };
  });

  /** Download a backup. It holds everything (the API keys stay encrypted with APP_SECRET). */
  app.get('/system/backups/:name', manager, async (req, reply) => {
    const file = backups.file(req.params.name);
    if (!file) throw notFound('نسخه‌ی پشتیبان پیدا نشد.');
    app.ctx.audit(req, { action: 'download', entity: 'settings', id: null, summary: `دانلود نسخه‌ی پشتیبان ${req.params.name}` });
    return reply.type('application/vnd.sqlite3').header('Content-Disposition', `attachment; filename="${req.params.name}"`).send(fs.createReadStream(file));
  });
};
