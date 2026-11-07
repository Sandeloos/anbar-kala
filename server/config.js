'use strict';
/**
 * Settings from environment variables, validated at start-up: a typo in .env (PORT=80800,
 * WOO_TIMEOUT_MS=fast, a short APP_SECRET) stops the server with a message naming the variable,
 * instead of running with a surprise. Everything has a safe default for development; production
 * refuses to start without APP_SECRET (it encrypts the WooCommerce keys stored in the database).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');

const root = path.join(__dirname, '..');

const flag = (fallback) => z.enum(['0', '1', 'true', 'false']).optional().transform((v) => (v === undefined ? fallback : v === '1' || v === 'true'));
const int = (fallback, min, max) => z.coerce.number().int().min(min).max(max).optional().default(fallback);

const ENV = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).optional(),
  HOST: z.string().min(1).optional().default('127.0.0.1'),
  PORT: int(8080, 1, 65535),
  DATA_DIR: z.string().min(1).optional(),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional().or(z.literal('')),
  TRUST_PROXY: flag(false),
  JOBS: flag(true),
  RELAX_LIMITS: flag(false),
  COOKIE_SECURE: flag(undefined),
  WOO_TIMEOUT_MS: int(20000, 1000, 120000),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters (openssl rand -base64 32)').optional(),
  METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN must be at least 16 characters').optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  SHUTDOWN_TIMEOUT_MS: int(25000, 1000, 120000)
});

function parseEnv(env) {
  // Empty variables in .env mean "not set"
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const r = ENV.safeParse(clean);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return r.data;
}

function readSecret(e, dataDir) {
  if (e.APP_SECRET) return e.APP_SECRET;
  if (e.NODE_ENV === 'production') {
    throw new Error('APP_SECRET is required in production (it encrypts the WooCommerce keys).');
  }
  // Development: keep a random secret next to the database so restarts can still decrypt
  const file = path.join(dataDir, '.app-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  fs.mkdirSync(dataDir, { recursive: true });
  const s = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function loadConfig(overrides = {}, env = process.env) {
  const e = parseEnv(env);
  const production = e.NODE_ENV === 'production';
  const dataDir = overrides.dataDir || e.DATA_DIR || path.join(root, 'data');
  const config = {
    root,
    production,
    host: e.HOST,
    port: e.PORT,
    dataDir,
    // Public address of this server; shown to admins as the webhook URL for the WordPress plugin
    publicUrl: (e.PUBLIC_URL || '').replace(/\/+$/, ''),
    trustProxy: e.TRUST_PROXY,
    // Background price/stock sync (off in tests, which call the sync directly)
    jobs: e.JOBS,
    relaxLimits: e.RELAX_LIMITS,
    // HTTPS-only cookie; COOKIE_SECURE=0 only for a first test of a server without HTTPS
    cookieSecure: e.COOKIE_SECURE === undefined ? production : e.COOKIE_SECURE,
    // Network timeout for each request to a WooCommerce site
    wooTimeoutMs: e.WOO_TIMEOUT_MS,
    // GET /metrics answers only with "Authorization: Bearer <token>"; unset = /metrics is off
    metricsToken: e.METRICS_TOKEN || null,
    logLevel: e.LOG_LEVEL || (production ? 'info' : 'warn'),
    // How long a shutdown waits for running syncs and requests
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    ...overrides
  };
  config.secret = overrides.secret || readSecret(e, config.dataDir);
  return config;
}

module.exports = { loadConfig, parseEnv, root };
