/**
 * The app shell: sign-in, first-password screen, sidebar, hash router
 * (#/section/param?query), live connection and the quick-search palette.
 * Each section is a module in views/ exporting render(view, ctx, params)
 * that may return a cleanup function.
 */
import { get, post, onAuthProblem, newSession } from './api.js';
import { $, $$, esc, icon, fa, toast, busy, fieldErrors, showError, formValues, confirm, ROLES, initials, colorFor, debounce, money, latin } from './ui.js';
import { connect, disconnect, subscribe } from './live.js';

const SECTIONS = [
  { group: 'کار روزانه', path: 'dashboard', label: 'داشبورد', icon: 'grid', load: () => import('./views/dashboard.js') },
  { group: 'کار روزانه', path: 'orders', label: 'سفارش‌ها', icon: 'cart', load: () => import('./views/orders.js') },
  { group: 'کار روزانه', path: 'receiving', label: 'دریافت روزانه', icon: 'truck', count: 'receiving_due', countTitle: 'ردیف منتظر دریافت', load: () => import('./views/receiving.js') },
  { group: 'کار روزانه', path: 'stock', label: 'موجودی انبار', icon: 'layers', load: () => import('./views/stock.js') },
  { group: 'کار روزانه', path: 'changes', label: 'تغییرات قیمت', icon: 'trend', count: 'price_changes_24h', countTitle: 'تغییر در ۲۴ ساعت', load: () => import('./views/changes.js') },
  { group: 'تعریف‌ها', path: 'products', label: 'کالاها', icon: 'box', count: 'needs_setup', countTitle: 'کالای تنظیم‌نشده', load: () => import('./views/products.js') },
  { group: 'تعریف‌ها', path: 'listings', label: 'آگهی‌ها', icon: 'link', load: () => import('./views/listings.js') },
  { group: 'تعریف‌ها', path: 'companies', label: 'شرکت‌ها', icon: 'building', count: 'sync_errors', danger: true, countTitle: 'خطای اتصال', load: () => import('./views/companies.js') },
  { group: 'تعریف‌ها', path: 'warehouses', label: 'انبارها', icon: 'warehouse', load: () => import('./views/warehouses.js') },
  { group: 'مدیریت', path: 'users', label: 'کاربران', icon: 'users', manager: true, load: () => import('./views/users.js') },
  { group: 'مدیریت', path: 'activity', label: 'گزارش فعالیت', icon: 'pulse', load: () => import('./views/activity.js') },
  { group: 'مدیریت', path: 'settings', label: 'تنظیمات', icon: 'gear', manager: true, load: () => import('./views/settings.js') },
  { path: 'profile', label: 'پروفایل من', icon: 'user', hidden: true, load: () => import('./views/profile.js') }
];

const ctx = {
  me: null, counts: {}, sections: SECTIONS, go, refreshCounts, subscribe,
  /** Updates the query part of the address without re-rendering (filters, page). */
  setQuery(params) {
    const { path, params: p } = parseHash();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, v);
    const qs = q.toString();
    history.replaceState(null, '', `#/${[path, ...p].map(encodeURIComponent).join('/')}${qs ? '?' + qs : ''}`);
  },
  setUser(user) { ctx.me = user; paintMe(); }
};
let cleanup = null;
let renderToken = 0;

/* ------------------------------------------------------------ screens */
function show(id) {
  for (const s of ['login', 'first-password', 'shell']) $('#' + s).hidden = s !== id;
}
function showLogin() {
  ctx.me = null;
  disconnect();
  show('login');
  document.title = 'ورود | انبار';
  const u = $('#login-username');
  setTimeout(() => (u.value ? $('#login-password') : u).focus(), 0);
}
function showFirstPassword() {
  show('first-password');
  document.title = 'رمز تازه | انبار';
  $('#first-username').value = ctx.me ? ctx.me.username : '';
  setTimeout(() => $('#fp-current').focus(), 0);
}
onAuthProblem({
  signedOut() {
    if (!ctx.me) return;
    toast('نشست شما تمام شد؛ دوباره وارد شوید.', { error: true });
    showLogin();
  },
  mustChange() { showFirstPassword(); }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const { username, password } = formValues(form);
  const errors = {};
  if (!username.trim()) errors.username = 'نام کاربری را وارد کنید.';
  if (!password) errors.password = 'رمز عبور را وارد کنید.';
  if (fieldErrors(form, errors)) return;
  const btn = $('button[type=submit]', form);
  busy(btn, true, 'در حال ورود…');
  try {
    const { user } = await post('/auth/login', { username: latin(username.trim()), password });
    $('#login-password').value = '';
    enter(user);
  } catch (err) {
    showError(form, err);
  } finally {
    busy(btn, false);
  }
});

$('#first-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const v = formValues(form);
  const errors = {};
  if (!v.current) errors.current = 'رمز موقت را وارد کنید.';
  if (v.next.length < 8) errors.next = 'رمز جدید باید دست‌کم ۸ نویسه باشد.';
  else if (v.next !== v.repeat) errors.repeat = 'تکرار رمز با رمز جدید یکی نیست.';
  if (fieldErrors(form, errors)) return;
  const btn = $('button[type=submit]', form);
  busy(btn, true, 'در حال ذخیره…');
  try {
    await post('/me/password', { current: v.current, next: v.next });
    form.reset();
    const { user } = await get('/auth/me');
    toast('رمز شما ذخیره شد. خوش آمدید!');
    enter(user);
  } catch (err) {
    showError(form, err);
  } finally {
    busy(btn, false);
  }
});

$$('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
  if (ctx.me && !ctx.me.must_change_password && !(await confirm({ title: 'از انبار خارج می‌شوید؟', yes: 'خروج' }))) return;
  await post('/auth/logout').catch(() => {});
  newSession();
  if (cleanup) { cleanup(); cleanup = null; }
  $('#view').innerHTML = '';
  history.replaceState(null, '', location.pathname);
  showLogin();
}));

/* ------------------------------------------------------------ shell */
const allowed = (s) => !s.manager || (ctx.me && ctx.me.role === 'manager');

function paintMe() {
  if (!ctx.me) return;
  $('#me-name').textContent = ctx.me.name;
  $('#me-role').textContent = ROLES[ctx.me.role];
  const av = $('#me-avatar');
  av.textContent = initials(ctx.me.name);
  av.style.background = colorFor(ctx.me.username);
}

function renderNav(active) {
  const groups = new Map();
  for (const s of SECTIONS.filter((x) => !x.hidden && allowed(x))) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  $('#side-nav').innerHTML = [...groups].map(([title, items]) => `<div class="nav-group">
      <span class="nav-group-title">${esc(title)}</span>
      ${items.map((s) => {
        const n = s.count ? ctx.counts[s.count] || 0 : 0;
        return `<a class="nav-item" href="#/${s.path}"${s.path === active ? ' aria-current="page"' : ''}>${icon(s.icon)}<span>${s.label}</span>` +
          (n ? `<span class="nav-count${s.danger ? ' is-danger' : ''}" title="${fa(n)} ${s.countTitle}">${fa(n > 999 ? '999+' : n)}</span>` : '') + '</a>';
      }).join('')}
    </div>`).join('');
  const current = $('.nav-item[aria-current="page"]');
  if (current && window.matchMedia('(max-width: 1023px)').matches) current.scrollIntoView({ block: 'nearest', inline: 'center' });
}

async function refreshCounts() {
  if (!ctx.me || ctx.me.must_change_password || $('#shell').hidden) return;
  try {
    ctx.counts = await get('/counts');
    renderNav(parseHash().path);
  } catch { /* views show their own errors */ }
}
const refreshCountsSoon = debounce(refreshCounts, 1500);

function enter(user) {
  newSession();
  ctx.me = user;
  if (user.must_change_password) { showFirstPassword(); return; }
  show('shell');
  paintMe();
  if (!location.hash || location.hash === '#' || location.hash === '#/') history.replaceState(null, '', '#/dashboard');
  connect({ signedOut: showLogin });
  route();
  refreshCounts();
}

/* ------------------------------------------------------------ router */
function parseHash() {
  const [r, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [path, ...params] = r.split('/').filter(Boolean).map(decodeURIComponent);
  return { path: path || 'dashboard', params, query: new URLSearchParams(qs) };
}
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

async function route() {
  if (!ctx.me || ctx.me.must_change_password) return;
  const { path, params, query } = parseHash();
  ctx.query = query;
  const section = SECTIONS.find((s) => s.path === path);
  const root = $('#view');
  if ($('#sheet').open) $('#sheet').close();
  if (cleanup) { cleanup(); cleanup = null; }
  // Every page draws into its own new container. A page we have left may still finish a
  // request or a scheduled reload; it then writes into its detached container, never over this one.
  const view = document.createElement('div');
  view.className = 'page';
  root.replaceChildren(view);
  if (!section || !allowed(section)) {
    renderNav('');
    view.innerHTML = `<div class="empty">${icon('alert')}<strong>این بخش پیدا نشد</strong><p>ممکن است نشانی اشتباه باشد یا دسترسی این بخش را نداشته باشید.</p><a class="btn btn-primary" href="#/dashboard">داشبورد</a></div>`;
    return;
  }
  renderNav(section.path);
  const token = ++renderToken;
  root.setAttribute('aria-busy', 'true');
  document.title = `${section.label} | انبار`;
  try {
    const mod = await section.load();
    if (token !== renderToken) return;
    const result = await mod.render(view, ctx, params);
    if (token !== renderToken) { if (typeof result === 'function') result(); return; }
    cleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    if (token !== renderToken || !ctx.me) return;
    console.error(err);
    view.innerHTML = `<div class="empty">${icon('alert')}<strong>نمایش این بخش انجام نشد</strong><p>${esc(err.message || '')}</p><button class="btn btn-primary" type="button" data-retry>تلاش دوباره</button></div>`;
    $('[data-retry]', view).addEventListener('click', route);
  } finally {
    if (token === renderToken) root.setAttribute('aria-busy', 'false');
  }
  if (!params.length) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// Counters follow what happens anywhere (other admins, background sync)
subscribe('products', refreshCountsSoon);
subscribe('orders', refreshCountsSoon);
subscribe('sync', (d) => { if (d.state !== 'progress') refreshCountsSoon(); });

/* ------------------------------------------------------------ quick search (Ctrl+K) */
const palette = $('#palette');
const pInput = $('#palette-input');
const pList = $('#palette-list');
let pItems = [];
let pIndex = 0;
let pToken = 0;

function openPalette() {
  if (!ctx.me || palette.open) return;
  pInput.value = '';
  paintPalette([]);
  palette.showModal();
  pInput.focus();
}
function sectionItems(term) {
  const t = term.trim();
  return SECTIONS.filter((s) => allowed(s) && (!t || s.label.includes(t)))
    .map((s) => ({ kind: 'section', label: s.label, icon: s.icon, href: `#/${s.path}` }));
}
function paintPalette(products, { term = '', lookup = false, loading = false } = {}) {
  const sections = sectionItems(term).slice(0, term ? 4 : 8);
  pItems = [...products.map((p) => ({ kind: 'product', label: p.name, sub: `${p.company_name} · ${money(p.regular_price, p.currency)}`, icon: 'box', href: `#/products/${p.id}` })), ...sections];
  if (lookup) pItems.push({ kind: 'lookup', label: 'پیدا کردن این لینک در سایت شرکت', icon: 'link', url: term });
  pIndex = 0;
  let html = '';
  let i = 0;
  const opt = (it) => `<li role="option" id="pal-${i}" data-i="${i++}" aria-selected="false">${icon(it.icon)}<span class="grow">${esc(it.label)}</span>${it.sub ? `<small>${it.sub}</small>` : ''}</li>`;
  const prods = pItems.filter((x) => x.kind === 'product');
  if (prods.length) html += `<li class="group" role="presentation">کالاها</li>${prods.map(opt).join('')}`;
  const look = pItems.filter((x) => x.kind === 'lookup');
  if (look.length) html += look.map(opt).join('');
  const secs = pItems.filter((x) => x.kind === 'section');
  if (secs.length) html += `<li class="group" role="presentation">بخش‌ها</li>${secs.map(opt).join('')}`;
  if (!pItems.length) html = `<li class="none" role="presentation">${loading ? 'در حال جستجو…' : 'چیزی پیدا نشد.'}</li>`;
  pList.innerHTML = html;
  markPalette();
}
function markPalette() {
  $$('[role="option"]', pList).forEach((el) => el.setAttribute('aria-selected', String(Number(el.dataset.i) === pIndex)));
  const cur = $(`[data-i="${pIndex}"]`, pList);
  if (cur) { cur.scrollIntoView({ block: 'nearest' }); pInput.setAttribute('aria-activedescendant', cur.id); }
}
async function choosePalette(i) {
  const it = pItems[i];
  if (!it) return;
  if (it.kind === 'lookup') {
    pList.innerHTML = '<li class="none" role="presentation">در حال خواندن از سایت…</li>';
    try {
      const r = await post('/products/lookup', { url: it.url });
      palette.close();
      const id = r.matched || (r.items[0] && r.items[0].id);
      toast(`کالا از سایت ${r.company.name} خوانده شد.`);
      if (id) go(`#/products/${id}`);
    } catch (err) {
      pList.innerHTML = `<li class="none" role="presentation">${esc(err.message)}</li>`;
    }
    return;
  }
  palette.close();
  go(it.href);
}
const searchPalette = debounce(async () => {
  const term = pInput.value.trim();
  const token = ++pToken;
  if (term.length < 2) { paintPalette([], { term }); return; }
  paintPalette([], { term, loading: true });
  try {
    const r = await get('/products', { q: term, per: 8 });
    if (token !== pToken) return;
    paintPalette(r.items, { term, lookup: /^https?:\/\//i.test(term) && !r.items.length });
  } catch {
    if (token === pToken) paintPalette([], { term });
  }
}, 180);
pInput.addEventListener('input', searchPalette);
pInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pIndex = Math.min(pItems.length - 1, pIndex + 1); markPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pIndex = Math.max(0, pIndex - 1); markPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); choosePalette(pIndex); }
});
pList.addEventListener('click', (e) => { const o = e.target.closest('[role="option"]'); if (o) choosePalette(Number(o.dataset.i)); });
$$('[data-palette]').forEach((b) => b.addEventListener('click', openPalette));
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); }
  else if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) { e.preventDefault(); openPalette(); }
});

/* ------------------------------------------------------------ boot */
get('/auth/me').then(({ user }) => (user ? enter(user) : showLogin())).catch(showLogin);
