'use strict';
/**
 * Settings from environment variables. Everything has a safe default for
 * development; production refuses to start without APP_SECRET (it encrypts
 * the WooCommerce keys stored in the database).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');

function readSecret(dataDir) {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (process.env.NODE_ENV === 'production') {
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

function loadConfig(overrides = {}) {
  const env = process.env;
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(root, 'data');
  const config = {
    root,
    production: env.NODE_ENV === 'production',
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8080),
    dataDir,
    // Public address of this server; shown to admins as the webhook URL for the WordPress plugin
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    // Background price/stock sync (off in tests, which call the sync directly)
    jobs: env.JOBS !== '0',
    relaxLimits: env.RELAX_LIMITS === '1',
    // HTTPS-only cookie; COOKIE_SECURE=0 only for a first test of a server without HTTPS
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE !== '0' : env.NODE_ENV === 'production',
    // Network timeout for each request to a WooCommerce site
    wooTimeoutMs: Number(env.WOO_TIMEOUT_MS || 20000),
    ...overrides
  };
  config.secret = overrides.secret || readSecret(config.dataDir);
  return config;
}

module.exports = { loadConfig, root };
