/**
 * Companies: the list (#/companies), adding one in two steps (#/companies/new:
 * connect to the WooCommerce site, then the company details) and one company
 * (#/companies/:id: connection health, live sync progress, the WordPress plugin, edit).
 */
import { get, post, put } from '../api.js';
import {
  $, esc, icon, fa, when, ago, skeleton, empty, toast, confirm, openSheet, closeSheet, fieldErrors, showError, formValues, busy,
  copy, colorFor, initials, CURRENCY, PRICE_UNIT, latin, debounce
} from '../ui.js';

const KIND = { full: 'کامل', incremental: 'تغییرات', refresh: 'یک کالا', webhook: 'افزونه' };

function syncState(c) {
  if (!c.active) return '<span class="state state-mute">غیرفعال</span>';
  if (c.sync_state === 'running') return '<span class="state state-run">در حال همگام‌سازی…</span>';
  if (c.sync_state === 'error') return '<span class="state state-err">خطا در اتصال</span>';
  if (c.sync_state === 'never') return '<span class="state state-mute">هنوز خوانده نشده</span>';
  return '<span class="state state-ok">وصل</span>';
}
const logo = (c) => `<span class="logo" style="background:${colorFor(c.site_url || c.name)}" aria-hidden="true">${esc(initials(c.name))}</span>`;
const unitOptions = (sel) => Object.entries(PRICE_UNIT).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v}</option>`).join('');
const currencyOptions = (sel) => Object.entries(CURRENCY).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v}</option>`).join('');
const warehouseOptions = (list, sel) => list.filter((w) => w.active || w.id === sel)
  .map((w) => `<option value="${w.id}"${w.id === sel ? ' selected' : ''}>${esc(w.name)}</option>`).join('');

const HOWTO = `<div class="howto">
  <strong>کلید API را چطور بسازم؟</strong>
  <ol>
    <li>در پیشخوان وردپرس سایت شرکت بروید به <b>ووکامرس ← پیکربندی (تنظیمات) ← پیشرفته ← REST API</b>.</li>
    <li>روی <b>افزودن کلید</b> بزنید، توضیح را «انبار» بگذارید و دسترسی را <b>خواندن</b> انتخاب کنید.</li>
    <li>کلید مصرف‌کننده (ck_…) و رمز مصرف‌کننده (cs_…) را همین‌جا وارد کنید. رمز فقط یک بار نشان داده می‌شود.</li>
  </ol>
  <span class="muted">نرم‌افزار فقط قیمت، موجودی، نام و لینک کالاها را می‌خواند و هیچ چیزی را در سایت تغییر نمی‌دهد.</span>
</div>`;

export async function render(view, ctx, params) {
  if (params[0] === 'new') return renderNew(view, ctx);
  if (params[0]) return renderOne(view, ctx, Number(params[0]));
  return renderList(view, ctx);
}

/* ------------------------------------------------------------ list */
async function renderList(view, ctx) {
  view.innerHTML = skeleton(4);
  async function load() {
    const { items } = await get('/companies');
    view.innerHTML = `
      <div class="page-head">
        <div><h1>شرکت‌ها</h1><p>شرکت‌های طرف قرارداد و اتصال به سایت ووکامرس هر کدام</p></div>
        <div class="page-actions"><a class="btn btn-primary" href="#/companies/new">${icon('plus')}شرکت جدید</a></div>
      </div>
      ${items.length ? `<div class="companies-grid">${items.map((c) => `
        <article class="card company-card">
          <div class="top">${logo(c)}<div style="min-width:0;flex:1">
            <h3><a href="#/companies/${c.id}">${esc(c.name)}</a></h3>
            <div class="site" title="${esc(c.site_url)}">${esc(c.site_url.replace(/^https?:\/\//, ''))}</div></div>
            ${syncState(c)}</div>
          <div class="stats">
            <div><strong>${fa(c.products)}</strong><span>کالا</span></div>
            <div><strong>${fa(c.needs_setup)}</strong><span>منتظر تنظیم</span></div>
            <div><strong>${fa(c.out_of_stock)}</strong><span>ناموجود</span></div>
          </div>
          ${c.sync_state === 'error' && c.sync_error ? `<div class="callout callout-err small">${icon('alert')}<span>${esc(c.sync_error)}</span></div>` : ''}
          <div class="foot">
            <span class="muted">آخرین خواندن: ${esc(ago(c.last_incremental_at || c.last_full_sync_at))}${c.last_webhook_at ? ' · افزونه فعال' : ''}</span>
            <span><a class="btn btn-sm" href="#/products?company=${c.id}">کالاها</a> <a class="btn btn-sm btn-soft" href="#/companies/${c.id}">جزئیات</a></span>
          </div>
        </article>`).join('')}</div>`
        : `<div class="card">${empty('building', 'هنوز شرکتی ثبت نشده', 'برای هر شرکت طرف قرارداد، آدرس سایت ووکامرس و کلید API آن را وارد کنید تا همه‌ی کالاها و قیمت‌هایش خودکار خوانده شود.', '<a class="btn btn-primary" href="#/companies/new">افزودن اولین شرکت</a>')}</div>`}`;
  }
  await load();
  const reload = debounce(() => load().catch(() => {}), 600);
  const offs = [ctx.subscribe('sync', (e) => { if (e.state !== 'progress') reload(); }), ctx.subscribe('company', reload)];
  return () => offs.forEach((f) => f());
}

/* ------------------------------------------------------------ new company */
async function renderNew(view, ctx) {
  const { items: warehouses } = await get('/warehouses');
  let found = null;
  view.innerHTML = `
    <div><a class="back" href="#/companies">${icon('back')}شرکت‌ها</a>
      <div class="page-head"><div><h1>شرکت جدید</h1><p>اول اتصال به سایت را بررسی می‌کنیم، بعد اطلاعات شرکت را ثبت می‌کنید.</p></div></div></div>
    <ol class="steps" aria-label="مراحل"><li class="step" id="st-1" aria-current="step"><b>۱</b>اتصال به سایت</li><li class="step" id="st-2"><b>۲</b>اطلاعات شرکت</li></ol>
    <div class="grid grid-main">
      <section class="card">
        <form id="f-connect" class="form" novalidate>
          <div class="field"><label for="c-site">آدرس سایت شرکت</label>
            <input id="c-site" name="site_url" dir="ltr" inputmode="url" placeholder="https://example.ir" autocomplete="off" required>
            <span class="hint">همان سایتی که قرارداد بر اساس قیمت‌های آن است.</span></div>
          <div class="form-row cols-2">
            <div class="field"><label for="c-key">کلید مصرف‌کننده (Consumer key)</label><input id="c-key" name="key" dir="ltr" placeholder="ck_…" autocomplete="off" spellcheck="false" required></div>
            <div class="field"><label for="c-secret">رمز مصرف‌کننده (Consumer secret)</label>
              <div class="input-wrap"><input id="c-secret" name="secret" type="password" dir="ltr" placeholder="cs_…" autocomplete="off" spellcheck="false" required>
              <button class="input-btn" type="button" data-reveal="c-secret" aria-label="نمایش رمز" aria-pressed="false">${icon('eye')}</button></div></div>
          </div>
          <div id="c-result" aria-live="polite"></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('plug')}بررسی اتصال</button></div>
        </form>
        <form id="f-details" class="form" novalidate hidden style="margin-top:20px;padding-top:20px;border-top:1px solid var(--line-2)">
          <div class="field"><label for="c-name">نام شرکت</label><input id="c-name" name="name" required></div>
          <div class="form-row cols-2">
            <div class="field"><label for="c-unit">قیمت‌ها در سایت به چه واحدی است؟</label><select id="c-unit" name="price_unit">${unitOptions('toman')}</select>
              <span class="hint" id="c-unit-hint">از تنظیمات ووکامرس خوانده می‌شود؛ اگر اشتباه است عوضش کنید.</span></div>
            <div class="field"><label for="c-currency">گزارش و تسویه به</label><select id="c-currency" name="currency">${currencyOptions('toman')}</select></div>
          </div>
          <div class="field"><label for="c-wh">کالای اضافه‌ی این شرکت به کدام انبار برود؟</label><select id="c-wh" name="warehouse_id">${warehouseOptions(warehouses, 1)}</select>
            <span class="hint">پیش‌فرض است؛ برای هر کالا جداگانه هم می‌شود عوضش کرد.</span></div>
          <div class="form-row cols-2">
            <div class="field"><label for="c-contact">نام رابط (اختیاری)</label><input id="c-contact" name="contact_name"></div>
            <div class="field"><label for="c-phone">تلفن رابط (اختیاری)</label><input id="c-phone" name="contact_phone" dir="ltr" inputmode="tel"></div>
          </div>
          <div class="field"><label for="c-notes">یادداشت (اختیاری)</label><textarea id="c-notes" name="notes" placeholder="مثلاً شرایط قرارداد یا روز تسویه"></textarea></div>
          <div class="form-actions"><button class="btn btn-primary btn-lg" type="submit">${icon('check')}ثبت شرکت و خواندن کالاها</button></div>
        </form>
      </section>
      <aside>${HOWTO}</aside>
    </div>`;

  const fc = $('#f-connect', view);
  const fd = $('#f-details', view);
  fc.addEventListener('input', () => { if (found) { found = null; fd.hidden = true; $('#c-result', view).innerHTML = ''; $('#st-1', view).classList.remove('done'); $('#st-1', view).setAttribute('aria-current', 'step'); $('#st-2', view).removeAttribute('aria-current'); } });
  fc.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(fc);
    const errs = {};
    if (!v.site_url.trim()) errs.site_url = 'آدرس سایت را وارد کنید.';
    if (v.key.trim().length < 10) errs.key = 'کلید را کامل وارد کنید.';
    if (v.secret.trim().length < 10) errs.secret = 'رمز را کامل وارد کنید.';
    if (fieldErrors(fc, errs)) return;
    const btn = $('button[type=submit]', fc);
    busy(btn, true, 'در حال بررسی سایت…');
    $('#c-result', view).innerHTML = '';
    try {
      found = await post('/companies/test', { site_url: v.site_url.trim(), key: v.key.trim(), secret: v.secret.trim() });
      fc.elements.site_url.value = found.site_url;
      $('#c-result', view).innerHTML = `<div class="callout callout-ok">${icon('check')}<div><strong>اتصال برقرار شد.</strong> ${fa(found.productCount)} کالا در سایت پیدا شد${found.siteCurrency ? ` و واحد پول سایت <b dir="ltr">${esc(found.siteCurrency)}</b> است` : ''}.</div></div>`;
      if (found.price_unit) { fd.elements.price_unit.value = found.price_unit; fd.elements.currency.value = found.price_unit.includes('rial') ? 'rial' : 'toman'; }
      else $('#c-unit-hint', view).textContent = 'واحد پول سایت شناخته نشد؛ واحد درست را انتخاب کنید.';
      fd.hidden = false;
      $('#st-1', view).classList.add('done'); $('#st-1', view).removeAttribute('aria-current'); $('#st-2', view).setAttribute('aria-current', 'step');
      fd.elements.name.focus();
    } catch (err) {
      $('#c-result', view).innerHTML = `<div class="callout callout-err" role="alert">${icon('alert')}<span>${esc(err.message)}</span></div>`;
    } finally {
      busy(btn, false);
    }
  });
  fd.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = { ...formValues(fc), ...formValues(fd) };
    if (!v.name.trim()) { fieldErrors(fd, { name: 'نام شرکت را وارد کنید.' }); return; }
    const btn = $('button[type=submit]', fd);
    busy(btn, true, 'در حال ثبت…');
    try {
      const { company } = await post('/companies', { ...v, contact_phone: latin(v.contact_phone), site_url: v.site_url.trim(), key: v.key.trim(), secret: v.secret.trim() });
      toast(`«${company.name}» ثبت شد؛ خواندن کالاها شروع شد.`);
      ctx.go(`#/companies/${company.id}`);
    } catch (err) {
      showError(fd, err);
    } finally {
      busy(btn, false);
    }
  });
}

/* ------------------------------------------------------------ one company */
async function renderOne(view, ctx, id) {
  view.innerHTML = skeleton(6);
  let data = null;
  let progress = null;

  async function load() {
    data = await get(`/companies/${id}`);
    paint();
  }
  function paint() {
    const c = data.company;
    const running = c.sync_state === 'running';
    view.innerHTML = `
      <div><a class="back" href="#/companies">${icon('back')}شرکت‌ها</a>
        <div class="page-head">
          <div class="company-card" style="display:flex;gap:12px;align-items:center">${logo(c)}<div>
            <div class="title-row"><h1>${esc(c.name)}</h1>${syncState(c)}</div>
            <a class="link small ltr" href="${esc(c.site_url)}" target="_blank" rel="noopener noreferrer">${esc(c.site_url.replace(/^https?:\/\//, ''))}</a></div></div>
          <div class="page-actions">
            <button class="btn" type="button" data-sync="incremental" ${running ? 'disabled' : ''}>${icon('refresh')}خواندن تغییرات</button>
            <button class="btn" type="button" data-sync="full" ${running ? 'disabled' : ''}>${icon('layers')}خواندن کامل</button>
            <button class="btn btn-primary" type="button" data-edit>${icon('edit')}ویرایش</button>
          </div>
        </div></div>
      ${running ? `<div class="card"><div class="card-head"><h2>در حال خواندن کالاها از سایت…</h2><span class="muted small" id="prog-text">${progressText()}</span></div><div class="progress" role="progressbar" aria-label="پیشرفت همگام‌سازی" ${progress && progress.pages ? `aria-valuemin="0" aria-valuemax="${progress.pages}" aria-valuenow="${progress.page}"` : ''}><i style="width:${progressPct()}%"></i></div></div>` : ''}
      ${c.sync_state === 'error' && c.sync_error ? `<div class="callout callout-err" role="alert">${icon('alert')}<div><strong>آخرین همگام‌سازی ناموفق بود:</strong> ${esc(c.sync_error)}<br><span class="small">نرم‌افزار چند دقیقه‌ی دیگر دوباره امتحان می‌کند. اگر کلید عوض شده، از «ویرایش» کلید تازه را وارد کنید.</span></div></div>` : ''}
      <div class="metrics">
        <a class="metric" href="#/products?company=${c.id}">${icon('box')}<strong>${fa(c.products)}</strong><span>کالای فعال</span></a>
        <a class="metric tone-orange" href="#/products?company=${c.id}&setup=todo">${icon('edit')}<strong>${fa(c.needs_setup)}</strong><span>منتظر تنظیم</span></a>
        <a class="metric tone-red" href="#/products?company=${c.id}&stock=outofstock">${icon('alert')}<strong>${fa(c.out_of_stock)}</strong><span>ناموجود</span></a>
        <a class="metric tone-green" href="#/changes?company=${c.id}">${icon('trend')}<strong>${fa(c.price_changes_24h)}</strong><span>تغییر قیمت در ۲۴ ساعت</span></a>
      </div>
      <div class="grid grid-2">
        <section class="card" aria-labelledby="h-conn">
          <div class="card-head"><h2 id="h-conn">اتصال و همگام‌سازی</h2></div>
          <dl class="kv">
            <div><dt>آخرین خواندن کامل</dt><dd>${when(c.last_full_sync_at, 'full')}</dd></div>
            <div><dt>آخرین خواندن تغییرات</dt><dd>${when(c.last_incremental_at, 'full')}</dd></div>
            <div><dt>آخرین پیام افزونه</dt><dd>${c.last_webhook_at ? when(c.last_webhook_at, 'full') : '<span class="muted">هنوز وصل نشده</span>'}</dd></div>
            <div><dt>کلید API</dt><dd class="ltr">…${esc(c.key_hint || '')}</dd></div>
            <div><dt>قیمت‌ها در سایت</dt><dd>${esc(PRICE_UNIT[c.price_unit])}${c.site_currency ? ` <span class="muted small ltr">(${esc(c.site_currency)})</span>` : ''}</dd></div>
            <div><dt>گزارش و تسویه</dt><dd>${esc(CURRENCY[c.currency])}</dd></div>
            <div><dt>انبار اضافه‌ها</dt><dd>${esc(c.warehouse ? c.warehouse.name : '—')}</dd></div>
            <div><dt>روش اتصال</dt><dd class="small">${c.api_style === 'rest_route' ? 'rest_route' : 'wp-json'} · ${c.auth_mode === 'query' ? 'کلید در آدرس' : 'کلید در هدر'}</dd></div>
          </dl>
        </section>
        <section class="card" aria-labelledby="h-plugin">
          <div class="card-head"><div><h2 id="h-plugin">افزونه‌ی وردپرس (به‌روزرسانی فوری)</h2><p>بدون افزونه هم کار می‌کند، ولی با افزونه هر تغییر قیمت همان لحظه می‌رسد.</p></div></div>
          ${c.last_webhook_at ? `<div class="callout callout-ok small">${icon('check')}<span>افزونه وصل است؛ آخرین پیام ${esc(ago(c.last_webhook_at))}.</span></div>` : ''}
          <ol class="howto" style="padding-inline-start:34px">
            <li><a class="link" href="/api/plugin/anbar-connector.zip" download>فایل افزونه را دانلود کنید</a> و در وردپرس سایت از «افزونه‌ها ← افزودن ← بارگذاری» نصب و فعال کنید.</li>
            <li>در «تنظیمات ← اتصال انبار» این دو مقدار را بچسبانید و «ذخیره و آزمایش» را بزنید.</li>
          </ol>
          <div class="field"><span class="field-label">آدرس دریافت</span><div class="copy-field"><input class="input" readonly value="${esc(c.webhook_url)}" aria-label="آدرس دریافت"><button class="btn" type="button" data-copy="${esc(c.webhook_url)}" data-what="آدرس">${icon('copy')}کپی</button></div></div>
          <div class="field"><span class="field-label">رمز اتصال</span><div class="copy-field"><input class="input" id="hook-secret" type="password" readonly value="${esc(c.webhook_secret)}" aria-label="رمز اتصال"><button class="btn" type="button" data-reveal="hook-secret" aria-label="نمایش رمز" aria-pressed="false">${icon('eye')}</button><button class="btn" type="button" data-copy="${esc(c.webhook_secret)}" data-what="رمز">${icon('copy')}کپی</button></div></div>
          <div class="form-actions"><button class="btn btn-sm btn-ghost" type="button" data-new-secret>${icon('key')}ساخت رمز جدید</button></div>
        </section>
      </div>
      <section class="card card-flush" aria-labelledby="h-runs">
        <div class="card-head"><h2 id="h-runs">سابقه‌ی همگام‌سازی</h2></div>
        ${data.runs.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th scope="col">زمان</th><th scope="col">نوع</th><th scope="col">نتیجه</th><th scope="col" class="col-num">خوانده‌شده</th><th scope="col" class="col-num">جدید</th><th scope="col" class="col-num">تغییر قیمت</th><th scope="col" class="col-num">تغییر موجودی</th><th scope="col" class="col-num">حذف‌شده</th></tr></thead>
          <tbody>${data.runs.map((r) => `<tr>
            <td class="cell-main">${when(r.started_at)}${r.finished_at ? ` <span class="muted small">(${fa(Math.max(1, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000)))} ثانیه)</span>` : ''}</td>
            <td data-label="نوع">${esc(KIND[r.kind] || r.kind)}</td>
            <td data-label="نتیجه">${r.status === 'ok' ? '<span class="state state-ok">موفق</span>' : r.status === 'running' ? '<span class="state state-run">در حال انجام</span>' : `<span class="state state-err" title="${esc(r.error || '')}">ناموفق</span>${r.error ? `<div class="small muted">${esc(r.error)}</div>` : ''}`}</td>
            <td class="col-num" data-label="خوانده‌شده">${fa(r.seen)}</td><td class="col-num" data-label="جدید">${fa(r.created)}</td>
            <td class="col-num" data-label="تغییر قیمت">${fa(r.price_changes)}</td><td class="col-num" data-label="تغییر موجودی">${fa(r.stock_changes)}</td><td class="col-num" data-label="حذف‌شده">${fa(r.removed)}</td>
          </tr>`).join('')}</tbody></table></div>` : empty('refresh', 'هنوز همگام‌سازی انجام نشده')}
      </section>
      ${c.contact_name || c.contact_phone || c.notes ? `<section class="card"><div class="card-head"><h2>رابط و یادداشت</h2></div><dl class="kv">
        ${c.contact_name ? `<div><dt>رابط</dt><dd>${esc(c.contact_name)}</dd></div>` : ''}
        ${c.contact_phone ? `<div><dt>تلفن</dt><dd><a class="link ltr" href="tel:${esc(c.contact_phone)}">${esc(c.contact_phone)}</a></dd></div>` : ''}
        ${c.notes ? `<div><dt>یادداشت</dt><dd style="white-space:pre-line;font-weight:400">${esc(c.notes)}</dd></div>` : ''}</dl></section>` : ''}`;
  }
  const progressPct = () => (progress && progress.pages ? Math.min(98, Math.round((progress.page / progress.pages) * 70)) : 8);
  const progressText = () => (progress && progress.total ? `${fa(progress.seen)} کالا خوانده شد (صفحه‌ی ${fa(progress.page)} از ${fa(progress.pages)})` : 'در حال آماده‌سازی…');

  view.onclick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.copy) return copy(t.dataset.copy, t.dataset.what);
    if (t.dataset.sync) {
      busy(t, true);
      try {
        await post(`/companies/${id}/sync`, { kind: t.dataset.sync });
        data.company.sync_state = 'running';
        progress = null;
        paint();
      } catch (err) { toast(err.message, { error: true }); busy(t, false); }
      return;
    }
    if (t.hasAttribute('data-new-secret')) {
      if (!(await confirm({ title: 'رمز جدید بسازم؟', text: 'رمز فعلی دیگر کار نمی‌کند و باید رمز جدید را در افزونه‌ی سایت هم وارد کنید.', yes: 'ساخت رمز جدید', danger: true }))) return;
      try { data.company = (await post(`/companies/${id}/webhook-secret`)).company; paint(); toast('رمز جدید ساخته شد؛ آن را در افزونه وارد کنید.'); } catch (err) { toast(err.message, { error: true }); }
      return;
    }
    if (t.hasAttribute('data-edit')) editSheet();
  };

  async function editSheet() {
    const c = data.company;
    const { items: warehouses } = await get('/warehouses');
    const body = openSheet(`ویرایش «${c.name}»`, `<form class="form" id="f-edit" novalidate>
      <div class="field"><label for="e-name">نام شرکت</label><input id="e-name" name="name" value="${esc(c.name)}" required></div>
      <div class="field"><label for="e-site">آدرس سایت</label><input id="e-site" name="site_url" dir="ltr" value="${esc(c.site_url)}" required></div>
      <div class="form-row cols-2">
        <div class="field"><label for="e-unit">قیمت‌ها در سایت به</label><select id="e-unit" name="price_unit">${unitOptions(c.price_unit)}</select></div>
        <div class="field"><label for="e-cur">گزارش و تسویه به</label><select id="e-cur" name="currency">${currencyOptions(c.currency)}</select></div>
      </div>
      <div class="field"><label for="e-wh">انبار اضافه‌ها</label><select id="e-wh" name="warehouse_id">${warehouseOptions(warehouses, c.warehouse ? c.warehouse.id : null)}</select></div>
      <div class="form-row cols-2">
        <div class="field"><label for="e-contact">نام رابط</label><input id="e-contact" name="contact_name" value="${esc(c.contact_name || '')}"></div>
        <div class="field"><label for="e-phone">تلفن رابط</label><input id="e-phone" name="contact_phone" dir="ltr" inputmode="tel" value="${esc(c.contact_phone || '')}"></div>
      </div>
      <div class="field"><label for="e-notes">یادداشت</label><textarea id="e-notes" name="notes">${esc(c.notes || '')}</textarea></div>
      <details><summary class="link">عوض کردن کلید API</summary>
        <div class="form" style="margin-top:12px">
          <div class="field"><label for="e-key">کلید مصرف‌کننده‌ی جدید</label><input id="e-key" name="key" dir="ltr" autocomplete="off" placeholder="ck_…"></div>
          <div class="field"><label for="e-secret">رمز مصرف‌کننده‌ی جدید</label><input id="e-secret" name="secret" type="password" dir="ltr" autocomplete="off" placeholder="cs_…"></div>
          <span class="hint muted small">خالی بماند یعنی کلید فعلی (…${esc(c.key_hint || '')}) بماند.</span>
        </div></details>
      <label class="switch"><span><strong>فعال</strong><small>شرکت غیرفعال همگام‌سازی نمی‌شود ولی سابقه‌اش می‌ماند.</small></span><input type="checkbox" name="active" ${c.active ? 'checked' : ''}><i></i></label>
      <div class="form-actions"><button class="btn btn-primary" type="submit">ذخیره</button><button class="btn btn-ghost" type="button" data-close-sheet-local>انصراف</button></div>
    </form>`);
    const f = $('#f-edit', body);
    $('[data-close-sheet-local]', body).addEventListener('click', closeSheet);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(f);
      const btn = $('button[type=submit]', f);
      busy(btn, true, v.key ? 'در حال بررسی کلید…' : 'در حال ذخیره…');
      try {
        data.company = (await put(`/companies/${id}`, { ...v, contact_phone: latin(v.contact_phone) })).company;
        closeSheet();
        paint();
        toast('تغییرات ذخیره شد.');
      } catch (err) { showError(f, err); } finally { busy(btn, false); }
    });
  }

  await load();
  const reload = debounce(() => load().catch(() => {}), 400);
  const offs = [
    ctx.subscribe('sync', (e) => {
      if (e.companyId !== id) return;
      if (e.state === 'progress') {
        progress = e;
        const bar = $('.progress i', view);
        if (bar) { bar.style.width = progressPct() + '%'; $('#prog-text', view).textContent = progressText(); }
        else if (data.company.sync_state !== 'running') { data.company.sync_state = 'running'; paint(); }
        return;
      }
      if (e.state === 'running') { data.company.sync_state = 'running'; progress = null; paint(); return; }
      progress = null;
      if (e.state === 'ok' && (e.created || e.priceChanges || e.removed)) toast(`خواندن «${data.company.name}» تمام شد: ${fa(e.seen)} کالا${e.created ? `، ${fa(e.created)} جدید` : ''}${e.priceChanges ? `، ${fa(e.priceChanges)} تغییر قیمت` : ''}.`);
      reload();
    }),
    ctx.subscribe('company', (e) => { if (e.id === id) reload(); })
  ];
  return () => offs.forEach((f) => f());
}
