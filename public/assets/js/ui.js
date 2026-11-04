/**
 * Small UI helpers shared by every view: DOM, escaping, Persian numbers and
 * Jalali dates, money, toasts, the confirm dialog, the side sheet, forms.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const icon = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

/* ------------------------------------------------------------ numbers */
const nf = new Intl.NumberFormat('fa-IR');
const nf1 = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });
export const fa = (n) => (n === null || n === undefined || n === '' ? '—' : nf.format(n));
export const faDigits = (s) => String(s ?? '').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
export const latin = (s) => String(s ?? '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
export const percent = (a, b) => (a && b ? ((b - a) / a) * 100 : null);

export const CURRENCY = { toman: 'تومان', rial: 'ریال' };
export const PRICE_UNIT = { toman: 'تومان', rial: 'ریال', thousand_toman: 'هزار تومان', thousand_rial: 'هزار ریال' };
/** Whole rials → number in the company's currency */
export const inCurrency = (rial, currency) => (rial === null || rial === undefined ? null : currency === 'toman' ? rial / 10 : rial);
/** "۱۲۰٬۰۰۰ تومان" (unit in a <small>) */
export function money(rial, currency = 'toman', { unit = true } = {}) {
  if (rial === null || rial === undefined) return '<span class="muted">—</span>';
  const v = nf1.format(inCurrency(rial, currency));
  return `<span class="money">${v}${unit ? ` <small>${CURRENCY[currency] || ''}</small>` : ''}</span>`;
}
export const moneyText = (rial, currency = 'toman') => (rial === null || rial === undefined ? '—' : `${nf1.format(inCurrency(rial, currency))} ${CURRENCY[currency] || ''}`);

/** Price change badge: up is red (costs us more), down is green. */
export function delta(from, to) {
  const p = percent(from, to);
  if (p === null || !Number.isFinite(p) || p === 0) return '';
  const up = p > 0;
  return `<span class="delta ${up ? 'delta-up' : 'delta-down'}">${icon(up ? 'up' : 'dn')}${nf1.format(Math.abs(p))}٪</span>`;
}

/* ------------------------------------------------------------ dates (Jalali, Tehran time) */
const TZ = 'Asia/Tehran';
const dFull = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric' });
const dShort = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dTime = new Intl.DateTimeFormat('fa-IR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dSec = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const valid = (iso) => iso && !Number.isNaN(new Date(iso).getTime());
export const dateTime = (iso) => (valid(iso) ? dFull.format(new Date(iso)) : '—');
export const dateOnly = (iso) => (valid(iso) ? dDate.format(new Date(iso)) : '—');
export const timeOnly = (iso) => (valid(iso) ? dTime.format(new Date(iso)) : '—');
export const withSeconds = (iso) => (valid(iso) ? dSec.format(new Date(iso)) : '—');
/** "امروز ۱۰:۲۵" / "دیروز ۱۸:۰۰" / "۱۴ آبان، ۱۰:۲۵" */
export function smartTime(iso) {
  if (!valid(iso)) return '—';
  const d = new Date(iso);
  const day = dDay.format(d);
  const today = dDay.format(new Date());
  const yesterday = dDay.format(new Date(Date.now() - 864e5));
  if (day === today) return `امروز ${dTime.format(d)}`;
  if (day === yesterday) return `دیروز ${dTime.format(d)}`;
  return dShort.format(d);
}
export function ago(iso) {
  if (!valid(iso)) return 'هرگز';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'همین الان';
  if (s < 3600) return `${fa(Math.round(s / 60))} دقیقه پیش`;
  if (s < 86400) return `${fa(Math.round(s / 3600))} ساعت پیش`;
  if (s < 86400 * 30) return `${fa(Math.round(s / 86400))} روز پیش`;
  return dateOnly(iso);
}
/** <time> with the full date as a tooltip */
export const when = (iso, mode = 'smart') => (valid(iso)
  ? `<time datetime="${esc(iso)}" title="${esc(withSeconds(iso))}">${esc(mode === 'ago' ? ago(iso) : mode === 'date' ? dateOnly(iso) : mode === 'full' ? dateTime(iso) : smartTime(iso))}</time>`
  : '<span class="muted">—</span>');

/* ------------------------------------------------------------ labels */
export const STOCK = {
  instock: { label: 'موجود', cls: 'badge-green' },
  outofstock: { label: 'ناموجود', cls: 'badge-red' },
  onbackorder: { label: 'پیش‌سفارش', cls: 'badge-amber' }
};
export function stockBadge(p) {
  const s = STOCK[p.stock_status] || { label: p.stock_status || 'نامشخص', cls: '' };
  const qty = p.stock_quantity !== null && p.stock_quantity !== undefined && p.stock_status === 'instock' ? ` <span class="num">${fa(p.stock_quantity)}</span>` : '';
  return `<span class="badge ${s.cls}">${s.label}${qty}</span>`;
}
export const SOURCE = {
  import: { label: 'اولین خواندن', cls: '' },
  sync: { label: 'همگام‌سازی', cls: 'badge-blue' },
  webhook: { label: 'افزونه (فوری)', cls: 'badge-green' },
  refresh: { label: 'خواندن دستی', cls: 'badge-navy' },
  manual: { label: 'ثبت دستی', cls: 'badge-orange' }
};
export const sourceBadge = (s) => `<span class="badge ${(SOURCE[s] || {}).cls || ''}">${esc((SOURCE[s] || {}).label || s)}</span>`;
export const ROLES = { manager: 'مدیر', admin: 'ادمین' };
export const SITE_STATUS = { publish: 'منتشرشده', draft: 'پیش‌نویس', private: 'خصوصی', pending: 'در انتظار بررسی', trash: 'زباله‌دان' };

const PALETTE = ['#0f1a4f', '#2d6ae0', '#e8650a', '#16874a', '#7c3aed', '#be185d', '#0e7490', '#a16207'];
export const colorFor = (key) => PALETTE[[...String(key)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
export const initials = (name) => String(name || '؟').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('‌');

/* ------------------------------------------------------------ toasts */
export function toast(message, { error = false, action, onAction, ms = 4200 } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' is-error' : '');
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `${icon(error ? 'alert' : 'check')}<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) $('button', el).addEventListener('click', () => { onAction && onAction(); el.remove(); });
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/* ------------------------------------------------------------ confirm */
export function confirm({ title, text = '', yes = 'تأیید', danger = false }) {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-text').hidden = !text;
  const btn = $('#confirm-yes');
  btn.textContent = yes;
  btn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { const ok = dlg.returnValue === 'yes'; dlg.returnValue = ''; resolve(ok); }, { once: true });
  });
}

/* ------------------------------------------------------------ side sheet */
let sheetCleanup = null;
export function openSheet(title, html, { onClose } = {}) {
  const dlg = $('#sheet');
  // Already open (one step leads to the next): swap the content in place. Closing and
  // reopening would let the asynchronous "close" event wipe the new content.
  const previous = dlg.open ? sheetCleanup : null;
  $('#sheet-title').textContent = title;
  const body = $('#sheet-body');
  body.innerHTML = html;
  sheetCleanup = onClose || null;
  if (previous) previous();
  if (!dlg.open) dlg.showModal();
  const first = $('[autofocus], input:not([type=hidden]):not([readonly]), select, textarea', body);
  if (first) first.focus();
  return body;
}
export function closeSheet() {
  const dlg = $('#sheet');
  if (dlg.open) dlg.close();
}
document.addEventListener('DOMContentLoaded', () => {
  const dlg = $('#sheet');
  dlg.addEventListener('close', () => {
    const fn = sheetCleanup;
    sheetCleanup = null;
    $('#sheet-body').innerHTML = '';
    if (fn) fn();
  });
  $('[data-close-sheet]').addEventListener('click', closeSheet);
  // Light dismiss where <dialog closedby> is not supported yet
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e, d) => {
      const r = d.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const d of $$('dialog[closedby="any"]')) {
      let pressedOutside = false;
      d.addEventListener('pointerdown', (e) => { pressedOutside = outside(e, d); });
      d.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e, d)) d.close(); });
    }
  }
});

/* ------------------------------------------------------------ forms */
/** Shows field errors under the matching inputs; returns true when there were any. */
export function fieldErrors(form, errors = {}) {
  $$('.field', form).forEach((f) => { f.classList.remove('has-error'); const e = $('.error', f); if (e) e.remove(); });
  const general = $('.form-error', form);
  if (general) general.remove();
  let firstBad = null;
  const left = [];
  for (const [name, msg] of Object.entries(errors)) {
    const input = form.elements[name];
    const field = input && (input.closest ? input.closest('.field') : null);
    if (!field) { left.push(msg); continue; }
    field.classList.add('has-error');
    const id = `${input.id || name}-error`;
    const p = document.createElement('p');
    p.className = 'error';
    p.id = id;
    p.textContent = msg;
    field.appendChild(p);
    input.setAttribute('aria-describedby', id);
    input.setAttribute('aria-invalid', 'true');
    firstBad = firstBad || input;
  }
  if (left.length) {
    const p = document.createElement('p');
    p.className = 'form-error';
    p.setAttribute('role', 'alert');
    p.textContent = left.join(' ');
    form.prepend(p);
  }
  if (firstBad) firstBad.focus();
  return Object.keys(errors).length > 0;
}
/** Shows an API error on a form (field errors when the server named fields). */
export function showError(form, err) {
  if (err.fields && Object.keys(err.fields).length) {
    const known = Object.fromEntries(Object.entries(err.fields).filter(([k]) => form.elements[k]));
    if (Object.keys(known).length) return fieldErrors(form, known);
  }
  return fieldErrors(form, { _: err.message });
}
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}
export function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (label) btn.innerHTML = `${icon('refresh')}<span>${esc(label)}</span>`;
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}
export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export async function copy(text, what = 'متن') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} کپی شد.`);
  } catch {
    toast('کپی انجام نشد؛ متن را انتخاب و دستی کپی کنید.', { error: true });
  }
}
/** Reveal/hide password buttons: <button data-reveal="input-id"> */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (!b) return;
  const input = document.getElementById(b.dataset.reveal);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  b.setAttribute('aria-pressed', String(show));
  b.setAttribute('aria-label', show ? 'پنهان کردن رمز' : 'نمایش رمز');
  $('use', b).setAttribute('href', show ? '#i-eye-off' : '#i-eye');
});

/* ------------------------------------------------------------ bits of markup */
export const skeleton = (n = 5) => `<div class="skeleton" aria-hidden="true">${'<i></i>'.repeat(n)}</div>`;
export const empty = (ic, title, text = '', action = '') =>
  `<div class="empty">${icon(ic)}<strong>${esc(title)}</strong>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
export function pager({ page, pages, total }, noun = 'مورد') {
  return `<div class="table-foot"><span>${fa(total)} ${noun}</span>
    <div class="pager" role="navigation" aria-label="صفحه‌ها">
      <button class="icon-btn sm" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="صفحه‌ی قبل">${icon('back')}</button>
      <span>صفحه‌ی ${fa(page)} از ${fa(pages)}</span>
      <button class="icon-btn sm" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="صفحه‌ی بعد">${icon('next')}</button>
    </div></div>`;
}
/** Decodes a percent-encoded link for display (Persian slugs). */
export function prettyUrl(u) {
  try { return decodeURI(u); } catch { return u; }
}
