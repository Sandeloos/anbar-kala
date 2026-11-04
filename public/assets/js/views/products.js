/**
 * Products: the searchable list of every sellable item of every company
 * (#/products?…filters) with inline "units per pack" editing and bulk changes,
 * and one product (#/products/:id): live price, price chart and history,
 * our settings for it, refresh from the site, manual price.
 */
import { get, post, put } from '../api.js';
import {
  $, $$, esc, icon, fa, money, moneyText, delta, when, ago, skeleton, empty, toast, openSheet, closeSheet, fieldErrors, showError,
  formValues, busy, debounce, stockBadge, sourceBadge, latin, inCurrency, CURRENCY, SITE_STATUS, prettyUrl, smartTime, dateTime, confirm, faDigits
} from '../ui.js';

export async function render(view, ctx, params) {
  if (params[0]) return renderOne(view, ctx, Number(params[0]));
  return renderList(view, ctx);
}

/* ======================================================================== list */
const FILTER_KEYS = ['q', 'company', 'stock', 'setup', 'changed', 'packs', 'manual', 'status', 'sort', 'dir', 'page'];

async function renderList(view, ctx) {
  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, ctx.query.get(k) || '']));
  const [{ items: companies }, { items: warehouses }] = await Promise.all([get('/companies'), get('/warehouses')]);
  const selected = new Set();
  let data = { items: [], total: 0, page: 1, pages: 1 };
  let token = 0;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>کالاها</h1><p>همه‌ی کالاهای سایت شرکت‌ها؛ نام، لینک و قیمت دقیقاً همان است که روی سایت است.</p></div>
      <div class="page-actions"><button class="btn btn-primary" type="button" data-lookup>${icon('link')}افزودن با لینک کالا</button></div>
    </div>
    <div class="card" style="display:grid;gap:12px">
      <div class="toolbar">
        <label class="search"><span class="sr-only">جستجوی کالا</span>${icon('search')}
          <input type="search" id="p-q" value="${esc(f.q)}" placeholder="نام، کد کالا (SKU) یا لینک کالا را بنویسید…" autocomplete="off"></label>
        <select class="input" id="p-company" aria-label="شرکت"><option value="">همه‌ی شرکت‌ها</option>
          ${companies.map((c) => `<option value="${c.id}"${String(c.id) === f.company ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <div class="seg" role="group" aria-label="وضعیت تنظیم">
          <button type="button" data-setup="" aria-pressed="${!f.setup}">همه</button>
          <button type="button" data-setup="todo" aria-pressed="${f.setup === 'todo'}">منتظر تنظیم</button>
          <button type="button" data-setup="guessed" aria-pressed="${f.setup === 'guessed'}" title="تعداد در بسته از روی نام کالا پیشنهاد شده">پیشنهاد از نام</button>
          <button type="button" data-setup="done" aria-pressed="${f.setup === 'done'}">تنظیم‌شده</button>
        </div>
      </div>
      <div class="chips" role="group" aria-label="فیلترها">
        <button class="chip" type="button" data-toggle="stock" data-value="outofstock" aria-pressed="${f.stock === 'outofstock'}">ناموجود در سایت</button>
        <button class="chip" type="button" data-toggle="changed" data-value="24h" aria-pressed="${f.changed === '24h'}">قیمتش امروز عوض شده</button>
        <button class="chip" type="button" data-toggle="packs" data-value="multi" aria-pressed="${f.packs === 'multi'}">بسته‌ی چندتایی</button>
        <button class="chip" type="button" data-toggle="manual" data-value="1" aria-pressed="${f.manual === '1'}">قیمت دستی</button>
        <button class="chip" type="button" data-toggle="status" data-value="removed" aria-pressed="${f.status === 'removed'}">حذف‌شده از سایت</button>
      </div>
    </div>
    <div id="p-new" hidden></div>
    <section class="card card-flush" aria-label="فهرست کالاها"><div id="p-table">${skeleton(8)}</div></section>
    <div id="p-bulk"></div>`;

  const sortHead = (key, label, cls = '') => {
    const active = (f.sort || 'name') === key;
    const dir = active ? (f.dir === 'desc' ? 'descending' : 'ascending') : 'none';
    return `<th scope="col" class="${cls}" aria-sort="${dir}"><button type="button" data-sort="${key}">${label}${active ? icon(f.dir === 'desc' ? 'dn' : 'up') : ''}</button></th>`;
  };

  function rowHtml(p) {
    const checked = selected.has(p.id);
    const status = p.removed_at ? '<span class="badge badge-red">حذف از سایت</span>'
      : p.site_status && p.site_status !== 'publish' ? `<span class="badge badge-amber">${esc(SITE_STATUS[p.site_status] || p.site_status)}</span>` : '';
    return `<tr data-id="${p.id}" class="${checked ? 'is-selected' : ''}${p.removed_at ? ' is-removed' : ''}">
      <td class="col-check"><input type="checkbox" class="row-check" aria-label="انتخاب ${esc(p.name)}" ${checked ? 'checked' : ''}></td>
      <td class="cell-main"><div class="cell-title"><a href="#/products/${p.id}">${esc(p.name)}</a>
        <div class="cell-meta"><span>${esc(p.company_name)}</span>${p.sku ? `<span class="ltr">${esc(p.sku)}</span>` : ''}${status}
        ${!p.configured_at ? '<span class="badge badge-orange">منتظر تنظیم</span>' : ''}</div></div></td>
      <td class="col-num" data-label="قیمت سایت"><span class="price">${money(p.regular_price, p.currency)}</span>
        ${p.sale_price ? `<div class="small muted">با تخفیف ${moneyText(p.sale_price, p.currency)}</div>` : ''}
        ${p.price_source === 'manual' ? '<div><span class="badge badge-orange">ثبت دستی</span></div>' : ''}</td>
      <td data-label="موجودی سایت">${stockBadge(p)}</td>
      <td data-label="تعداد در بسته"><input class="pack-input" type="text" inputmode="numeric" value="${fa(p.units_per_pack)}" data-pack aria-label="تعداد در هر بسته‌ی ${esc(p.name)}" title="هر بار فروش این کالا چند عدد است؟ (Enter: ذخیره و رفتن به ردیف بعد)">
        ${!p.configured_at && p.units_guessed ? '<div class="small muted">از روی نام</div>' : ''}</td>
      <td data-label="آخرین تغییر" class="hide-sm">${when(p.last_changed_at)}</td>
      <td class="col-actions">${!p.configured_at ? `<button class="btn btn-sm btn-soft" type="button" data-confirm title="تعداد در بسته درست است؛ تأیید کن">${icon('check')}تأیید</button>` : ''}
        ${p.permalink ? `<a class="icon-btn sm" href="${esc(p.permalink)}" target="_blank" rel="noopener noreferrer" aria-label="دیدن در سایت شرکت" title="دیدن در سایت شرکت">${icon('external')}</a>` : ''}</td>
    </tr>`;
  }

  function paintTable() {
    const box = $('#p-table', view);
    if (!data.items.length) {
      const filtered = FILTER_KEYS.some((k) => k !== 'page' && k !== 'sort' && k !== 'dir' && f[k]);
      box.innerHTML = companies.length
        ? empty('box', filtered ? 'کالایی با این فیلترها پیدا نشد' : 'هنوز کالایی خوانده نشده',
          filtered ? (/^https?:\/\//i.test(f.q) ? 'این لینک بین کالاهای خوانده‌شده نیست. با «افزودن با لینک کالا» آن را مستقیم از سایت بخوانید.' : 'فیلترها را کمتر کنید یا جستجو را عوض کنید.') : 'کالاها بعد از اولین همگام‌سازی شرکت‌ها اینجا می‌آیند.',
          /^https?:\/\//i.test(f.q) ? `<button class="btn btn-primary" type="button" data-lookup-q>${icon('link')}خواندن این لینک از سایت</button>` : '')
        : empty('building', 'اول یک شرکت اضافه کنید', 'کالاها از سایت ووکامرس شرکت‌ها خوانده می‌شوند.', '<a class="btn btn-primary" href="#/companies/new">افزودن شرکت</a>');
      return;
    }
    const allOnPage = data.items.every((p) => selected.has(p.id));
    const guessBar = f.setup === 'guessed' ? `<div class="callout callout-info" style="margin:12px">${icon('info')}<div style="flex:1">
        تعداد در بسته‌ی این ${fa(data.total)} کالا از روی نامشان خوانده شده (مثلاً «بسته ۱۰۰ عددی» ← ۱۰۰). چند تا را نگاه کنید؛ اگر درست است همه را یک‌جا تأیید کنید. هر کدام اشتباه بود همین‌جا عددش را عوض کنید.
        <div style="margin-top:8px"><button class="btn btn-sm btn-primary" type="button" data-confirm-guessed>${icon('check')}تأیید همه‌ی ${fa(data.total)} پیشنهاد${f.company ? ' این شرکت' : ''}</button></div></div></div>` : '';
    box.innerHTML = `${guessBar}<div class="table-wrap"><table class="table">
      <caption class="sr-only">کالاها، ${fa(data.total)} مورد</caption>
      <thead><tr>
        <th scope="col" class="col-check"><input type="checkbox" id="check-page" aria-label="انتخاب همه‌ی این صفحه" ${allOnPage ? 'checked' : ''}></th>
        ${sortHead('name', 'کالا')}${sortHead('price', 'قیمت سایت', 'col-num')}${sortHead('stock', 'موجودی سایت')}
        <th scope="col">تعداد در بسته</th>${sortHead('changed', 'آخرین تغییر')}<th scope="col" class="col-actions"><span class="sr-only">کارها</span></th>
      </tr></thead>
      <tbody>${data.items.map(rowHtml).join('')}</tbody></table></div>${pagerHtml()}`;
  }
  const pagerHtml = () => `<div class="table-foot"><span>${fa(data.total)} کالا</span>
    <div class="pager" role="navigation" aria-label="صفحه‌ها">
      <button class="icon-btn sm" type="button" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''} aria-label="صفحه‌ی قبل">${icon('back')}</button>
      <span>صفحه‌ی ${fa(data.page)} از ${fa(data.pages)}</span>
      <button class="icon-btn sm" type="button" data-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''} aria-label="صفحه‌ی بعد">${icon('next')}</button>
    </div></div>`;

  function paintBulk() {
    const box = $('#p-bulk', view);
    if (!selected.size) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="bulk" role="region" aria-label="تغییر گروهی">
      <strong>${fa(selected.size)} کالا انتخاب شده</strong>
      <label class="sr-only" for="bulk-pack">تعداد در بسته برای همه</label>
      <input id="bulk-pack" inputmode="numeric" placeholder="تعداد در بسته">
      <button class="btn btn-accent" type="button" data-bulk="pack">اعمال تعداد</button>
      <label class="sr-only" for="bulk-wh">انبار اضافه‌ها برای همه</label>
      <select id="bulk-wh"><option value="">انبار اضافه‌ها…</option><option value="company">پیش‌فرض شرکت</option>${warehouses.filter((w) => w.active).map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
      <button class="btn" type="button" data-bulk="wh">اعمال انبار</button>
      <button class="btn" type="button" data-bulk="confirm">${icon('check')}تأیید تنظیمات</button>
      <button class="btn btn-ghost" type="button" data-bulk="clear">لغو انتخاب</button>
    </div>`;
  }

  async function load({ keepScroll = false } = {}) {
    const t = ++token;
    ctx.setQuery(f);
    const q = { ...f, per: 50 };
    try {
      const r = await get('/products', q);
      if (t !== token) return;
      data = r;
      paintTable();
      if (!keepScroll) $('#p-table', view).scrollIntoView({ block: 'nearest' });
    } catch (err) {
      if (t === token) $('#p-table', view).innerHTML = empty('alert', 'فهرست کالاها نیامد', err.message);
    }
  }

  /** Saves one product's settings (used by the inline pack field and the confirm button). */
  async function saveRow(p, units) {
    const r = await put(`/products/${p.id}`, { units_per_pack: units, warehouse_id: p.warehouse_id ?? '', tracked: !!p.tracked, note: p.note || '' });
    Object.assign(p, r.product);
    return p;
  }
  function replaceRow(p, flash) {
    const tr = $(`tr[data-id="${p.id}"]`, view);
    if (!tr) return;
    const focused = document.activeElement && tr.contains(document.activeElement);
    if (focused) return;
    tr.outerHTML = rowHtml(p);
    if (flash) { const n = $(`tr[data-id="${p.id}"]`, view); n.classList.add('is-flash'); }
  }

  /* ---------- events ---------- */
  const search = debounce(() => { f.q = $('#p-q', view).value.trim(); f.page = ''; load(); }, 250);
  $('#p-q', view).addEventListener('input', search);
  $('#p-q', view).addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; search(); } });
  $('#p-company', view).addEventListener('change', (e) => { f.company = e.target.value; f.page = ''; load(); });

  view.onclick = async (e) => {
    const b = e.target.closest('button, input[type=checkbox]');
    if (!b) return;
    if (b.dataset.setup !== undefined) {
      f.setup = b.dataset.setup; f.page = '';
      $$('[data-setup]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      return load();
    }
    if (b.dataset.toggle) {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      f[b.dataset.toggle] = on ? b.dataset.value : '';
      f.page = '';
      return load();
    }
    if (b.dataset.sort) {
      if ((f.sort || 'name') === b.dataset.sort) f.dir = f.dir === 'desc' ? '' : 'desc';
      else { f.sort = b.dataset.sort; f.dir = b.dataset.sort === 'changed' ? 'desc' : ''; }
      f.page = '';
      return load({ keepScroll: true });
    }
    if (b.dataset.page) { f.page = b.dataset.page === '1' ? '' : b.dataset.page; return load(); }
    if (b.hasAttribute('data-lookup')) return lookupSheet(ctx);
    if (b.hasAttribute('data-lookup-q')) return lookupSheet(ctx, f.q);
    if (b.id === 'check-page') {
      data.items.forEach((p) => (b.checked ? selected.add(p.id) : selected.delete(p.id)));
      paintTable(); paintBulk();
      return;
    }
    if (b.classList.contains('row-check')) {
      const id = Number(b.closest('tr').dataset.id);
      if (b.checked) selected.add(id); else selected.delete(id);
      b.closest('tr').classList.toggle('is-selected', b.checked);
      const all = $('#check-page', view);
      if (all) all.checked = data.items.every((p) => selected.has(p.id));
      paintBulk();
      return;
    }
    if (b.hasAttribute('data-confirm')) {
      const p = data.items.find((x) => x.id === Number(b.closest('tr').dataset.id));
      busy(b, true);
      try { await saveRow(p, p.units_per_pack); replaceRow(p, true); ctx.refreshCounts(); } catch (err) { toast(err.message, { error: true }); busy(b, false); }
      return;
    }
    if (b.dataset.bulk) return bulk(b);
    if (b.hasAttribute('data-confirm-guessed')) {
      if (!(await confirm({ title: `${fa(data.total)} پیشنهاد تأیید شود؟`, text: 'برای هر کالا یک ردیف در گزارش فعالیت به نام شما ثبت می‌شود. بعداً هم می‌شود هر کدام را عوض کرد.', yes: 'تأیید همه' }))) return;
      busy(b, true);
      try {
        const r = await post('/products/confirm-guessed', { company: f.company || null });
        toast(`${fa(r.updated)} کالا تأیید شد.`);
        f.setup = 'todo';
        $$('[data-setup]', view).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.setup === 'todo')));
        await load();
        ctx.refreshCounts();
      } catch (err) { toast(err.message, { error: true }); busy(b, false); }
    }
  };

  async function bulk(b) {
    const ids = [...selected];
    const body = { ids };
    if (b.dataset.bulk === 'clear') { selected.clear(); paintTable(); paintBulk(); return; }
    if (b.dataset.bulk === 'pack') {
      const n = Number(latin($('#bulk-pack', view).value).replace(/[,،\s]/g, ''));
      if (!Number.isInteger(n) || n < 1) { toast('تعداد در بسته را درست وارد کنید (عدد صحیح، حداقل ۱).', { error: true }); $('#bulk-pack', view).focus(); return; }
      body.units_per_pack = n;
    } else if (b.dataset.bulk === 'wh') {
      const v = $('#bulk-wh', view).value;
      if (!v) { toast('انبار را انتخاب کنید.', { error: true }); return; }
      body.warehouse_id = v === 'company' ? null : Number(v);
    }
    busy(b, true);
    try {
      const r = await put('/products/bulk', body);
      toast(`${fa(r.updated)} کالا به‌روز شد.`);
      selected.clear();
      paintBulk();
      await load({ keepScroll: true });
      ctx.refreshCounts();
    } catch (err) { toast(err.message, { error: true }); busy(b, false); }
  }

  // Inline "units per pack": Enter saves and jumps to the next row, Escape restores
  view.onkeydown = (e) => {
    const input = e.target.closest('[data-pack]');
    if (!input) return;
    if (e.key === 'Escape') { const p = data.items.find((x) => x.id === Number(input.closest('tr').dataset.id)); input.value = fa(p.units_per_pack); input.blur(); }
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.altKey) || e.key === 'ArrowUp') {
      e.preventDefault();
      const inputs = $$('[data-pack]', view);
      const i = inputs.indexOf(input);
      const next = inputs[e.key === 'ArrowUp' ? i - 1 : i + 1];
      if (next) { next.focus(); next.select(); } else input.blur();
    }
  };
  view.addEventListener('focusin', (e) => { if (e.target.matches('[data-pack]')) e.target.select(); });
  view.addEventListener('focusout', async (e) => {
    const input = e.target.closest && e.target.closest('[data-pack]');
    if (!input) return;
    const tr = input.closest('tr');
    const p = data.items.find((x) => x.id === Number(tr.dataset.id));
    const n = Number(latin(input.value).replace(/[,،\s]/g, ''));
    if (!Number.isInteger(n) || n < 1 || n > 100000) {
      input.classList.add('is-error');
      toast('تعداد در بسته باید عدد صحیح ۱ یا بیشتر باشد.', { error: true });
      input.value = fa(p.units_per_pack);
      setTimeout(() => input.classList.remove('is-error'), 1500);
      return;
    }
    if (n === p.units_per_pack && p.configured_at) { input.value = fa(n); return; }
    try {
      await saveRow(p, n);
      input.value = fa(n);
      input.classList.add('is-saved');
      setTimeout(() => { input.classList.remove('is-saved'); if (!tr.contains(document.activeElement)) replaceRow(p); }, 900);
      ctx.refreshCounts();
    } catch (err) {
      input.classList.add('is-error');
      toast(err.message, { error: true });
    }
  });

  /* ---------- live ---------- */
  let newCount = 0;
  const refreshRows = debounce(async (ids) => {
    const onPage = ids.filter((id) => data.items.some((p) => p.id === id));
    if (!onPage.length) return;
    const { items } = await get('/products/by-ids', { ids: onPage.join(',') }).catch(() => ({ items: [] }));
    for (const p of items) {
      const i = data.items.findIndex((x) => x.id === p.id);
      if (i >= 0) { data.items[i] = p; replaceRow(p, true); }
    }
  }, 300);
  let pending = new Set();
  const off = ctx.subscribe('products', (e) => {
    e.ids.forEach((id) => pending.add(id));
    const ids = [...pending];
    pending = new Set();
    refreshRows(ids);
    if (e.created) {
      newCount += e.created;
      const box = $('#p-new', view);
      box.hidden = false;
      box.innerHTML = `<div class="callout callout-info">${icon('info')}<span>${fa(newCount)} کالای جدید از سایت‌ها خوانده شد. <button class="link" type="button" data-reload-new>نمایش</button></span></div>`;
      $('[data-reload-new]', box).addEventListener('click', () => { newCount = 0; box.hidden = true; load(); });
    }
  });

  await load({ keepScroll: true });
  return () => off();
}

/* ======================================================================== lookup by link */
function lookupSheet(ctx, initial = '') {
  const body = openSheet('افزودن کالا با لینک', `<form class="form" id="f-lookup" novalidate>
      <p class="muted small">لینک کالا را از سایت شرکت کپی کنید. نرم‌افزار همان لحظه کالا را از سایت می‌خواند و نام، لینک و قیمتش را دقیقاً مثل سایت ثبت می‌کند. اگر کالا چند حالت (مثلاً بسته‌ی ۲۵ و ۱۰۰ تایی) داشته باشد، همه‌ی حالت‌ها می‌آیند.</p>
      <div class="field"><label for="l-url">لینک کالا</label><input id="l-url" name="url" dir="ltr" inputmode="url" placeholder="https://…/product/…" value="${esc(initial)}" required></div>
      <div id="l-result" aria-live="polite"></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('refresh')}خواندن از سایت</button></div>
    </form>`);
  const f = $('#f-lookup', body);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = f.elements.url.value.trim();
    if (!url) { fieldErrors(f, { url: 'لینک کالا را وارد کنید.' }); return; }
    const btn = $('button[type=submit]', f);
    busy(btn, true, 'در حال خواندن از سایت…');
    try {
      const r = await post('/products/lookup', { url });
      $('#l-result', body).innerHTML = `<div class="callout callout-ok">${icon('check')}<span>از سایت <b>${esc(r.company.name)}</b> خوانده شد.</span></div>
        <div class="list" style="margin-top:8px">${r.items.map((p) => `<a class="list-item" href="#/products/${p.id}" style="padding-inline:0">
          <span class="grow"><span class="title">${esc(p.name)}</span><span class="sub">${stockBadge(p)}${p.id === r.matched ? '<span class="badge badge-blue">همین لینک</span>' : ''}</span></span>
          <span class="price">${money(p.regular_price, p.currency)}</span></a>`).join('')}</div>`;
      $('#l-result', body).addEventListener('click', (ev) => { if (ev.target.closest('a')) closeSheet(); });
      if (r.items.length === 1) { closeSheet(); ctx.go(`#/products/${r.items[0].id}`); }
    } catch (err) {
      showError(f, err);
    } finally {
      busy(btn, false);
    }
  });
}

/* ======================================================================== one product */
async function renderOne(view, ctx, id) {
  view.innerHTML = skeleton(6);
  const { items: warehouses } = await get('/warehouses');
  let d = null;

  async function load() { d = await get(`/products/${id}`); paint(); }

  function paint() {
    const p = d.product;
    const cur = p.currency;
    const companyWh = warehouses.find((w) => w.id === p.company_warehouse_id);
    const status = p.removed_at ? `<span class="badge badge-red">از سایت حذف شده (${esc(ago(p.removed_at))})</span>`
      : p.site_status && p.site_status !== 'publish' ? `<span class="badge badge-amber">${esc(SITE_STATUS[p.site_status] || p.site_status)}</span>` : '';
    const prices = d.history.filter((h) => h.price_changed || h.source === 'import');
    const prev = prices[1] ? prices[1].regular_price : null;
    document.title = `${p.name} | انبار`;
    view.innerHTML = `
      <div><a class="back" href="#/products${p.company_id ? `?company=${p.company_id}` : ''}">${icon('back')}کالاها</a>
        <div class="page-head">
          <div style="min-width:0"><div class="title-row"><h1>${esc(p.name)}</h1>${status}</div>
            <div class="cell-meta" style="font-size:13.5px"><a class="link" href="#/companies/${p.company_id}">${esc(p.company_name)}</a>
              ${p.sku ? `<span>کد: <span class="ltr">${esc(p.sku)}</span></span>` : ''}<span>شناسه در سایت: <span class="ltr">${faDigits(p.woo_id)}</span></span>
              ${p.attributes ? `<span>${esc(p.attributes)}</span>` : ''}</div></div>
          <div class="page-actions">
            ${p.permalink ? `<a class="btn" href="${esc(p.permalink)}" target="_blank" rel="noopener noreferrer">${icon('external')}در سایت</a>` : ''}
            <button class="btn" type="button" data-refresh>${icon('refresh')}خواندن از سایت</button>
            <button class="btn" type="button" data-manual>${icon('edit')}ثبت دستی قیمت</button>
          </div>
        </div></div>
      <div class="grid grid-main">
        <div class="grid">
          <section class="card" aria-labelledby="h-price">
            <div class="price-hero">
              <div><h2 id="h-price" class="muted small" style="font-weight:600">قیمت سایت (قبل از تخفیف) — مبنای تسویه</h2>
                <div class="big">${money(p.regular_price, cur)} ${delta(prev, p.regular_price)}</div>
                <div class="sub">${p.sale_price ? `<span>با تخفیف روی سایت: ${moneyText(p.sale_price, cur)}</span>` : ''}
                  ${p.price_source === 'manual' ? '<span class="badge badge-orange">قیمت دستی ثبت شده</span>' : ''}
                  <span>آخرین بررسی: ${when(p.last_checked_at, 'ago')}</span></div></div>
              <div style="display:grid;gap:6px;justify-items:end">${stockBadge(p)}
                ${p.units_per_pack > 1 ? `<span class="small muted">هر عدد: ${moneyText(Math.round(p.regular_price / p.units_per_pack), cur)}</span>` : ''}</div>
            </div>
            <div class="chart" id="chart"></div>
          </section>
          <section class="card card-flush" aria-labelledby="h-hist">
            <div class="card-head"><div><h2 id="h-hist">تاریخچه‌ی قیمت و موجودی</h2><p>«از زمان» یعنی زمانی که تغییر روی سایت انجام شد؛ «ثبت در انبار» زمانی که نرم‌افزار آن را دید.</p></div></div>
            <div class="table-wrap"><table class="table">
              <thead><tr><th scope="col">از زمان</th><th scope="col" class="col-num">قیمت</th><th scope="col">موجودی</th><th scope="col">منبع</th><th scope="col">ثبت در انبار</th></tr></thead>
              <tbody>${d.history.map((h, i) => {
                const before = d.history.slice(i + 1).find((x) => x.price_changed || x.source === 'import');
                return `<tr>
                  <td class="cell-main">${when(h.effective_at, 'full')}</td>
                  <td class="col-num" data-label="قیمت"><span class="price">${money(h.regular_price, cur)}</span> ${h.price_changed && before ? delta(before.regular_price, h.regular_price) : ''}
                    ${h.price_changed ? '' : '<div class="small muted">بدون تغییر قیمت</div>'}</td>
                  <td data-label="موجودی">${stockBadge(h)}</td>
                  <td data-label="منبع">${sourceBadge(h.source)}${h.user_name ? ` <span class="small muted">${esc(h.user_name)}</span>` : ''}${h.note ? `<div class="small muted">${esc(h.note)}</div>` : ''}</td>
                  <td data-label="ثبت در انبار" class="small muted">${esc(smartTime(h.observed_at))}</td></tr>`;
              }).join('')}</tbody></table></div>
          </section>
        </div>
        <div class="grid">
          <section class="card" aria-labelledby="h-set">
            <div class="card-head"><div><h2 id="h-set">تنظیمات این کالا در انبار</h2><p>${p.configured_at ? `تأییدشده ${esc(ago(p.configured_at))}` : '<span class="badge badge-orange">منتظر تنظیم</span>'}</p></div></div>
            <form class="form" id="f-set" novalidate>
              <div class="field"><label for="s-pack">هر بار فروش این کالا چند عدد است؟</label>
                <div class="input-suffix"><input id="s-pack" name="units_per_pack" inputmode="numeric" value="${fa(p.units_per_pack)}" required><span>عدد</span></div>
                <span class="hint">مثلاً اگر این کالا «بسته‌ی ۱۰۰ عددی» است، ۱۰۰. برای حساب کردن فروش بخشی از بسته (مثلاً ۲۵ تا از ۱۰۰ تا) لازم است.</span></div>
              <div class="field"><label for="s-wh">اگر اضافه آمد، به کدام انبار برود؟</label>
                <select id="s-wh" name="warehouse_id"><option value="">پیش‌فرض شرکت (${esc(companyWh ? companyWh.name : '—')})</option>
                ${warehouses.filter((w) => w.active || w.id === p.warehouse_id).map((w) => `<option value="${w.id}"${w.id === p.warehouse_id ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
              <div class="field"><label for="s-note">یادداشت</label><textarea id="s-note" name="note" placeholder="مثلاً: این کالا در دیجی‌کالا ۲۵تایی فروخته می‌شود">${esc(p.note || '')}</textarea></div>
              <label class="switch"><span><strong>پیگیری قیمت</strong><small>خاموش یعنی این کالا در فهرست‌ها کم‌رنگ می‌شود (قیمتش همچنان ثبت می‌شود).</small></span><input type="checkbox" name="tracked" ${p.tracked ? 'checked' : ''}><i></i></label>
              <div class="form-actions"><button class="btn btn-primary" type="submit">${p.configured_at ? 'ذخیره' : 'ذخیره و تأیید'}</button></div>
            </form>
          </section>
          ${d.siblings.length ? `<section class="card" aria-labelledby="h-sib"><div class="card-head"><h2 id="h-sib">حالت‌های دیگر همین کالا</h2></div>
            <div class="list">${d.siblings.map((s) => `<a class="list-item" href="#/products/${s.id}" style="padding-inline:0"><span class="grow"><span class="title">${esc(s.attributes || s.name)}</span>
              <span class="sub">${stockBadge(s)}<span>${fa(s.units_per_pack)} عدد در بسته</span></span></span><span class="price">${money(s.regular_price, p.currency)}</span></a>`).join('')}</div></section>` : ''}
          <section class="card" aria-labelledby="h-site"><div class="card-head"><h2 id="h-site">مشخصات در سایت</h2></div>
            <dl class="kv">
              <div><dt>نام در سایت</dt><dd>${esc(p.name)}</dd></div>
              <div><dt>لینک</dt><dd>${p.permalink ? `<a class="link ltr small" href="${esc(p.permalink)}" target="_blank" rel="noopener noreferrer">${esc(prettyUrl(p.permalink).replace(/^https?:\/\/[^/]+/, ''))}</a>` : '—'}</dd></div>
              <div><dt>وضعیت انتشار</dt><dd>${esc(SITE_STATUS[p.site_status] || p.site_status || '—')}</dd></div>
              <div><dt>آخرین ویرایش در سایت</dt><dd>${when(p.site_modified_at, 'full')}</dd></div>
              <div><dt>مدیریت موجودی در سایت</dt><dd>${p.manage_stock ? 'بله' : 'خیر'}</dd></div>
            </dl></section>
          <section class="card card-flush" aria-labelledby="h-act"><div class="card-head"><h2 id="h-act">تغییرات تنظیمات</h2></div>
            ${d.activity.length ? `<div class="timeline">${d.activity.map((a) => `<div class="tl-item" style="grid-template-columns:1fr"><div>
              <div class="tl-head"><strong>${esc(a.user_name || 'سیستم')}</strong><small>${when(a.created_at)}</small></div>
              <div class="tl-summary">${esc(a.summary)}</div>${changesHtml(a.changes, cur)}</div></div>`).join('')}</div>` : empty('pulse', 'هنوز تغییری داده نشده')}
          </section>
        </div>
      </div>`;
    drawChart($('#chart', view), prices.slice().reverse(), cur);
  }

  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-refresh')) {
      busy(b, true, 'در حال خواندن…');
      try {
        const before = d.product.regular_price;
        d = await post(`/products/${id}/refresh`);
        paint();
        toast(d.product.regular_price !== before ? `قیمت تازه از سایت: ${moneyText(d.product.regular_price, d.product.currency)}` : 'از سایت خوانده شد؛ قیمت تغییری نکرده.');
      } catch (err) { toast(err.message, { error: true }); busy(b, false); }
      return;
    }
    if (b.hasAttribute('data-manual')) manualSheet();
  };
  view.onsubmit = async (e) => {
    if (e.target.id !== 'f-set') return;
    e.preventDefault();
    const f = e.target;
    const v = formValues(f);
    const n = Number(latin(v.units_per_pack).replace(/[,،\s]/g, ''));
    if (!Number.isInteger(n) || n < 1) { fieldErrors(f, { units_per_pack: 'عدد صحیح ۱ یا بیشتر وارد کنید.' }); return; }
    const btn = $('button[type=submit]', f);
    busy(btn, true);
    try {
      d = await put(`/products/${id}`, { ...v, units_per_pack: n });
      paint();
      toast('تنظیمات کالا ذخیره شد.');
      ctx.refreshCounts();
    } catch (err) { showError(f, err); busy(btn, false); }
  };

  function manualSheet() {
    const p = d.product;
    const cur = CURRENCY[p.currency];
    const body = openSheet('ثبت دستی قیمت', `<form class="form" id="f-man" novalidate>
      <div class="callout callout-warn small">${icon('info')}<span>فقط وقتی سایت در دسترس نیست یا قیمت سایت اشتباه است. قیمت دستی تا وقتی سایت قیمت دیگری نشان دهد معتبر است و با نام شما در گزارش فعالیت ثبت می‌شود.</span></div>
      <div class="field"><label for="m-price">قیمت قبل از تخفیف</label><div class="input-suffix"><input id="m-price" name="regular_price" inputmode="numeric" value="${p.regular_price !== null ? esc(fa(inCurrency(p.regular_price, p.currency))) : ''}" required><span>${cur}</span></div></div>
      <div class="field"><label for="m-sale">قیمت با تخفیف (اختیاری)</label><div class="input-suffix"><input id="m-sale" name="sale_price" inputmode="numeric"><span>${cur}</span></div></div>
      <div class="field"><label for="m-note">دلیل</label><input id="m-note" name="note" placeholder="مثلاً: سایت از ساعت ۱۰ از دسترس خارج بود" required></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت قیمت</button></div>
    </form>`);
    const f = $('#f-man', body);
    const num = (s) => latin(s).replace(/[,،٬\s]/g, '');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(f);
      const errs = {};
      if (!num(v.regular_price) || Number.isNaN(Number(num(v.regular_price)))) errs.regular_price = 'قیمت را به عدد وارد کنید.';
      if (!v.note.trim()) errs.note = 'دلیل ثبت دستی را بنویسید.';
      if (fieldErrors(f, errs)) return;
      const btn = $('button[type=submit]', f);
      busy(btn, true);
      try {
        d = await post(`/products/${id}/manual-price`, { regular_price: num(v.regular_price), sale_price: num(v.sale_price) || null, note: v.note.trim() });
        closeSheet();
        paint();
        toast('قیمت دستی ثبت شد.');
      } catch (err) { showError(f, err); busy(btn, false); }
    });
  }

  await load();
  const off = ctx.subscribe('products', (e) => { if (e.ids.includes(id)) load().then(() => toast('اطلاعات این کالا همین الان از سایت به‌روز شد.')).catch(() => {}); });
  return () => off();
}

function changesHtml(changes, currency) {
  if (!changes || !changes.length) return '';
  const fmt = (c, v) => (v === null || v === undefined ? '—' : c.field === 'regular_price' ? moneyText(v, currency) : typeof v === 'number' ? fa(v) : v);
  return `<dl class="changes">${changes.map((c) => `<div><dt>${esc(c.label)}</dt><dd><span class="from">${esc(fmt(c, c.from))}</span> ← <span class="to">${esc(fmt(c, c.to))}</span></dd></div>`).join('')}</dl>`;
}

/* ---------- price chart: a step line (a price holds until it changes), hover shows the value ---------- */
function drawChart(box, points, currency) {
  const pts = points.filter((p) => p.regular_price !== null);
  if (pts.length < 2) {
    box.innerHTML = `<p class="muted small" style="padding-top:8px">${pts.length ? 'از وقتی این کالا خوانده شده قیمتش عوض نشده؛ با اولین تغییر نمودار ساخته می‌شود.' : ''}</p>`;
    return;
  }
  const W = Math.max(280, Math.round(box.clientWidth || 640)), H = 180, padL = 8, padR = 64, padT = 10, padB = 24;
  const t0 = new Date(pts[0].effective_at).getTime();
  const t1 = Date.now();
  const vals = pts.map((p) => inCurrency(p.regular_price, currency));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo *= 0.95; hi *= 1.05; }
  const pad = (hi - lo) * 0.15;
  lo -= pad; hi += pad;
  // Time runs left → right like Iranian market charts; the price axis sits next to "now" on the right
  const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let d = '';
  pts.forEach((p, i) => {
    const px = x(new Date(p.effective_at).getTime());
    const py = y(vals[i]);
    d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
  });
  const endX = x(t1);
  d += `H${endX}`;
  const area = `${d}V${H - padB}H${x(t0)}Z`;
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const nf = new Intl.NumberFormat('fa-IR', { notation: 'compact', maximumFractionDigits: 1 });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="نمودار قیمت از ${esc(dateTime(pts[0].effective_at))} تا امروز؛ جزئیات در جدول تاریخچه">
      ${ticks.map((v) => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-text" x="${W - padR + 8}" y="${y(v) + 4}" text-anchor="start">${nf.format(v)}</text>`).join('')}
      <path class="area" d="${area}"/><path class="series" d="${d}" vector-effect="non-scaling-stroke"/>
      <line id="cross" class="grid-line" y1="${padT}" y2="${H - padB}" stroke-dasharray="3 3" style="display:none"/>
    </svg>
    <div class="cell-meta" dir="ltr" style="justify-content:space-between;padding-inline-end:64px"><span>${esc(smartTime(pts[0].effective_at))}</span><span>اکنون</span></div>
    <div class="chart-tip" hidden></div>`;
  const svg = $('svg', box);
  const tip = $('.chart-tip', box);
  const cross = $('#cross', box);
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const t = t0 + ((sx - padL) / (W - padL - padR)) * (t1 - t0);
    let idx = 0;
    for (let i = 0; i < pts.length; i++) if (new Date(pts[i].effective_at).getTime() <= t) idx = i;
    const p = pts[idx];
    cross.setAttribute('x1', sx); cross.setAttribute('x2', sx); cross.style.display = '';
    tip.hidden = false;
    tip.textContent = `${moneyText(p.regular_price, currency)} · از ${smartTime(p.effective_at)}`;
    tip.style.left = `${((sx / W) * r.width)}px`;
    tip.style.top = `${(y(vals[idx]) / H) * r.height}px`;
    tip.style.transform = `translate(${sx > W / 2 ? '-100%' : '0'}, -120%)`;
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.style.display = 'none'; });
}
