/** The activity log: who changed what, when and from where, with before → after for every field. */
import { get } from '../api.js';
import { $, $$, esc, icon, fa, skeleton, empty, debounce } from '../ui.js';
import { ENTITY, entryHtml } from './timeline.js';

const PERIODS = { '': 'همه', today: 'امروز', '7d': '۷ روز', '30d': '۳۰ روز' };
function since(p) {
  if (p === 'today') {
    // Midnight in Tehran
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return new Date(`${parts}T00:00:00+03:30`).toISOString();
  }
  if (p === '7d') return new Date(Date.now() - 7 * 864e5).toISOString();
  if (p === '30d') return new Date(Date.now() - 30 * 864e5).toISOString();
  return '';
}

export async function render(view, ctx) {
  const f = {
    user: ctx.query.get('user') || '', entity: ctx.query.get('entity') || '', period: ctx.query.get('period') || '',
    q: ctx.query.get('q') || '', hide_logins: ctx.query.get('hide_logins') || '1', page: ctx.query.get('page') || ''
  };
  const { items: users } = await get('/users');
  let data = null;

  view.innerHTML = `
    <div class="page-head"><div><h1>گزارش فعالیت</h1><p>هر تغییری که هر کسی در نرم‌افزار بدهد اینجا می‌ماند و هیچ‌وقت پاک نمی‌شود.</p></div></div>
    <div class="card" style="display:grid;gap:12px">
      <div class="toolbar">
        <label class="search"><span class="sr-only">جستجو در فعالیت‌ها</span>${icon('search')}<input type="search" id="a-q" value="${esc(f.q)}" placeholder="جستجو: نام کالا، شرکت، کاربر…"></label>
        <select class="input" id="a-user" aria-label="کاربر"><option value="">همه‌ی کاربران</option><option value="system"${f.user === 'system' ? ' selected' : ''}>سیستم (خودکار)</option>
          ${users.map((u) => `<option value="${u.id}"${String(u.id) === f.user ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
        <select class="input" id="a-entity" aria-label="بخش"><option value="">همه‌ی بخش‌ها</option>
          ${Object.entries(ENTITY).map(([k, v]) => `<option value="${k}"${k === f.entity ? ' selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="بازه‌ی زمانی">${Object.entries(PERIODS).map(([k, v]) => `<button type="button" data-period="${k}" aria-pressed="${k === f.period}">${v}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" id="a-logins" ${f.hide_logins === '1' ? 'checked' : ''}> ورودها را نشان نده</label>
      </div>
    </div>
    <section class="card card-flush" aria-label="فعالیت‌ها"><div id="a-list">${skeleton(8)}</div></section>`;

  function paint() {
    const box = $('#a-list', view);
    if (!data.items.length) { box.innerHTML = empty('pulse', 'فعالیتی پیدا نشد', 'فیلترها را عوض کنید.'); return; }
    box.innerHTML = `<div class="timeline">${data.items.map((a) => entryHtml(a)).join('')}</div>
      <div class="table-foot"><span>${fa(data.total)} فعالیت</span><div class="pager">
        <button class="icon-btn sm" type="button" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''} aria-label="صفحه‌ی قبل">${icon('back')}</button>
        <span>صفحه‌ی ${fa(data.page)} از ${fa(data.pages)}</span>
        <button class="icon-btn sm" type="button" data-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''} aria-label="صفحه‌ی بعد">${icon('next')}</button></div></div>`;
  }
  async function load() {
    ctx.setQuery({ ...f, hide_logins: f.hide_logins === '1' ? '' : '0' });
    try {
      data = await get('/activity', { user: f.user, entity: f.entity, q: f.q, hide_logins: f.hide_logins === '1' ? '1' : '', from: since(f.period), page: f.page });
      paint();
    } catch (err) { $('#a-list', view).innerHTML = empty('alert', 'گزارش نیامد', err.message); }
  }
  if (ctx.query.get('hide_logins') === '0') f.hide_logins = '0';

  $('#a-q', view).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); f.page = ''; load(); }, 300));
  $('#a-user', view).addEventListener('change', (e) => { f.user = e.target.value; f.page = ''; load(); });
  $('#a-entity', view).addEventListener('change', (e) => { f.entity = e.target.value; f.page = ''; load(); });
  $('#a-logins', view).addEventListener('change', (e) => { f.hide_logins = e.target.checked ? '1' : '0'; f.page = ''; load(); });
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.period !== undefined) {
      f.period = b.dataset.period; f.page = '';
      $$('[data-period]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      load();
    } else if (b.dataset.page) { f.page = b.dataset.page === '1' ? '' : b.dataset.page; load(); }
  };
  await load();
  const off = ctx.subscribe('activity', debounce(() => { if (!f.page || f.page === '1') load(); }, 800));
  return () => off();
}
