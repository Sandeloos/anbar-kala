/**
 * API client. Every request carries the X-Anbar header the server requires
 * (other sites cannot add it, so they cannot act with the session cookie).
 */
export class ApiError extends Error {
  constructor(message, status, fields, code) {
    super(message);
    this.status = status;
    this.fields = fields || {};
    this.code = code;
  }
}

const handlers = { signedOut: () => {}, mustChange: () => {} };
export function onAuthProblem(h) { Object.assign(handlers, h); }

function query(params) {
  if (!params) return '';
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') q.set(k, v); });
  const s = q.toString();
  return s ? '?' + s : '';
}

export async function api(method, path, body) {
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
    if (res.status === 401 && !path.startsWith('/auth/')) handlers.signedOut();
    if (res.status === 403 && data.code === 'must_change_password') handlers.mustChange();
    throw new ApiError(data.error || 'درخواست انجام نشد؛ دوباره تلاش کنید.', res.status, data.fields, data.code);
  }
  return data;
}

export const get = (path, params) => api('GET', path + query(params));
export const post = (path, body = {}) => api('POST', path, body);
export const put = (path, body = {}) => api('PUT', path, body);
export const del = (path) => api('DELETE', path);
