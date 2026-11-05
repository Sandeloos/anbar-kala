/**
 * API client. Every request carries the X-Anbar header the server requires
 * (other sites cannot add it, so they cannot act with the session cookie).
 *
 * Writes carry an Idempotency-Key. When the connection drops before the answer arrives
 * (mobile data, a server restart) the same request is sent again with the same key, so
 * the server answers with the first result instead of creating a second order.
 * Edits of a loaded record pass { version } and are refused (409, code "stale") if someone
 * else saved it in the meantime.
 */
export class ApiError extends Error {
  constructor(message, status, fields, code, extra = {}) {
    super(message);
    this.status = status;
    this.fields = fields || {};
    this.code = code;
    // e.g. existing_id for a duplicate order, line for a line that needs a manual price
    Object.assign(this, extra);
  }
}

const handlers = { signedOut: () => {}, mustChange: () => {} };
export function onAuthProblem(h) { Object.assign(handlers, h); }

// Requests started before signing in or out belong to the old session: their 401 must not
// sign out the person who is using the app now.
let session = 0;
export function newSession() { session++; }

function query(params) {
  if (!params) return '';
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, v); });
  const s = q.toString();
  return s ? '?' + s : '';
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(method, path, body, { version } = {}) {
  const startedIn = session;
  const opts = { method, credentials: 'same-origin', headers: { 'X-Anbar': '1', Accept: 'application/json' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const write = method !== 'GET' && method !== 'HEAD';
  if (write) opts.headers['Idempotency-Key'] = newKey();
  if (version !== undefined && version !== null) opts.headers['If-Match'] = `"${version}"`;
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch('/api' + path, opts);
      // 503 while the server restarts: wait and send the same request (same key) again
      if (res.status === 503 && attempt < 3) { await wait(800 * 2 ** attempt); continue; }
      // the first copy is still being processed (a retry overtook it)
      if (res.status === 409 && write && attempt < 5 && res.headers.get('content-type')?.includes('json')) {
        const peek = await res.clone().json().catch(() => ({}));
        if (peek.code === 'in_progress') { await wait(500); continue; }
      }
      break;
    } catch {
      if (attempt < 2) { await wait(600 * 2 ** attempt); continue; }
      throw new ApiError('اتصال به سرور برقرار نشد؛ اینترنت را بررسی کنید.', 0);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (startedIn === session) {
      if (res.status === 401 && !path.startsWith('/auth/')) handlers.signedOut();
      if (res.status === 403 && data.code === 'must_change_password') handlers.mustChange();
    }
    const { error, fields, code, ...extra } = data;
    throw new ApiError(error || 'درخواست انجام نشد؛ دوباره تلاش کنید.', res.status, fields, code, extra);
  }
  return data;
}

export const get = (path, params) => api('GET', path + query(params));
export const post = (path, body = {}) => api('POST', path, body);
export const put = (path, body = {}, opts) => api('PUT', path, body, opts);
export const del = (path) => api('DELETE', path);
