'use strict';
/**
 * Client for the Digikala seller Open API (https://seller.digikala.com/open-api/v1, Swagger
 * "DK Marketplace - Open API Service"). Only what automatic pricing needs:
 *
 *   auth/token          { authorization_code }               → access + refresh token
 *   auth/refresh-token  { access_token, refresh_token }      → new pair (always keep the new refresh token)
 *   GET   variants?page&size                                  → { pager, items } (the seller's variants)
 *   GET   variants/{id}                                       → price_sale, price_list (reference), stock, …
 *   PATCH variants/selling-price { variant_id, selling_price, credit_increase_percentage }
 *   PUT   variants/{id}/activation { activation }
 *   PATCH variants/{id}/seller-stock { seller_stock }
 *   GET   tickets/sub-categories/{id}/fields, POST tickets/requests   (reference-price request)
 *
 * The self-token page gives an authorization code encrypted with the seller's RSA public key
 * (base64, PKCS#1 v1.5); decryptChallenge() opens it with the private key.
 * Errors are DigikalaError with `status` and Digikala's `errors` object (e.g. errors.selling_price).
 */
const crypto = require('crypto');

class DigikalaError extends Error {
  constructor(message, { status = 0, errors = null, code = 'http', retryAfter = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DigikalaError';
    this.status = status;
    this.errors = errors;
    this.code = code;
    this.retryAfter = retryAfter;
    // A bad key or verification code is the person's input: shown as a 400 with its message
    if (code === 'key' || code === 'challenge') { this.statusCode = 400; this.expose = true; }
  }
  /** Digikala refused the price itself (as opposed to a missing photo, a wrong id, …). */
  get priceRefused() {
    return this.status === 400 && !!this.errors && Array.isArray(this.errors.selling_price) && this.errors.selling_price.length > 0;
  }
  /** Worth another try later: rate limit, server trouble, network. */
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.code === 'network' || this.code === 'timeout';
  }
}

/** Base64 code from the self-token page → the plain authorization code. */
function decryptChallenge(privateKeyPem, challenge) {
  const buf = Buffer.from(String(challenge).replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw new DigikalaError('کد اعتبارسنجی خالی است.', { code: 'challenge' });
  try {
    return crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, buf).toString('utf8').trim();
  } catch (err) {
    throw new DigikalaError('کد اعتبارسنجی با این کلید خصوصی باز نشد؛ کلید عمومیِ ثبت‌شده در دیجی‌کالا باید جفتِ همین کلید باشد، یا کد منقضی شده.', { code: 'challenge', cause: err });
  }
}

/** Checks a PEM private key: RSA, at least 2048 bits (Digikala asks for 4096). Returns its size. */
function checkPrivateKey(pem) {
  let key;
  try { key = crypto.createPrivateKey(pem); } catch (err) {
    throw new DigikalaError('این متن کلید خصوصی معتبر نیست؛ محتوای کامل فایل digikala-private.pem را بگذارید.', { code: 'key', cause: err });
  }
  if (key.asymmetricKeyType !== 'rsa') throw new DigikalaError('کلید باید از نوع RSA باشد.', { code: 'key' });
  const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
  if (bits && bits < 2048) throw new DigikalaError('کلید خیلی کوتاه است؛ دیجی‌کالا کلید ۴۰۹۶ بیتی می‌خواهد.', { code: 'key' });
  return bits;
}

/**
 * tokens: { get() → { access, refresh, expiresAt } | null, set({ access, refresh, expiresAt }) }
 * The client refreshes an expired (or refused) access token once and repeats the call.
 */
const DEFAULT_USER_AGENT = 'Anbar';

/**
 * Every request carries a User-Agent: Digikala refuses authenticated calls whose User-Agent it does
 * not accept ("Invalid User-Agent!"), so the value is a setting (dk_connection.user_agent).
 */
function createDigikalaClient({ baseUrl, tokens, fetchImpl, userAgent, timeoutMs = 20000, retries = 2, retryBaseMs = 1000 }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const root = String(baseUrl || 'https://seller.digikala.com').replace(/\/+$/, '') + '/open-api/v1';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function once(method, path, body, { auth = true } = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': userAgent || DEFAULT_USER_AGENT };
    if (auth) {
      const t = tokens.get();
      if (!t || !t.access) throw new DigikalaError('اتصال دیجی‌کالا برقرار نیست؛ از «تنظیمات ← دیجی‌کالا» دوباره وصل شوید.', { code: 'no_token' });
      headers.authorization = `Bearer ${t.access}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(root + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      throw new DigikalaError(err.name === 'AbortError' ? 'دیجی‌کالا جواب نداد.' : 'اتصال به دیجی‌کالا برقرار نشد.', { code: err.name === 'AbortError' ? 'timeout' : 'network', cause: err });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.ok && (!data || data.status !== 'error')) return data && data.data !== undefined ? data.data : data;
    const message = (data && (data.message || (data.errors && firstError(data.errors)))) || `دیجی‌کالا خطای ${res.status} برگرداند.`;
    throw new DigikalaError(message, {
      status: res.status, errors: data && data.errors ? data.errors : null,
      retryAfter: Number(res.headers.get('retry-after')) || (data && Number(data.reset_time)) || null
    });
  }

  async function refresh() {
    const t = tokens.get();
    if (!t || !t.refresh) throw new DigikalaError('توکن دیجی‌کالا منقضی شده و توکن تازه‌سازی نیست؛ دوباره وصل شوید.', { code: 'no_token', status: 401 });
    const d = await once('POST', '/auth/refresh-token', { access_token: t.access, refresh_token: t.refresh }, { auth: false });
    const next = tokenPair(d);
    tokens.set(next);
    return next;
  }

  /** One call with: token refresh on 401 (once), back-off on 429/5xx/network (honours reset time). */
  async function call(method, path, body) {
    const t = tokens.get();
    if (t && t.expiresAt && new Date(t.expiresAt).getTime() < Date.now() + 60e3) await refresh();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(method, path, body);
      } catch (err) {
        if (err.status === 401 && !refreshed) { refreshed = true; await refresh(); attempt--; continue; }
        if (!err.retryable || attempt >= retries) throw err;
        await sleep(err.retryAfter ? Math.min(60e3, err.retryAfter * 1000) : retryBaseMs * 2 ** attempt);
      }
    }
  }

  return {
    /** The decrypted code from the self-token page → stores and returns the token pair. */
    async token(authorizationCode) {
      const d = await once('POST', '/auth/token', { authorization_code: authorizationCode }, { auth: false });
      const pair = tokenPair(d);
      tokens.set(pair);
      return pair;
    },
    refresh,
    /** One page of the seller's variants: { pager: { page, total_pages, total_rows }, items }. */
    variants: ({ page = 1, size = 50 } = {}) => call('GET', `/variants?page=${Number(page)}&size=${Number(size)}&sort=id&order=asc`),
    variant: (id) => call('GET', `/variants/${Number(id)}`),
    setPrice: (id, price, creditIncrease) => call('PATCH', '/variants/selling-price', { variant_id: Number(id), selling_price: price, credit_increase_percentage: creditIncrease }),
    setActive: (id, active) => call('PUT', `/variants/${Number(id)}/activation`, { activation: !!active }),
    setStock: (id, stock) => call('PATCH', `/variants/${Number(id)}/seller-stock`, { seller_stock: stock }),
    ticketFields: (subCategoryId) => call('GET', `/tickets/sub-categories/${Number(subCategoryId)}/fields`),
    createTicket: (subCategoryId, form) => call('POST', '/tickets/requests', { sub_category_id: Number(subCategoryId), form })
  };
}

function firstError(errors) {
  for (const v of Object.values(errors || {})) if (Array.isArray(v) && v.length) return String(v[0]);
  return null;
}
function tokenPair(d) {
  if (!d || !d.access_token) throw new DigikalaError('دیجی‌کالا توکن برنگرداند.', { code: 'token' });
  const exp = d.access_token_expires_at && (d.access_token_expires_at.date || d.access_token_expires_at);
  const expiresAt = exp ? new Date(String(exp).replace(' ', 'T')).toISOString() : null;
  return { access: d.access_token, refresh: d.refresh_token || null, expiresAt: Number.isNaN(Date.parse(expiresAt)) ? null : expiresAt };
}

module.exports = { createDigikalaClient, decryptChallenge, checkPrivateKey, DigikalaError, DEFAULT_USER_AGENT };
