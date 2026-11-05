/**
 * Orders: the list (#/orders), fast order entry (#/orders/new), one order (#/orders/:id).
 * Entry is built for ~300 orders a day: platform and date stay between orders, the picker takes
 * a listing code, product name or SKU, Enter adds, Ctrl+Enter saves, and every line shows the
 * company site's price at the order time (read live from the site when the order is recent).
 */
import { get, post, put } from '../api.js';
import {
  $, $$, esc, icon, fa, money, moneyText, when, skeleton, empty, toast, openSheet, closeSheet, fieldErrors, showError,
  formValues, busy, debounce, latin, inCurrency, CURRENCY, sourceBadge, smartTime, faDigits
} from '../ui.js';
import { createPicker } from '../picker.js';
import { jalaliToday, timeNow, toIso, describeDate, readDate, readTime, gregorianDay } from '../jalali.js';
import { entryHtml } from './timeline.js';

export async function render(view, ctx, params) {
  if (params[0] === 'new') return renderNew(view, ctx);
  if (params[0] === 'import') return (await import('./import.js')).render(view, ctx);
  if (params[0]) return renderOne(view, ctx, Number(params[0]));
  return renderList(view, ctx);
}

const OUTCOME = { ok: ['درست رسید', 'badge-green'], excess: ['اضافه رسید', 'badge-blue'], short: ['کم رسید', 'badge-amber'], wrong: ['اشتباه رسید', 'badge-red'], cancelled: ['لغو', ''] };
const num = (s) => {
  const t = latin(String(s ?? '')).replace(/[,،٬\s]/g, '');
  return t === '' ? null : Number(t);
};
export function lineStatus(l) {
  if (l.status === 'pending') return '<span class="badge badge-orange">منتظر دریافت</span>';
  const [label, cls] = OUTCOME[l.outcome] || [l.outcome, ''];
  return `<span class="badge ${cls}">${label}</span>`;
}

/* ======================================================================== list */
async function renderList(view, ctx) {
  const f = Object.fromEntries(['q', 'platform', 'company', 'status', 'period', 'page'].map((k) => [k, ctx.query.get(k) || '']));
  const [{ items: platforms }, { items: companies }] = await Promise.all([get('/platforms'), get('/companies')]);
  let data = null;
  const periods = { '': 'همه', today: 'امروز', yesterday: 'دیروز', week: '۷ روز' };
  const range = () => {
    if (f.period === 'today') return { from: gregorianDay(0), to: '' };
    if (f.period === 'yesterday') return { from: gregorianDay(-1), to: gregorianDay(0) };
    if (f.period === 'week') return { from: gregorianDay(-6), to: '' };
    return { from: '', to: '' };
  };
  view.innerHTML = `
    <div class="page-head">
      <div><h1>سفارش‌ها</h1><p>هر سفارش با قیمت سایت شرکت در همان ساعت سفارش ثبت می‌شود.</p></div>
      <div class="page-actions"><a class="btn" href="#/orders/import">${icon('download')}ورود از اکسل</a><a class="btn btn-primary" href="#/orders/new">${icon('plus')}سفارش جدید</a></div>
    </div>
    <div class="card" style="display:grid;gap:12px">
      <div class="toolbar">
        <label class="search"><span class="sr-only">جستجو</span>${icon('search')}<input type="search" id="o-q" value="${esc(f.q)}" placeholder="شماره‌ی سفارش یا نام کالا…"></label>
        <select class="input" id="o-platform" aria-label="پلتفرم"><option value="">همه‌ی پلتفرم‌ها</option>${platforms.map((p) => `<option value="${p.id}"${String(p.id) === f.platform ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <select class="input" id="o-company" aria-label="شرکت"><option value="">همه‌ی شرکت‌ها</option>${companies.map((c) => `<option value="${c.id}"${String(c.id) === f.company ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </div>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="وضعیت">${[['', 'همه'], ['pending', 'منتظر دریافت'], ['done', 'انجام‌شده'], ['manual', 'قیمت دستی یا نامطمئن'], ['cancelled', 'لغوشده']]
          .map(([k, v]) => `<button type="button" data-status="${k}" aria-pressed="${k === f.status}">${v}</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="زمان">${Object.entries(periods).map(([k, v]) => `<button type="button" data-period="${k}" aria-pressed="${k === f.period}">${v}</button>`).join('')}</div>
      </div>
    </div>
    <section class="card card-flush" aria-label="فهرست سفارش‌ها"><div id="o-list">${skeleton(8)}</div></section>`;

  function paint() {
    const box = $('#o-list', view);
    if (!data.items.length) {
      box.innerHTML = empty('box', 'سفارشی پیدا نشد', 'سفارش‌ها را از «سفارش جدید» یا «ورود از اکسل» ثبت کنید.', '<a class="btn btn-primary" href="#/orders/new">سفارش جدید</a>');
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">سفارش</th><th scope="col">کالاها</th><th scope="col">زمان سفارش</th><th scope="col" class="col-num">مبلغ برای شرکت</th><th scope="col">وضعیت</th></tr></thead>
      <tbody>${data.items.map((o) => `<tr>
        <td class="cell-main"><div class="cell-title"><a href="#/orders/${o.id}">${esc(o.platform_name)} ${o.order_number ? `<span class="ltr">${esc(faDigits(o.order_number))}</span>` : `#${fa(o.id)}`}</a>
          <div class="cell-meta"><span>${esc(o.companies || '')}</span>${o.source === 'import' ? '<span class="badge">از فایل</span>' : ''}${o.flagged ? '<span class="badge badge-amber">قیمت دستی/نامطمئن</span>' : ''}</div></div></td>
        <td data-label="کالاها" class="small" style="max-width:340px">${esc((o.products || '').slice(0, 120))}${(o.products || '').length > 120 ? '…' : ''} <span class="muted">(${fa(o.lines)} قلم)</span></td>
        <td data-label="زمان">${when(o.ordered_at)}</td>
        <td class="col-num" data-label="مبلغ برای شرکت"><span class="price">${moneyText(o.settle_total, 'toman')}</span></td>
        <td data-label="وضعیت">${o.cancelled_at ? '<span class="badge">لغوشده</span>' : o.pending ? `<span class="badge badge-orange">${fa(o.pending)} منتظر دریافت</span>` : '<span class="badge badge-green">انجام شد</span>'}</td>
      </tr>`).join('')}</tbody></table></div>
      <div class="table-foot"><span>${fa(data.total)} سفارش</span><div class="pager">
        <button class="icon-btn sm" type="button" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''} aria-label="صفحه‌ی قبل">${icon('back')}</button>
        <span>صفحه‌ی ${fa(data.page)} از ${fa(data.pages)}</span>
        <button class="icon-btn sm" type="button" data-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''} aria-label="صفحه‌ی بعد">${icon('next')}</button></div></div>`;
  }
  async function load() {
    ctx.setQuery(f);
    try {
      data = await get('/orders', { q: f.q, platform: f.platform, company: f.company, status: f.status, page: f.page, ...range() });
      paint();
    } catch (err) { $('#o-list', view).innerHTML = empty('alert', 'فهرست سفارش‌ها نیامد', err.message); }
  }
  $('#o-q', view).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); f.page = ''; load(); }, 250));
  $('#o-platform', view).addEventListener('change', (e) => { f.platform = e.target.value; f.page = ''; load(); });
  $('#o-company', view).addEventListener('change', (e) => { f.company = e.target.value; f.page = ''; load(); });
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const key of ['status', 'period']) {
      if (b.dataset[key] !== undefined) {
        f[key] = b.dataset[key]; f.page = '';
        $$(`[data-${key}]`, view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        return load();
      }
    }
    if (b.dataset.page) { f.page = b.dataset.page === '1' ? '' : b.dataset.page; load(); }
  };
  await load();
  const off = ctx.subscribe('orders', debounce(() => load(), 800));
  return () => off();
}

/* ======================================================================== new order */
const draft = { platform: null, date: null }; // kept between orders in this tab

async function renderNew(view, ctx) {
  const { items: platforms } = await get('/platforms');
  const active = platforms.filter((p) => p.active);
  if (!draft.platform || !active.some((p) => p.id === draft.platform)) draft.platform = active[0].id;
  if (!draft.date) draft.date = jalaliToday();
  let lines = [];
  let seq = 0;

  view.innerHTML = `
    <div><a class="back" href="#/orders">${icon('back')}سفارش‌ها</a>
      <div class="page-head"><div><h1>سفارش جدید</h1><p>کالا را با کد آگهی، نام یا کد کالا پیدا کنید. <kbd dir="ltr">Enter</kbd> افزودن، <kbd dir="ltr">Ctrl Enter</kbd> ذخیره.</p></div>
        <div class="page-actions"><a class="btn" href="#/orders/import">${icon('download')}ورود از اکسل</a></div></div></div>
    <form id="f-order" class="grid" novalidate>
      <section class="card form">
        <div class="field"><span class="field-label" id="pl-label">پلتفرم</span>
          <div class="seg" role="radiogroup" aria-labelledby="pl-label" id="o-platforms">${active.map((p) => `<button type="button" role="radio" data-pl="${p.id}" aria-checked="${p.id === draft.platform}">${esc(p.name)}</button>`).join('')}</div></div>
        <div class="form-row cols-3">
          <div class="field"><label for="o-number">شماره‌ی سفارش</label><input id="o-number" name="order_number" dir="ltr" autocomplete="off" placeholder="مثلاً ۲۴۳۱۸۵۷۶۳"></div>
          <div class="field"><label for="o-date">تاریخ سفارش</label><input id="o-date" name="date" dir="ltr" inputmode="numeric" value="${esc(draft.date)}" placeholder="۱۴۰۵/۰۸/۱۴" required>
            <span class="hint" id="o-date-hint"></span>
            <span class="chips"><button class="chip" type="button" data-day="0">امروز</button><button class="chip" type="button" data-day="-1">دیروز</button></span></div>
          <div class="field"><label for="o-time">ساعت سفارش</label><input id="o-time" name="time" dir="ltr" inputmode="numeric" placeholder="۱۴:۲۰" required>
            <span class="hint">ساعت دقیق ثبت سفارش در پلتفرم؛ قیمت سایت همان ساعت حساب می‌شود.</span>
            <span class="chips"><button class="chip" type="button" data-now>الان</button></span></div>
        </div>
        <details><summary class="link">نام مشتری و یادداشت (اختیاری)</summary>
          <div class="form-row cols-2" style="margin-top:12px">
            <div class="field"><label for="o-customer">نام مشتری</label><input id="o-customer" name="customer"></div>
            <div class="field"><label for="o-note">یادداشت</label><input id="o-note" name="note"></div>
          </div></details>
      </section>
      <section class="card card-flush" aria-labelledby="h-lines">
        <div class="card-head"><h2 id="h-lines">کالاهای سفارش</h2><span class="muted small" id="o-count"></span></div>
        <div style="padding:0 18px 14px"><div class="picker"><label class="sr-only" for="o-pick">افزودن کالا</label>
          <div class="search">${icon('search')}<input id="o-pick" type="search" placeholder="کد آگهی، نام کالا یا کد کالا را بنویسید و Enter بزنید…"></div></div></div>
        <div id="o-lines"></div>
      </section>
      <section class="card">
        <div class="order-foot">
          <div id="o-totals" class="small muted"></div>
          <div class="form-actions"><button class="btn btn-primary btn-lg" type="submit" id="o-save">${icon('check')}ثبت سفارش</button></div>
        </div>
      </section>
    </form>`;

  const form = $('#f-order', view);
  const dateIn = $('#o-date', view);
  const timeIn = $('#o-time', view);
  const orderedAt = () => toIso(dateIn.value, timeIn.value);
  const platformId = () => draft.platform;
  const platformCode = () => (platforms.find((p) => p.id === draft.platform) || {}).code;

  function hintDate() { $('#o-date-hint', view).textContent = describeDate(dateIn.value) || (dateIn.value ? 'تاریخ را به شکل ۱۴۰۵/۰۸/۱۴ بنویسید.' : ''); }
  hintDate();

  /* ---------- lines ---------- */
  function lineHtml(l) {
    const cur = l.currency;
    const q = l.quote;
    let price;
    if (l.loading) price = `<span class="muted small">${icon('refresh', 'spin')} خواندن قیمت از سایت…</span>`;
    else if (!orderedAt()) price = '<span class="muted small">اول تاریخ و ساعت را وارد کنید.</span>';
    else if (l.manual) price = `<span class="badge badge-orange">قیمت دستی</span>`;
    else if (q && q.price) {
      price = `<span class="price">${money(q.price.regular_price, cur)}</span>
        <div class="small muted">قیمت ${esc(smartTime(q.price.effective_at))} ${sourceBadge(q.price.source)}${q.refreshed ? ' · همین الان از سایت خوانده شد' : ''}</div>
        ${q.uncertain ? `<div class="small" style="color:var(--amber)">${icon('alert')} ${q.price.before_first_seen
          ? 'این کالا کمی بعد از ساعت سفارش برای اولین بار خوانده شد؛ همان قیمت گذاشته شد.'
          : `از زمان سفارش به بعد سایت بررسی نشده${q.refresh_error ? ` (${esc(q.refresh_error)})` : ''}.`}</div>` : ''}`;
    } else if (q && !q.price) price = `<span class="badge badge-red">قیمت آن ساعت معلوم نیست</span><div class="small muted">قیمت را دستی وارد کنید.</div>`;
    else price = '';
    const sitePrice = l.manual ? num(l.manualPrice) : q && q.price ? inCurrency(q.price.regular_price, cur) : null;
    const settle = sitePrice !== null && sitePrice !== undefined && !Number.isNaN(sitePrice) ? Math.round((sitePrice * l.units) / l.units_per_pack) : null;
    const needsManual = l.manual || (q && !q.price);
    return `<div class="order-line" data-k="${l.k}">
      <div class="ol-main">
        <div class="cell-title"><strong>${esc(l.name)}</strong>
          <div class="cell-meta"><span>${esc(l.company_name)}</span>${l.listing_id ? `<span class="badge badge-blue">آگهی${l.code ? ` ${esc(l.code)}` : ''}</span>` : ''}
          <span>${l.units === l.units_per_pack ? `کل بسته (${fa(l.units)} عدد)` : `${fa(l.units)} عدد از بسته‌ی ${fa(l.units_per_pack)} عددی`}</span></div></div>
        <button class="icon-btn sm" type="button" data-remove aria-label="حذف ${esc(l.name)} از سفارش">${icon('x')}</button>
      </div>
      <div class="ol-fields">
        <div class="field"><label for="q-${l.k}">تعداد</label><input id="q-${l.k}" class="ol-qty" data-f="qty" inputmode="numeric" value="${fa(l.qty)}"></div>
        ${l.listing_id ? '' : `<div class="field"><label for="u-${l.k}">عدد در هر فروش</label><input id="u-${l.k}" data-f="units" inputmode="numeric" value="${fa(l.units)}"></div>`}
        <div class="field"><label for="pp-${l.k}">قیمت در ${esc((platforms.find((p) => p.id === draft.platform) || {}).name || 'پلتفرم')} (تومان)</label><input id="pp-${l.k}" data-f="platform_price" inputmode="numeric" value="${esc(l.platform_price || '')}" placeholder="اختیاری"></div>
        <div class="ol-price"><span class="field-label">قیمت سایت شرکت</span>${price}</div>
        <div class="ol-price"><span class="field-label">مبلغ برای شرکت</span>${settle !== null ? `<span class="price">${fa(settle * l.qty)} <small>${CURRENCY[cur]}</small></span>${l.qty > 1 ? `<div class="small muted">هر فروش ${fa(settle)}</div>` : ''}` : '<span class="muted">—</span>'}</div>
      </div>
      ${needsManual ? `<div class="ol-fields ol-manual">
        <div class="field"><label for="mp-${l.k}">قیمت سایت در آن ساعت (${CURRENCY[cur]}، کل بسته)</label><input id="mp-${l.k}" data-f="manualPrice" inputmode="numeric" value="${esc(l.manualPrice || '')}"></div>
        <div class="field" style="grid-column:span 2"><label for="mr-${l.k}">دلیل</label><input id="mr-${l.k}" data-f="reason" value="${esc(l.reason || '')}" placeholder="مثلاً: سفارش قبل از وصل شدن سایت بود"></div>
      </div>` : `<button class="link small" type="button" data-manual style="margin-top:6px">ثبت قیمت دستی</button>`}
      ${!l.listing_id && platformCode() !== 'site' ? `<label class="check small" style="margin-top:8px"><input type="checkbox" data-f="saveListing" ${l.saveListing ? 'checked' : ''}> برای دفعه‌های بعد آگهی بساز${l.saveListing ? '' : ''}</label>
        ${l.saveListing ? `<div class="ol-fields"><div class="field"><label for="lc-${l.k}">کد آگهی در پلتفرم</label><input id="lc-${l.k}" data-f="listingCode" dir="ltr" value="${esc(l.listingCode || '')}" placeholder="مثلاً DKPC"></div></div>` : ''}` : ''}
    </div>`;
  }
  function paintLines() {
    const box = $('#o-lines', view);
    box.innerHTML = lines.length ? lines.map(lineHtml).join('')
      : `<div class="empty" style="padding:24px">${icon('box')}<p>هنوز کالایی اضافه نشده. بالا جستجو کنید.</p></div>`;
    $('#o-count', view).textContent = lines.length ? `${fa(lines.length)} قلم` : '';
    paintTotals();
  }
  function paintTotals() {
    const by = new Map();
    for (const l of lines) {
      const sp = l.manual ? num(l.manualPrice) : l.quote && l.quote.price ? inCurrency(l.quote.price.regular_price, l.currency) : null;
      if (sp === null || Number.isNaN(sp)) continue;
      const k = `${l.company_name}|${l.currency}`;
      by.set(k, (by.get(k) || 0) + Math.round((sp * l.units) / l.units_per_pack) * l.qty);
    }
    $('#o-totals', view).innerHTML = by.size ? [...by].map(([k, v]) => { const [n, c] = k.split('|'); return `<div>${esc(n)}: <b class="price">${fa(v)} ${CURRENCY[c]}</b></div>`; }).join('') : '';
  }
  async function quoteLine(l) {
    const at = orderedAt();
    if (!at) { l.quote = null; return; }
    l.loading = true;
    replaceLine(l);
    try {
      l.quote = await post('/orders/quote', { listing_id: l.listing_id, product_id: l.listing_id ? undefined : l.product_id, ordered_at: at });
      l.units_per_pack = l.quote.product.units_per_pack;
    } catch (err) {
      l.quote = null;
      toast(err.message, { error: true });
    } finally {
      l.loading = false;
      replaceLine(l);
    }
  }
  function replaceLine(l) {
    const el = $(`.order-line[data-k="${l.k}"]`, view);
    if (!el) return;
    const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    el.outerHTML = lineHtml(l);
    if (focused) { const f = document.getElementById(focused); if (f) { f.focus(); if (f.setSelectionRange && f.value) f.setSelectionRange(f.value.length, f.value.length); } }
    paintTotals();
  }
  const requoteAll = debounce(() => lines.forEach((l) => quoteLine(l)), 400);

  createPicker($('#o-pick', view), {
    params: () => ({ platform: platformId() }),
    onPick(it) {
      const l = {
        k: ++seq, listing_id: it.kind === 'listing' ? it.listing_id : null, product_id: it.product_id, name: it.kind === 'listing' ? it.product_name : it.name,
        code: it.code, company_name: it.company_name, currency: it.currency, units: it.units, units_per_pack: it.units_per_pack, qty: 1,
        platform_price: it.platform_price ? fa(inCurrency(it.platform_price, 'toman')) : ''
      };
      lines.push(l);
      paintLines();
      quoteLine(l);
      const q = $(`#q-${l.k}`, view);
      if (q) { q.focus(); q.select(); }
    }
  });

  /* ---------- events ---------- */
  view.oninput = (e) => {
    const el = e.target;
    if (el === dateIn) { draft.date = dateIn.value; hintDate(); requoteAll(); return; }
    if (el === timeIn) { requoteAll(); return; }
    const row = el.closest('.order-line');
    if (!row || !el.dataset.f) return;
    const l = lines.find((x) => x.k === Number(row.dataset.k));
    const f = el.dataset.f;
    if (f === 'qty') { const n = num(el.value); if (Number.isInteger(n) && n > 0) { l.qty = n; replaceLine(l); } }
    else if (f === 'units') { const n = num(el.value); if (Number.isInteger(n) && n > 0) { l.units = n; replaceLine(l); } }
    else if (f === 'saveListing') { l.saveListing = el.checked; replaceLine(l); }
    else { l[f] = el.value; if (f === 'manualPrice') paintTotals(); }
  };
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pl) {
      draft.platform = Number(b.dataset.pl);
      $$('[data-pl]', view).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      paintLines();
      return;
    }
    if (b.dataset.day !== undefined) { dateIn.value = jalaliToday(Number(b.dataset.day)); draft.date = dateIn.value; hintDate(); requoteAll(); timeIn.focus(); return; }
    if (b.hasAttribute('data-now')) { dateIn.value = jalaliToday(); timeIn.value = timeNow(); draft.date = dateIn.value; hintDate(); requoteAll(); return; }
    const row = b.closest('.order-line');
    if (!row) return;
    const l = lines.find((x) => x.k === Number(row.dataset.k));
    if (b.hasAttribute('data-remove')) { lines = lines.filter((x) => x !== l); paintLines(); $('#o-pick', view).focus(); }
    if (b.hasAttribute('data-manual')) { l.manual = true; replaceLine(l); const m = $(`#mp-${l.k}`, view); if (m) m.focus(); }
  };
  view.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); return; }
    // Enter in a line field jumps back to the picker for the next item
    if (e.key === 'Enter' && e.target.closest('.order-line') && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); $('#o-pick', view).focus(); }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(form);
    const errs = {};
    if (!readDate(dateIn.value)) errs.date = 'تاریخ را به شکل ۱۴۰۵/۰۸/۱۴ وارد کنید.';
    if (!readTime(timeIn.value)) errs.time = 'ساعت را به شکل ۱۴:۲۰ وارد کنید.';
    if (fieldErrors(form, errs)) return;
    if (!lines.length) { toast('دست‌کم یک کالا اضافه کنید.', { error: true }); $('#o-pick', view).focus(); return; }
    for (const l of lines) {
      if ((l.manual || (l.quote && !l.quote.price)) && (!num(l.manualPrice) || !String(l.reason || '').trim())) {
        toast(`برای «${l.name}» قیمت دستی و دلیل را وارد کنید.`, { error: true });
        const m = $(`#mp-${l.k}`, view) || $(`#q-${l.k}`, view);
        if (m) m.focus();
        return;
      }
    }
    const btn = $('#o-save', view);
    busy(btn, true, 'در حال ثبت…');
    try {
      // Listings asked for during entry are created first, so the order line points at them
      for (const l of lines.filter((x) => x.saveListing && !x.listing_id)) {
        const r = await post('/listings', { platform_id: platformId(), product_id: l.product_id, code: latin(l.listingCode || '').trim() || null, title: l.name, units: l.units });
        l.listing_id = r.listing.id;
      }
      const body = {
        platform_id: platformId(), order_number: latin(v.order_number).trim() || null, ordered_at: orderedAt(), customer: v.customer, note: v.note,
        lines: lines.map((l) => ({
          listing_id: l.listing_id || undefined, product_id: l.listing_id ? undefined : l.product_id, qty: l.qty, units_per_sale: l.listing_id ? undefined : l.units,
          platform_price: latin(l.platform_price || '').replace(/[,،٬\s]/g, '') || null,
          site_price_manual: l.manual || (l.quote && !l.quote.price) ? latin(l.manualPrice).replace(/[,،٬\s]/g, '') : null,
          reason: l.reason || null
        }))
      };
      const r = await post('/orders', body);
      toast(`سفارش ${r.order.order_number || ''} ثبت شد.`, { action: 'مشاهده', onAction: () => ctx.go(`#/orders/${r.order.id}`) });
      lines = [];
      form.elements.order_number.value = '';
      timeIn.value = '';
      form.elements.customer.value = '';
      form.elements.note.value = '';
      paintLines();
      form.elements.order_number.focus();
      ctx.refreshCounts();
    } catch (err) {
      if (err.code === 'duplicate_order' && err.fields) {
        fieldErrors(form, err.fields);
        const f = $('#o-number', view).closest('.field');
        const a = document.createElement('a');
        a.className = 'link small'; a.href = `#/orders/${err.existing_id}`; a.textContent = 'دیدن سفارش ثبت‌شده';
        f.appendChild(a);
      } else showError(form, err);
    } finally {
      busy(btn, false);
    }
  });

  paintLines();
  // Start where the next order begins: its number (platform and date carry over)
  $('#o-number', view).focus();
}

/* ======================================================================== one order */
async function renderOne(view, ctx, id) {
  view.innerHTML = skeleton(5);
  let d = null;
  async function load() { d = await get(`/orders/${id}`); paint(); }
  function paint() {
    const o = d.order;
    document.title = `سفارش ${o.order_number || o.id} | انبار`;
    const byCompany = new Map();
    for (const l of d.lines) {
      const k = `${l.company_name}|${l.currency}`;
      byCompany.set(k, (byCompany.get(k) || 0) + l.qty * l.settle_unit_price);
    }
    view.innerHTML = `
      <div><a class="back" href="#/orders">${icon('back')}سفارش‌ها</a>
        <div class="page-head">
          <div><div class="title-row"><h1>${esc(o.platform_name)} ${o.order_number ? `<span class="ltr">${esc(faDigits(o.order_number))}</span>` : `#${fa(o.id)}`}</h1>
            ${o.cancelled_at ? '<span class="badge">لغوشده</span>' : d.lines.some((l) => l.status === 'pending') ? '<span class="badge badge-orange">منتظر دریافت</span>' : '<span class="badge badge-green">انجام شد</span>'}</div>
            <div class="cell-meta" style="font-size:13.5px"><span>زمان سفارش: ${when(o.ordered_at, 'full')}</span>${o.customer ? `<span>مشتری: ${esc(o.customer)}</span>` : ''}
              <span>ثبت: ${esc(o.created_by_name || 'سیستم')} ${when(o.created_at)}</span>${o.source === 'import' ? '<span class="badge">از فایل</span>' : ''}</div>
            ${o.note ? `<p class="small muted">${esc(o.note)}</p>` : ''}${o.cancelled_at ? `<p class="small" style="color:var(--red)">لغو: ${esc(o.cancel_reason || '')}</p>` : ''}</div>
          <div class="page-actions">${!o.cancelled_at ? `<button class="btn" type="button" data-add>${icon('plus')}افزودن کالا</button><button class="btn btn-ghost" type="button" data-cancel>${icon('x')}لغو سفارش</button>` : ''}</div>
        </div></div>
      <section class="card card-flush" aria-labelledby="h-ol"><div class="card-head"><h2 id="h-ol">کالاها</h2></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th scope="col">کالا</th><th scope="col" class="col-num">تعداد</th><th scope="col" class="col-num">قیمت سایت در ساعت سفارش</th><th scope="col" class="col-num">مبلغ برای شرکت</th><th scope="col">دریافت</th><th scope="col" class="col-actions"><span class="sr-only">کارها</span></th></tr></thead>
          <tbody>${d.lines.map((l) => `<tr>
            <td class="cell-main"><div class="cell-title"><a href="#/products/${l.product_id}">${esc(l.product_name)}</a>
              <div class="cell-meta"><span>${esc(l.company_name)}</span>${l.listing_code ? `<span class="badge badge-blue">آگهی ${esc(l.listing_code)}</span>` : ''}
              ${l.platform_price ? `<span>قیمت پلتفرم: ${moneyText(l.platform_price, 'toman')}</span>` : ''}</div></div></td>
            <td class="col-num" data-label="تعداد">${fa(l.qty)} × ${fa(l.units_per_sale)} = <b>${fa(l.units_total)}</b> عدد</td>
            <td class="col-num" data-label="قیمت سایت"><span class="price">${money(l.site_price, l.currency)}</span>
              <div class="small muted">${l.site_price_source === 'manual' ? '<span class="badge badge-orange">دستی</span>' : `${esc(smartTime(l.site_price_at))} ${sourceBadge(l.site_price_source)}`}${l.units_per_sale !== l.units_per_pack ? ` · ${fa(l.units_per_sale)} از ${fa(l.units_per_pack)}` : ''}</div>
              ${l.price_uncertain ? '<div class="small" style="color:var(--amber)">نامطمئن: سایت بعد از زمان سفارش بررسی نشده بود</div>' : ''}</td>
            <td class="col-num" data-label="مبلغ برای شرکت"><span class="price">${money(l.qty * l.settle_unit_price, l.currency)}</span>
              ${l.settle_manual ? `<div class="small"><span class="badge badge-orange">دستی</span> ${esc(l.settle_reason || '')}</div>` : ''}</td>
            <td data-label="دریافت">${lineStatus(l)}${receiveDetails(l)}</td>
            <td class="col-actions"><button class="btn btn-sm" type="button" data-price="${l.id}">${icon('edit')}قیمت</button>
              ${l.units_from_company + l.units_from_stock > 0 ? `<button class="btn btn-sm btn-ghost" type="button" data-return="${l.id}">${icon('refresh')}مرجوعی</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>
        <div class="table-foot"><span>جمع برای شرکت‌ها</span><span>${[...byCompany].map(([k, v]) => { const [n, c] = k.split('|'); return `${esc(n)}: <b class="price">${moneyText(v, c)}</b>`; }).join(' · ')}</span></div>
      </section>
      <section class="card card-flush" aria-labelledby="h-oa"><div class="card-head"><h2 id="h-oa">سابقه‌ی این سفارش</h2></div>
        ${d.activity.length ? `<div class="timeline">${d.activity.map((a) => entryHtml(a)).join('')}</div>` : empty('pulse', 'سابقه‌ای نیست')}</section>`;
  }
  function receiveDetails(l) {
    if (l.status === 'pending') return '';
    const parts = [];
    if (l.units_from_company) parts.push(`${fa(l.units_from_company)} از شرکت`);
    if (l.units_from_stock) parts.push(`${fa(l.units_from_stock)} از انبار ما`);
    if (l.units_cancelled) parts.push(`${fa(l.units_cancelled)} لغو`);
    const extra = l.arrivals.filter((a) => a.disposition !== 'shipped').map((a) => `${fa(a.units)} عدد «${esc(a.product_name || a.description || '')}» ${a.disposition === 'stock' ? `به انبار ${esc(a.warehouse_name || '')}` : 'برگشت به شرکت'}`);
    return `<div class="small muted">${parts.join('، ')}${extra.length ? `<br>${extra.join('<br>')}` : ''}${l.received_by_name ? `<br>${esc(l.received_by_name)} ${when(l.received_at)}` : ''}</div>`;
  }

  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.price) return priceSheet(d.lines.find((l) => l.id === Number(b.dataset.price)));
    if (b.dataset.return) {
      const [{ newReturn }, { items: warehouses }] = await Promise.all([import('./returns.js'), get('/warehouses')]);
      return newReturn(ctx, warehouses, load, { orderId: id, lineId: Number(b.dataset.return) });
    }
    if (b.hasAttribute('data-cancel')) {
      const body = openSheet('لغو سفارش', `<form class="form" id="f-cancel" novalidate>
        <p class="muted small">ردیف‌های منتظر دریافت لغو می‌شوند. اگر ردیفی دریافت شده، اول از «دریافت روزانه» آن را برگردانید.</p>
        <div class="field"><label for="c-reason">دلیل لغو</label><input id="c-reason" name="reason" required placeholder="مثلاً: مشتری در دیجی‌کالا لغو کرد"></div>
        <div class="form-actions"><button class="btn btn-danger" type="submit">لغو سفارش</button></div></form>`);
      const f = $('#f-cancel', body);
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!f.elements.reason.value.trim()) { fieldErrors(f, { reason: 'دلیل را بنویسید.' }); return; }
        try { d = await post(`/orders/${id}/cancel`, { reason: f.elements.reason.value.trim() }); closeSheet(); paint(); toast('سفارش لغو شد.'); } catch (err) { showError(f, err); }
      });
    }
    if (b.hasAttribute('data-add')) addSheet();
  };

  function priceSheet(l) {
    const cur = CURRENCY[l.currency];
    const body = openSheet('تغییر دستی قیمت', `<form class="form" id="f-price" novalidate>
      <p><b>${esc(l.product_name)}</b><br><span class="small muted">${fa(l.units_per_sale)} عدد در هر فروش از بسته‌ی ${fa(l.units_per_pack)} عددی · ${fa(l.qty)} فروش</span></p>
      <div class="callout callout-warn small">${icon('info')}<span>با نام شما و دلیلی که می‌نویسید در سابقه‌ی سفارش و گزارش فعالیت ثبت می‌شود.</span></div>
      <div class="field"><label for="p-site">قیمت سایت در ساعت سفارش (کل بسته، ${cur})</label><input id="p-site" name="site_price" inputmode="numeric" value="${fa(inCurrency(l.site_price, l.currency))}">
        <span class="hint">با تغییر آن، مبلغ هر فروش دوباره حساب می‌شود.</span></div>
      <div class="field"><label for="p-settle">یا مستقیم: مبلغ هر فروش برای شرکت (${cur})</label><input id="p-settle" name="settle_unit_price" inputmode="numeric" value="${fa(inCurrency(l.settle_unit_price, l.currency))}">
        <span class="hint">مثلاً وقتی بخشی از بسته را به قیمت توافقی فروخته‌اید.</span></div>
      <div class="field"><label for="p-reason">دلیل</label><input id="p-reason" name="reason" required></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">ذخیره</button></div></form>`);
    const f = $('#f-price', body);
    const site0 = f.elements.site_price.value, settle0 = f.elements.settle_unit_price.value;
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!f.elements.reason.value.trim()) { fieldErrors(f, { reason: 'دلیل را بنویسید.' }); return; }
      const clean = (s) => latin(s).replace(/[,،٬\s]/g, '');
      try {
        d = await put(`/order-lines/${l.id}/price`, {
          site_price: f.elements.site_price.value !== site0 ? clean(f.elements.site_price.value) : null,
          settle_unit_price: f.elements.settle_unit_price.value !== settle0 ? clean(f.elements.settle_unit_price.value) : null,
          reason: f.elements.reason.value.trim()
        });
        closeSheet(); paint(); toast('قیمت تغییر کرد.');
      } catch (err) { showError(f, err); }
    });
  }

  function addSheet() {
    const body = openSheet('افزودن کالا به سفارش', `<form class="form" id="f-addl" novalidate>
      <div class="picker"><label class="field-label" for="a-pick">کالا</label><div class="search">${icon('search')}<input id="a-pick" type="search" placeholder="کد آگهی، نام یا کد کالا…"></div></div>
      <div id="a-chosen"></div>
      <div class="field"><label for="a-qty">تعداد</label><input id="a-qty" name="qty" inputmode="numeric" value="۱"></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">افزودن</button></div></form>`);
    const f = $('#f-addl', body);
    let chosen = null;
    createPicker($('#a-pick', body), {
      params: () => ({ platform: d.order.platform_id }),
      onPick(it) { chosen = it; $('#a-chosen', body).innerHTML = `<div class="callout callout-info small">${icon('box')}<span>${esc(it.kind === 'listing' ? it.product_name : it.name)} — ${fa(it.units)} عدد در هر فروش</span></div>`; }
    });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!chosen) { toast('کالا را انتخاب کنید.', { error: true }); return; }
      try {
        d = await post(`/orders/${id}/lines`, { lines: [{ listing_id: chosen.kind === 'listing' ? chosen.listing_id : undefined, product_id: chosen.kind === 'listing' ? undefined : chosen.product_id, qty: latin(f.elements.qty.value) }] });
        closeSheet(); paint(); toast('کالا اضافه شد.');
      } catch (err) { showError(f, err); }
    });
  }

  await load();
  const off = ctx.subscribe('orders', (e) => { if ((e.ids || []).includes(id)) load().catch(() => {}); });
  return () => off();
}
