/**
 * Live updates over server-sent events. Views subscribe to event types
 * (products, sync, company, activity); the browser reconnects by itself.
 */
const listeners = new Map();
let source = null;
let onSignedOut = () => {};

function setDot(state) {
  const dot = document.getElementById('live-dot');
  if (!dot) return;
  dot.className = 'live-dot ' + state;
  dot.title = state === 'on' ? 'به‌روزرسانی زنده وصل است' : 'به‌روزرسانی زنده قطع است؛ دوباره وصل می‌شود…';
}

export function connect({ signedOut } = {}) {
  if (signedOut) onSignedOut = signedOut;
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => setDot('on');
  source.onerror = () => setDot('off');
  for (const type of ['products', 'sync', 'company', 'activity']) {
    source.addEventListener(type, (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch { /* ignore */ }
      for (const fn of listeners.get(type) || []) {
        try { fn(data); } catch (err) { console.error(err); }
      }
    });
  }
  source.addEventListener('signedout', () => { disconnect(); onSignedOut(); });
}

export function disconnect() {
  if (source) source.close();
  source = null;
  setDot('');
}

/** subscribe('products', fn) → unsubscribe function */
export function subscribe(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}
