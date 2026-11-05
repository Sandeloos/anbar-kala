/**
 * API client. Every request carries the X-Anbar header the server requires
 * (other sites cannot add it, so they cannot act with the session cookie).
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

export async function api(method, path, body) {
  const startedIn = session;
  const opts = { method, credentials: 'same-origin', headers: { 'X-Anbar': '1', Accept: 'application/json' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    throw new ApiError('اتصال به سرور برقرار نشد؛ اینترنت را بررسی کنید.', 0);
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
export const put = (path, body = {}) => api('PUT', path, body);
export const del = (path) => api('DELETE', path);
