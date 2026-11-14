'use strict';
/**
 * Builds the Fastify application: security headers, the single-page app,
 * static assets, the JSON API (/api/*), live events (/api/events), the
 * webhook the WordPress plugin calls (/hooks/woo/:company) and the operations
 * endpoints (/health liveness, /ready readiness, /metrics Prometheus).
 * server/index.js starts it and calls app.shutdown() on SIGTERM; tests build
 * their own instance on a temp folder.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Fastify = require('fastify');
const { ZodError } = require('zod');
const { openDatabase } = require('./db');
const { createAuth, createLimiter } = require('./lib/auth');
const { createAudit } = require('./lib/audit');
const { createEvents } = require('./lib/events');
const { createSecrets } = require('./lib/secrets');
const { createSettings } = require('./lib/settings');
const { createSync } = require('./lib/sync');
const { createStock } = require('./lib/stock');
const { createOrders } = require('./lib/orders');
const { createReturns } = require('./lib/returns');
const { createStatements } = require('./lib/statements');
const { createTasks } = require('./lib/tasks');
const { createDigikala } = require('./lib/digikala');
const { createBackups } = require('./lib/backup');
const { createIntegrity } = require('./lib/integrity');
const { createMetrics } = require('./lib/metrics');
const { createIdempotency } = require('./lib/idempotency');
const { createConcurrency } = require('./lib/concurrency');
const { createJobs } = require('./jobs');
const { HttpError, safeEqual } = require('./lib/util');
const pkg = require('../package.json');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function zodFields(err) {
  const fields = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

/** Secrets never reach the log, whatever gets logged. */
const REDACT = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-anbar-signature"]', 'res.headers["set-cookie"]',
  'body.password', 'body.new_password', 'body.current_password', 'body.key', 'body.secret'
];
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;

async function buildApp(config, { logger, fetchImpl } = {}) {
  const app = Fastify({
    logger: logger === undefined ? { level: config.logLevel || (config.production ? 'info' : 'warn'), redact: { paths: REDACT, censor: '[hidden]' } } : logger,
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    // Keep the id a proxy (Caddy) or the browser sent, so one id follows a request through every log
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : crypto.randomUUID();
    },
    logController: new Fastify.LogController({ requestIdLogLabel: 'request_id' }),
    return503OnClosing: true
  });

  const db = openDatabase(path.join(config.dataDir, 'anbar.db'));
  const metrics = createMetrics();
  const events = createEvents({ db });
  const secrets = createSecrets(config.secret);
  const settings = createSettings(db);
  const audit = createAudit(db, events, { strict: !config.production, onLoose: (err) => app.log.error({ err }, 'audit outside a transaction') });
  const sync = createSync({ db, config, secrets, events, log: app.log, fetchImpl, metrics });
  const stock = createStock({ db, audit, events });
  const orders = createOrders({ db, sync, events, audit, stock });
  const returns = createReturns({ db, orders, stock, events, audit });
  const statements = createStatements({ db, audit, events });
  const digikala = createDigikala({ db, secrets, audit, events, log: app.log, fetchImpl, retryBaseMs: config.production ? 1000 : 20 });
  const tasks = createTasks({ db, events, audit, settings, autoPriced: digikala.handles });
  sync.onChanges(tasks.onChanges);
  sync.onChanges(digikala.onChanges);
  const ctx = {
    config, db, events, secrets, settings, audit, sync, stock, orders, returns, statements, tasks, digikala, metrics,
    backups: createBackups({ db, config }),
    auth: createAuth({ db, config }),
    limit: createLimiter({ factor: config.relaxLimits ? 100 : 1 }),
    integrity: createIntegrity({ db }),
    idempotency: createIdempotency({ db }),
    concurrency: createConcurrency({ db }),
    shuttingDown: false
  };
  ctx.jobs = createJobs(ctx, app.log);
  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);
  app.decorateRequest('idempotency', null);
  app.decorateRequest('startedAt', 0n);
  app.addHook('onClose', async () => { await ctx.jobs.stop(); events.closeAll(); db.close(); });

  /**
   * Graceful stop (SIGTERM from Docker): refuse new work (/ready → 503), let the running tick and
   * syncs finish (up to shutdownTimeoutMs), end live streams (browsers reconnect to the new
   * process), wait for requests in flight, then checkpoint and close the database.
   */
  app.decorate('shutdown', async () => {
    if (ctx.shuttingDown) return;
    ctx.shuttingDown = true;
    const limitMs = config.shutdownTimeoutMs || 25000;
    const started = Date.now();
    await Promise.race([ctx.jobs.stop(), new Promise((r) => setTimeout(r, limitMs).unref())]);
    const idle = await sync.whenIdle(Math.max(1000, limitMs - (Date.now() - started)));
    if (!idle) app.log.warn('shutdown: a sync was still running; it will resume from the last saved point');
    events.closeAll();
    await app.close();
  });

  await app.register(require('@fastify/cookie'));

  /* ------------------------------------------------------------ request id + metrics */
  app.addHook('onRequest', async (req, reply) => {
    req.startedAt = process.hrtime.bigint();
    reply.header('X-Request-Id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url || 'unmatched';
    if (route === '/metrics' || route === '/api/events') return;
    const seconds = Number(process.hrtime.bigint() - req.startedAt) / 1e9;
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    metrics.inc('anbar_http_requests_total', labels);
    metrics.observe('anbar_http_request_duration_seconds', { method: req.method, route }, seconds);
    if (seconds > 2) req.log.warn({ route, seconds: Math.round(seconds * 1000) / 1000 }, 'slow request');
  });
  const dbFile = path.join(config.dataDir, 'anbar.db');
  metrics.gauge('anbar_up', 'The server is running', () => 1);
  metrics.gauge('anbar_info', 'Version of the running server', () => [{ labels: { version: pkg.version, node: process.version }, value: 1 }]);
  metrics.gauge('anbar_process_resident_memory_bytes', 'Resident memory', () => process.memoryUsage().rss);
  metrics.gauge('anbar_process_uptime_seconds', 'Seconds since start', () => Math.round(process.uptime()));
  metrics.gauge('anbar_sse_clients', 'Open live-update streams', () => events.clients);
  metrics.gauge('anbar_db_size_bytes', 'Size of the database file (without WAL)', () => (fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0));
  metrics.gauge('anbar_tasks_open', 'Open inbox tasks', () => db.get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").n);
  metrics.gauge('anbar_sync_companies_failing', 'Active companies whose last sync failed', () =>
    db.get("SELECT COUNT(*) AS n FROM companies WHERE active = 1 AND sync_state = 'error'").n);
  metrics.gauge('anbar_last_backup_age_seconds', 'Seconds since the newest backup (-1 = none)', () => {
    const b = ctx.backups.list()[0];
    return b ? Math.round((Date.now() - new Date(b.at).getTime()) / 1000) : -1;
  });
  metrics.gauge('anbar_integrity_ok', 'Last integrity check passed (1), failed (0), never ran (-1)', () => {
    const r = ctx.integrity.last();
    return r ? (r.ok ? 1 : 0) : -1;
  });

  /* ------------------------------------------------------------ headers */
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.production) reply.header('Strict-Transport-Security', 'max-age=31536000');
    const type = String(reply.getHeader('content-type') || '');
    if (type.startsWith('text/html')) {
      reply.header('Content-Security-Policy', CSP);
      reply.header('Cache-Control', 'no-cache');
    }
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (req.url.startsWith('/assets/')) reply.header('Cache-Control', 'no-cache');
    return payload;
  });

  /* ------------------------------------------------------------ errors */
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const fields = zodFields(err);
      return reply.code(400).send({ error: Object.values(fields)[0] || 'اطلاعات واردشده معتبر نیست.', fields });
    }
    if (err.statusCode === 429 && err.retryAfter) reply.header('Retry-After', err.retryAfter);
    if (err.name === 'WooError') return reply.code(502).send({ error: err.message, code: err.code });
    if (err instanceof HttpError || err.expose || (err.statusCode && err.statusCode < 500)) {
      const status = err.statusCode || 400;
      const message = err instanceof HttpError || err.expose ? err.message : 'درخواست معتبر نیست.';
      const extra = {};
      for (const k of ['fields', 'code', 'line', 'existing_id', 'current_version']) if (err[k] !== undefined && (k !== 'code' || typeof err[k] === 'string')) extra[k] = err[k];
      return reply.code(status).send({ error: message, ...extra });
    }
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'خطای داخلی سرور؛ دوباره تلاش کنید.' });
  });

  /* ------------------------------------------------------------ static + app shell */
  const publicDir = path.join(config.root, 'public');
  await app.register(require('@fastify/static'), {
    // Scripts are not versioned in their names, so the browser asks every time (a cheap 304 with the
    // ETag) instead of keeping a copy: after a deploy everyone gets the new code at once, never a mix.
    root: path.join(publicDir, 'assets'), prefix: '/assets/', maxAge: 0, etag: true
  });
  const shell = () => fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const cachedShell = config.production ? shell() : null;
  app.get('/', (req, reply) => reply.type('text/html; charset=utf-8').send(cachedShell || shell()));
  app.get('/favicon.ico', (req, reply) => reply.type('image/svg+xml').send(fs.readFileSync(path.join(publicDir, 'assets', 'img', 'icon.svg'))));
  app.get('/robots.txt', (req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  // Liveness: the process answers. Readiness: it can serve (database reachable, not stopping).
  app.get('/health', () => ({ ok: true }));
  app.get('/ready', (req, reply) => {
    if (ctx.shuttingDown) return reply.code(503).send({ ready: false, reason: 'shutting down' });
    try {
      db.get('SELECT 1 AS ok');
    } catch (err) {
      req.log.error({ err }, 'readiness: database');
      return reply.code(503).send({ ready: false, reason: 'database' });
    }
    return { ready: true, version: pkg.version };
  });
  // Prometheus scrape; off unless METRICS_TOKEN is set, and then only with that bearer token
  app.get('/metrics', (req, reply) => {
    if (!config.metricsToken) return reply.code(404).send({ error: 'not found' });
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!given || !safeEqual(given, config.metricsToken)) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
  });

  /* ------------------------------------------------------------ API */
  await app.register(require('./routes/hooks'));
  await app.register(async (api) => {
    // Everything under /api needs a signed-in user, except signing in itself
    api.addHook('onRequest', async (req) => {
      const open = req.routeOptions.config && req.routeOptions.config.public;
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-anbar'] !== '1') {
        throw new HttpError(403, 'درخواست از مبدأ نامعتبر.');
      }
      if (open) return;
      req.user = ctx.auth.userFrom(req);
      if (!req.user) throw new HttpError(401, 'لطفاً دوباره وارد شوید.');
      // A user with a one-time password may only change it (and read who they are)
      const allowed = ['/api/auth/me', '/api/auth/logout', '/api/me/password'];
      if (req.user.mustChangePassword && !allowed.includes(req.routeOptions.url)) {
        throw new HttpError(403, 'اول رمز عبور موقت را عوض کنید.', { code: 'must_change_password' });
      }
      const managerOnly = req.routeOptions.config && req.routeOptions.config.manager;
      if (managerOnly && req.user.role !== 'manager') throw new HttpError(403, 'این بخش فقط برای مدیر است.');
    });
    // Retried writes (same Idempotency-Key) get the first answer instead of running twice
    api.addHook('preHandler', ctx.idempotency.before);
    api.addHook('onSend', ctx.idempotency.after);
    for (const r of ['auth', 'me', 'users', 'companies', 'warehouses', 'products', 'listings', 'orders', 'receiving', 'stock', 'imports', 'returns', 'statements', 'tasks', 'digikala', 'system', 'activity', 'dashboard', 'settings', 'events']) {
      await api.register(require(`./routes/${r}`));
    }
  }, { prefix: '/api' });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'پیدا نشد.' });
    return reply.code(404).type('text/html; charset=utf-8').send(cachedShell || shell());
  });

  if (config.jobs) ctx.jobs.start();
  return app;
}

module.exports = { buildApp };
