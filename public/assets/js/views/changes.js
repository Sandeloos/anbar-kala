/** Price (and stock) changes read from the company sites, newest first, live. */
import { get } from '../api.js';
import { $, $$, esc, icon, fa, money, delta, when, smartTime, skeleton, empty, sourceBadge, stockBadge, debounce, toast } from '../ui.js';

export async function render(view, ctx) {
  const f = { company: ctx.query.get('company') || '', kind: ctx.query.get('kind') || 'price', direction: ctx.query.get('direction') || '', page: ctx.query.get('page') || '' };
  const { items: companies } = await get('/companies');
  let data = null;

  view.innerHTML = `
    <div class="page-head"><div><h1>تغییرات قیمت</h1><p>هر تغییری که روی سایت شرکت‌ها انجام شود، با زمان دقیق و قیمت قبلی. این صفحه زنده است.</p></div></div>
    <div class="card toolbar">
      <select class="input" id="c-company" aria-label="شرکت"><option value="">همه‌ی شرکت‌ها</option>
        ${companies.map((c) => `<option value="${c.id}"${String(c.id) === f.company ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <div class="seg" role="group" aria-label="نوع تغییر">
        <button type="button" data-kind="price" aria-pressed="${f.kind === 'price'}">قیمت</button>
        <button type="button" data-kind="stock" aria-pressed="${f.kind === 'stock'}">موجودی</button>
        <button type="button" data-kind="all" aria-pressed="${f.kind === 'all'}">همه</button>
      </div>
      <div class="seg" role="group" aria-label="جهت تغییر قیمت" id="c-dir" ${f.kind === 'stock' ? 'hidden' : ''}>
        <button type="button" data-dir="" aria-pressed="${!f.direction}">گرانی و ارزانی</button>
        <button type="button" data-dir="up" aria-pressed="${f.direction === 'up'}">${icon('up')}گران‌تر</button>
        <button type="button" data-dir="down" aria-pressed="${f.direction === 'down'}">${icon('dn')}ارزان‌تر</button>
      </div>
    </div>
    <section class="card card-flush" aria-label="فهرست تغییرات"><div id="c-list">${skeleton(8)}</div></section>`;

  function paint() {
    const box = $('#c-list', view);
    if (!data.items.length) {
      box.innerHTML = empty('trend', 'تغییری پیدا نشد', 'وقتی قیمت یا موجودی کالایی روی سایت شرکت عوض شود، همین‌جا با زمان دقیقش دیده می‌شود.');
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">کالا</th><th scope="col" class="col-num">قیمت قبلی</th><th scope="col" class="col-num">قیمت جدید</th><th scope="col">موجودی</th><th scope="col">زمان تغییر در سایت</th><th scope="col">منبع</th></tr></thead>
      <tbody>${data.items.map((h) => `<tr data-id="${h.id}">
        <td class="cell-main"><div class="cell-title"><a href="#/products/${h.product_id}">${esc(h.name)}</a><div class="cell-meta"><span>${esc(h.company_name)}</span>${h.units_per_pack > 1 ? `<span>${fa(h.units_per_pack)} عددی</span>` : ''}</div></div></td>
        <td class="col-num" data-label="قیمت قبلی">${h.price_changed ? `<span class="strike">${money(h.prev_regular_price, h.currency)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="col-num" data-label="قیمت جدید"><span class="price">${money(h.regular_price, h.currency)}</span> ${h.price_changed ? delta(h.prev_regular_price, h.regular_price) : ''}</td>
        <td data-label="موجودی">${h.stock_changed && h.prev_stock_status ? `${stockBadge({ stock_status: h.prev_stock_status, stock_quantity: h.prev_stock_quantity })} ← ` : ''}${stockBadge(h)}</td>
        <td data-label="زمان تغییر">${when(h.effective_at, 'full')}${h.observed_at.slice(0, 16) !== h.effective_at.slice(0, 16) ? `<div class="small muted">دیده‌شده: ${esc(smartTime(h.observed_at))}</div>` : ''}</td>
        <td data-label="منبع">${sourceBadge(h.source)}${h.user_name ? ` <span class="small muted">${esc(h.user_name)}</span>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
      <div class="table-foot"><span>${fa(data.total)} تغییر</span><div class="pager">
        <button class="icon-btn sm" type="button" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''} aria-label="صفحه‌ی قبل">${icon('back')}</button>
        <span>صفحه‌ی ${fa(data.page)} از ${fa(data.pages)}</span>
        <button class="icon-btn sm" type="button" data-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''} aria-label="صفحه‌ی بعد">${icon('next')}</button></div></div>`;
  }
  async function load(flashNew = false) {
    ctx.setQuery(f);
    const before = data ? new Set(data.items.map((i) => i.id)) : null;
    try {
      data = await get('/changes', f);
      paint();
      if (flashNew && before) data.items.forEach((i) => { if (!before.has(i.id)) { const tr = $(`tr[data-id="${i.id}"]`, view); if (tr) tr.classList.add('is-flash'); } });
    } catch (err) { $('#c-list', view).innerHTML = empty('alert', 'فهرست تغییرات نیامد', err.message); }
  }

  $('#c-company', view).addEventListener('change', (e) => { f.company = e.target.value; f.page = ''; load(); });
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.kind) {
      f.kind = b.dataset.kind; f.page = '';
      $$('[data-kind]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('#c-dir', view).hidden = f.kind === 'stock';
      if (f.kind === 'stock') f.direction = '';
      load();
    } else if (b.dataset.dir !== undefined) {
      f.direction = b.dataset.dir; f.page = '';
      $$('[data-dir]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      load();
    } else if (b.dataset.page) { f.page = b.dataset.page === '1' ? '' : b.dataset.page; load(); }
  };

  await load();
  const reload = debounce(() => { if (!f.page || f.page === '1') load(true); }, 700);
  const off = ctx.subscribe('products', (e) => {
    if ((f.kind === 'stock' ? e.stockChanges : f.kind === 'all' ? e.priceChanges || e.stockChanges : e.priceChanges)) {
      reload();
      if (f.page && f.page !== '1') toast('تغییر تازه‌ای رسید؛ برای دیدنش به صفحه‌ی اول بروید.');
    }
  });
  return () => off();
}
