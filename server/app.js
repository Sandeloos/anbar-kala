'use strict';
/**
 * Builds the Fastify application: security headers, the single-page app,
 * static assets, the JSON API (/api/*), live events (/api/events) and the
 * webhook the WordPress plugin calls (/hooks/woo/:company).
 * server/index.js starts it; tests build their own instance on a temp folder.
 */
const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const { ZodError } = require('zod');
const { openDatabase } = require('./db');
const { createAuth, createLimiter } = require('./lib/auth');
const { createAudit } = require('./lib/audit');
const { createEvents } = require('./lib/events');
const { createSecrets } = require('./lib/secrets');
const { createSettings } = require('./lib/settings');
const { createSync } = require('./lib/sync');
const { createJobs } = require('./jobs');
const { HttpError } = require('./lib/util');

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

async function buildApp(config, { logger, fetchImpl } = {}) {
  const app = Fastify({
    logger: logger === undefined ? { level: config.production ? 'info' : 'warn' } : logger,
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024
  });

  const db = openDatabase(path.join(config.dataDir, 'anbar.db'));
  const events = createEvents();
  const secrets = createSecrets(config.secret);
  const settings = createSettings(db);
  const audit = createAudit(db, events);
  const sync = createSync({ db, config, secrets, events, log: app.log, fetchImpl });
  const ctx = {
    config, db, events, secrets, settings, audit, sync,
    auth: createAuth({ db, config }),
    limit: createLimiter({ factor: config.relaxLimits ? 100 : 1 })
  };
  ctx.jobs = createJobs(ctx, app.log);
  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);
  app.addHook('onClose', async () => { ctx.jobs.stop(); db.close(); });

  await app.register(require('@fastify/cookie'));

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
      return reply.code(status).send(Object.assign({ error: message }, err.fields ? { fields: err.fields } : {}));
    }
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'خطای داخلی سرور؛ دوباره تلاش کنید.' });
  });

  /* ------------------------------------------------------------ static + app shell */
  const publicDir = path.join(config.root, 'public');
  await app.register(require('@fastify/static'), {
    root: path.join(publicDir, 'assets'), prefix: '/assets/', maxAge: config.production ? '1h' : 0, etag: true
  });
  const shell = () => fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const cachedShell = config.production ? shell() : null;
  app.get('/', (req, reply) => reply.type('text/html; charset=utf-8').send(cachedShell || shell()));
  app.get('/favicon.ico', (req, reply) => reply.type('image/svg+xml').send(fs.readFileSync(path.join(publicDir, 'assets', 'img', 'icon.svg'))));
  app.get('/robots.txt', (req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/health', () => ({ ok: true }));

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
    for (const r of ['auth', 'me', 'users', 'companies', 'warehouses', 'products', 'activity', 'dashboard', 'settings', 'events']) {
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
