'use strict';
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

/* ------------------------------------------------------------ errors */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    this.expose = true;
    if (extra) Object.assign(this, extra);
  }
}
const badRequest = (msg, fields) => new HttpError(400, msg, fields ? { fields } : undefined);
const notFound = (msg = 'پیدا نشد.') => new HttpError(404, msg);
const forbidden = (msg = 'دسترسی این کار را ندارید.') => new HttpError(403, msg);
const conflict = (msg, fields, code) => new HttpError(409, msg, { ...(fields ? { fields } : {}), ...(code ? { code } : {}) });

/* ------------------------------------------------------------ time */
const TZ = 'Asia/Tehran';
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------ text */
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function toLatinDigits(value) {
  return String(value ?? '')
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}
/**
 * Folds the spellings people type interchangeably so search finds them:
 * Arabic ي/ك → Persian ی/ک, hamza and diacritics dropped, ZWNJ → space, digits → Latin.
 */
function searchKey(value) {
  return toLatinDigits(value)
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ةۀ]/g, 'ه').replace(/[أإآ]/g, 'ا').replace(/ؤ/g, 'و')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[‌‏‎]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
function normalisePhone(value) {
  return toLatinDigits(value).replace(/[\s\-()]/g, '').replace(/^\+98/, '0').replace(/^0098/, '0');
}

/** "https://Shop.example.ir/shop/?x" → "https://shop.example.ir" (scheme + host, no trailing slash) */
function normaliseSiteUrl(value) {
  let s = String(value || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!u.hostname.includes('.') && u.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

/* ------------------------------------------------------------ money (stored in rials) */
const CURRENCIES = { toman: 'تومان', rial: 'ریال' };
/** How many rials one unit of a site's price field is worth (Persian WooCommerce adds "thousand" units). */
const PRICE_UNITS = {
  toman: { rials: 10, label: 'تومان' },
  rial: { rials: 1, label: 'ریال' },
  thousand_toman: { rials: 10000, label: 'هزار تومان' },
  thousand_rial: { rials: 1000, label: 'هزار ریال' }
};
/** A price as a site reports it ("120000", "120000.50", "") in the given unit → whole rials or null */
function toRial(value, unit) {
  if (value === null || value === undefined) return null;
  const s = toLatinDigits(value).replace(/[,،\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * (PRICE_UNITS[unit] || PRICE_UNITS.rial).rials);
}
/** Whole rials → the number in the company's currency (tomans may have a decimal digit). */
function fromRial(rial, currency) {
  if (rial === null || rial === undefined) return null;
  return currency === 'toman' ? rial / 10 : rial;
}

/* ------------------------------------------------------------ ids and secrets */
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Readable one-time password for a new user: 10 characters without look-alikes. */
function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ------------------------------------------------------------ misc */
const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(toLatinDigits(v), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  HttpError, badRequest, notFound, forbidden, conflict,
  TZ, nowIso,
  toLatinDigits, searchKey, normalisePhone, normaliseSiteUrl,
  CURRENCIES, PRICE_UNITS, toRial, fromRial,
  token, sha256, tempPassword, hashPassword, verifyPassword, safeEqual,
  clampInt, json, sleep
};
