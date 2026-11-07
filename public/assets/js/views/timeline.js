/** The activity-log entry markup shared by the activity page and the profile page. */
import { esc, icon, fa, when, moneyText } from '../ui.js';

export const ENTITY = { company: 'شرکت', product: 'کالا', user: 'کاربر', warehouse: 'انبار', settings: 'تنظیمات' };
export const ACTION = {
  login: { label: 'ورود', icon: 'user' }, logout: { label: 'خروج', icon: 'logout' }, create: { label: 'افزودن', icon: 'plus' },
  update: { label: 'ویرایش', icon: 'edit' }, password: { label: 'رمز', icon: 'key' }, price: { label: 'قیمت دستی', icon: 'hand' },
  sync: { label: 'همگام‌سازی', icon: 'refresh' }
};

export function entityLink(a) {
  if (!a.entity_id) return '';
  if (a.entity === 'company') return `#/companies/${a.entity_id}`;
  if (a.entity === 'product') return `#/products/${a.entity_id}`;
  if (a.entity === 'warehouse') return '#/warehouses';
  return '';
}

function value(c, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (c.field === 'regular_price') return moneyText(v, 'rial');
  if (typeof v === 'number') return fa(v);
  return String(v);
}

export function changesHtml(changes) {
  if (!changes || !changes.length) return '';
  return `<dl class="changes">${changes.map((c) => `<div><dt>${esc(c.label)}</dt><dd><span class="from">${esc(value(c, c.from))}</span> ← <span class="to">${esc(value(c, c.to))}</span></dd></div>`).join('')}</dl>`;
}

export function entryHtml(a, { showUser = true } = {}) {
  const act = ACTION[a.action] || { label: a.action, icon: 'pulse' };
  const link = entityLink(a);
  return `<article class="tl-item">
    <span class="list-icon" aria-hidden="true">${icon(act.icon)}</span>
    <div style="min-width:0">
      <div class="tl-head">${showUser ? `<strong>${esc(a.user_name || 'سیستم')}</strong>` : ''}<small>${when(a.created_at, 'full')}</small>
        <span class="badge">${esc(ENTITY[a.entity] || a.entity)} · ${esc(act.label)}</span>${a.ip ? `<small class="ltr" title="نشانی IP">${esc(a.ip)}</small>` : ''}</div>
      <div class="tl-summary">${link ? `<a class="link" style="font-weight:500" href="${link}">${esc(a.summary)}</a>` : esc(a.summary)}</div>
      ${changesHtml(a.changes)}
    </div></article>`;
}
