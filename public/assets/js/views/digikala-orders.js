import { get } from '../api.js';
import { $, esc, fa, faDigits, moneyText, smartTime, when, skeleton, empty, debounce } from '../ui.js';
import { jalaliToday, describeDate } from '../jalali.js';
import { orderDateRange } from '../order-date-range.js';

const SECTIONS = { active: 'فعال', processed: 'پردازش‌شده', returned: 'مرجوع‌شده', canceled: 'لغوشده' };
const NUMBER = (n) => n == null ? '—' : fa(n);
const AMOUNT = (n) => n == null ? 'ثبت نشده' : moneyText(n, 'toman');
const WHEN = (value) => value ? when(value) : '—';
const errorBox = (message) => `<div class="callout callout-err" role="alert">${esc(message)}</div>`;
const PAGE_SIZE = 30;

export function renderDigikalaOrders(view, ctx, { platforms, companies, platform, filters }) {
  const today = jalaliToday();
  let company = filters.company || 'all';
  let query = filters.q;
  let selected = Object.hasOwn(SECTIONS, filters.status) ? filters.status : 'active';
  let page = 0;
  let range;
  let report;
  let ordersRequest = 0;
  let salesRequest = 0;
  let packageRequest = 0;
  let ordersPoll;
  let salesPoll;

  view.innerHTML = `
    <div class="page-head"><div><h1>سفارش‌های دیجیکالا</h1><p id="dk-orders-scope"></p></div>
      <div class="page-actions"><button type="button" class="btn btn-sm" id="dk-orders-refresh">تازه‌سازی</button></div></div>
    <details class="dk-order-filter-panel">
      <summary class="btn btn-sm">فیلترها و بازهٔ تاریخ</summary>
      <div id="dk-orders-date"></div>
      <div class="toolbar dk-order-filters" aria-label="فیلتر سفارش‌های دیجیکالا">
      <div class="field"><label for="dk-orders-platform">پلتفرم</label><select id="dk-orders-platform" class="input">
        ${platforms.filter(p => p.active).map(p => `<option value="${p.id}"${p.id === platform.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="dk-orders-company">شرکت</label><select id="dk-orders-company" class="input">
        <option value="all">همهٔ شرکت‌ها</option>${companies.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="dk-orders-search">جست‌وجوی سفارش</label>
        <input id="dk-orders-search" class="input" type="search" placeholder="شماره سفارش، شناسه ارسال، نام یا کد کالا" value="${esc(query)}"></div>
      </div>
      <a class="link small" href="#/orders?view=internal">سوابق داخلی و ثبت دستی</a>
    </details>
    <section class="card" aria-labelledby="dk-packages-title">
      <div class="card-head"><div><h2 id="dk-packages-title">محموله‌های فروشنده</h2>
        <p id="dk-packages-updated">فهرست کل حساب فروشندگی بر اساس تاریخ ایجاد محموله.</p></div></div>
      <div id="dk-orders-packages" aria-live="polite"></div>
    </section>
    <div id="dk-orders-sales" aria-live="polite"></div>
    <div class="seg" role="group" aria-label="وضعیت سفارش در دیجیکالا">
      ${Object.entries(SECTIONS).map(([key, title]) => `<button type="button" data-order-state="${key}" aria-pressed="${key === selected}">${title}</button>`).join('')}
    </div>
    <section class="card" id="dk-orders-result" aria-label="نتیجهٔ سفارش‌ها" aria-live="polite"></section>`;
  const result = $('#dk-orders-result', view);
  const salesBox = $('#dk-orders-sales', view);
  const packageBox = $('#dk-orders-packages', view);
  $('#dk-orders-company', view).value = company;
  if (!$('#dk-orders-company', view).value) {
    company = 'all';
    $('#dk-orders-company', view).value = company;
  }

  const updateUrl = () => {
    ctx.setQuery({ platform: platform.id, company, q: query,
      status: selected === 'active' ? '' : selected, from_date: range.from_date, to_date: range.to_date });
    const start = describeDate(range.from_date);
    const end = describeDate(range.to_date);
    const companyName = $('#dk-orders-company', view).selectedOptions[0].textContent;
    $('#dk-orders-scope', view).textContent = `${start === end ? start : `${start} تا ${end}`} · وقت تهران · ${companyName}`;
  };
  const progressing = (p) => p && !p.complete && !p.error;
  const progressLabel = (p) => `${fa(p.pages)}${p.total !== null ? ` از ${fa(p.total)}` : ''} صفحه خوانده شد.`;

  function paintOrders() {
    const data = report?.sections[selected];
    if (!data) return;
    if (data.error) { result.innerHTML = errorBox(data.error); return; }
    const s = data.summary;
    const pageCount = Math.max(1, Math.ceil(s.rows / PAGE_SIZE));
    page = Math.min(page, pageCount - 1);
    const progress = data.progress;
    const incomplete = progress && !progress.complete;
    const partial = s.missing_prices || data.invalid || data.excluded_unmatched || incomplete;
    const label = selected === 'returned' || selected === 'canceled' ? 'جمع ارزش این وضعیت' : 'جمع مبلغ فروش این وضعیت';
    const hints = [
      s.missing_prices ? `${fa(s.missing_prices)} ردیف مبلغ کل ندارد و در جمع منظور نشده است.` : '',
      data.invalid ? `${fa(data.invalid)} ردیف بدون شناسه یا زمان معتبر در نمایش و جمع منظور نشد.` : ''
    ].filter(Boolean);
    result.innerHTML = `
      <div class="card-head"><div><h2>سفارش‌های ${SECTIONS[selected]}</h2>
        <p>خوانده‌شده از دیجیکالا ${WHEN(data.fetched_at)}</p></div></div>
      ${incomplete ? `<p class="callout ${progress.error ? 'callout-warn' : 'callout-info'}">${progressLabel(progress)}
        ${progress.error ? esc(progress.error) : 'بقیهٔ تاریخچه در حال خواندن است.'}</p>` : ''}
      <dl class="metrics dk-order-metrics">
        <div class="metric"><dt>سفارش</dt><dd>${fa(s.orders)}</dd></div>
        <div class="metric"><dt>ردیف کالا</dt><dd>${fa(s.rows)}</dd></div>
        <div class="metric"><dt>شناسهٔ ارسال ثبت‌شده</dt><dd>${fa(s.shipments)}</dd></div>
        <div class="metric tone-green"><dt>${label}${partial && s.total !== null ? ' (بخشی)' : ''}</dt><dd>${AMOUNT(s.total)}</dd></div>
      </dl>
      ${hints.length ? `<div class="callout callout-warn small"><ul>${hints.map(h => `<li>${esc(h)}</li>`).join('')}</ul></div>` : ''}
      ${data.unmatched ? `<p class="callout callout-info small"><span><strong>${fa(data.unmatched)} قلم تطبیق‌نشده</strong> از دیجیکالا دریافت شده است. تأمین‌کنندهٔ این اقلام هنوز در انبار مشخص نیست.
        ${company !== 'all' ? 'در فیلتر این شرکت نمایش داده نمی‌شوند.' : 'در فهرست دیده می‌شوند و اگر مبلغ داشته باشند، در جمع فروش دیجیکالا هم حساب می‌شوند.'}</span>
        ${company !== 'all' ? '<button class="btn btn-sm" type="button" data-order-all>نمایش همهٔ شرکت‌ها</button>' : ''}</p>` : ''}
      ${data.rows.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">سفارش و زمان</th><th scope="col">کالا</th><th scope="col">ارسال یا مهلت تحویل</th>
          <th scope="col" class="col-num">تعداد فروش</th><th scope="col" class="col-num">قیمت هر فروش در دیجیکالا</th><th scope="col" class="col-num">مبلغ ردیف</th></tr></thead>
        <tbody>${data.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(r => `<tr>
          <td class="cell-main"><span class="cell-title ltr">${faDigits(r.order_id)}</span><span class="cell-meta">${WHEN(r.ordered_at)}</span>
            ${r.local_order_id ? `<a class="link small" href="#/orders/${r.local_order_id}">ثبت داخلی</a>` : ''}</td>
          <td data-label="کالا"><span class="cell-title">${esc(r.title || 'عنوان در پاسخ موجود نیست')}</span>
            <span class="cell-meta">DKPC ${faDigits(r.variant_id)} ${r.code ? ` · ${esc(r.code)}` : ''} · ${r.company_name ? esc(r.company_name) : 'تطبیق‌نشده'}</span>
            ${r.product_id ? `<details class="small muted"><summary>جزئیات تطبیق کالا</summary><a class="link" href="#/products/${r.product_id}">کالای متصل و مبنای قیمت سایت</a>
                ${r.site_price ? `<div>قیمت سایت در ثبت سفارش
              ${moneyText(r.site_price.amount, r.site_price.currency)} برای ${fa(r.site_price.price_units)} عدد
              ${r.site_price.manual ? ' · دستی' : ''}${r.site_price.uncertain ? ' · نامطمئن' : ''}</div>` : ''}
              </details>` : ''}
            ${r.pack_mismatch ? '<div class="small muted">تعداد در عنوان دیجیکالا و تعداد ثبت‌شده یکسان نیست.</div>' : ''}</td>
          <td data-label="ارسال یا مهلت تحویل">${r.shipment_id ? `شناسهٔ ارسال ${faDigits(r.shipment_id)}` : r.commitment_date ? WHEN(r.commitment_date) : '—'}
            ${r.status ? `<div class="small muted">${esc(r.status)}</div>` : ''}</td>
          <td data-label="تعداد فروش" class="col-num">${NUMBER(r.qty)}
            ${r.sale_units ? `<div class="small muted">${fa(r.sale_units)} عدد در هر فروش${r.sale_units_from_title ? ' (از عنوان)' : ''}</div>` : ''}</td>
          <td data-label="قیمت هر فروش در دیجیکالا" class="col-num">${AMOUNT(r.unit_price)}</td>
          <td data-label="مبلغ ردیف" class="col-num"><strong class="price">${AMOUNT(r.total_price)}</strong></td></tr>`).join('')}</tbody></table></div>
        ${pageCount > 1 ? `<div class="table-foot"><span>صفحهٔ ${fa(page + 1)} از ${fa(pageCount)}</span><div class="pager">
          <button type="button" class="btn btn-sm" data-order-page="-1"${page === 0 ? ' disabled' : ''}>قبلی</button>
          <button type="button" class="btn btn-sm" data-order-page="1"${page + 1 >= pageCount ? ' disabled' : ''}>بعدی</button></div></div>` : ''}
        ` : empty('box', incomplete ? 'در صفحه‌های خوانده‌شده هنوز سفارشی با این فیلترها پیدا نشده' : 'سفارشی با این فیلترها پیدا نشد')}
      <p class="small muted">مبلغ ردیف شامل تعدیل‌های اعلام‌شده در پاسخ دیجیکالاست. جمع هر وضعیت جداست.</p>`;
  }

  const queryFor = (section) => ({
    from: range.from, to: range.to, company: company === 'all' ? '' : company, q: query, section
  });

  async function loadOrders(quiet = false) {
    clearTimeout(ordersPoll);
    const id = ++ordersRequest;
    if (!quiet) {
      report = null;
      result.innerHTML = skeleton(4);
    }
    try {
      const data = await get('/digikala/order-report', queryFor(selected));
      if (id !== ordersRequest) return;
      report = data;
      paintOrders();
      if (progressing(data.sections[selected]?.progress)) ordersPoll = setTimeout(() => loadOrders(true), 7000);
    } catch (err) {
      if (id === ordersRequest) result.innerHTML = errorBox(err.message);
    }
  }

  async function loadSales(quiet = false) {
    clearTimeout(salesPoll);
    const id = ++salesRequest;
    if (!quiet) salesBox.innerHTML = '<p class="small muted">در حال خواندن جمع سفارش‌های فعال و پردازش‌شده…</p>';
    try {
      const data = await get('/digikala/order-report', queryFor('sales'));
      if (id !== salesRequest) return;
      const sales = data.sales;
      salesBox.innerHTML = sales ? `<section class="card dk-order-sales" aria-label="جمع سفارش‌های فعال و پردازش‌شده">
        <div><h2>${sales.omitted ? 'جمع قابل محاسبهٔ سفارش‌های فعال و پردازش‌شده' : 'جمع سفارش‌های فعال و پردازش‌شده'}</h2>
        <p class="small muted">${fa(sales.orders)} سفارش یکتا در این فیلتر · مرجوعی و لغو جداگانه گزارش می‌شود.</p></div>
        <strong class="price">${AMOUNT(sales.total)}</strong>
        ${sales.omitted ? `<p class="small muted">${fa(sales.omitted)} ردیف در جمع نیامده است.${sales.overlaps
          ? ` ${fa(sales.overlaps)} ترکیب سفارش و تنوع در هر دو وضعیت دیده شد و برای جلوگیری از شمارش دوباره کنار گذاشته شد.` : ''}</p>` : ''}
      </section>` : '<p class="small muted">جمع فعال و پردازش‌شده در دسترس نیست. مبلغ هر وضعیت را جداگانه ببینید.</p>';
      const progress = data.sections.processed?.progress;
      if (progressing(progress) && !data.sections.active?.error) {
        salesBox.innerHTML = `<p class="small muted">${progressLabel(progress)} جمع فعال و پردازش‌شده پس از خواندن کامل تاریخچه نمایش داده می‌شود.</p>`;
        salesPoll = setTimeout(() => loadSales(true), 7000);
      }
    } catch (err) {
      if (id === salesRequest) salesBox.innerHTML = errorBox(err.message);
    }
  }

  async function loadPackages(force = false) {
    const id = ++packageRequest;
    packageBox.innerHTML = skeleton(2);
    try {
      const data = await get('/digikala/seller-packages', { from: range.from, to: range.to, refresh: force ? '1' : '' });
      if (id !== packageRequest) return;
      if (data.error) { packageBox.innerHTML = errorBox(data.error); return; }
      $('#dk-packages-updated', view).textContent = data.fetched_at
        ? `کل حساب فروشندگی · آخرین همگام‌سازی ${smartTime(data.fetched_at)}`
        : 'فهرست کل حساب فروشندگی بر اساس تاریخ ایجاد محموله.';
      packageBox.innerHTML = data.items.length ? `<div class="list">${data.items.map(p => `
        <details class="dk-package" data-package-id="${p.id}"><summary>
          <strong>محمولهٔ ${esc(faDigits(p.number || p.id))}</strong>
          <span class="badge badge-blue">${esc(p.status || 'وضعیت نامشخص')}</span>
          <span class="small muted">${esc(p.warehouse || '')}${p.delivery ? ` · ${esc(p.delivery)}` : ''}</span>
        </summary><p class="small muted">ایجاد ${WHEN(p.created_at)} · زمان پیش‌بینی‌شده ${WHEN(p.due_at)} · دریافت ${WHEN(p.received_at)}</p>
        <div data-package-body></div></details>`).join('')}</div>` : empty('truck', 'محموله‌ای در این بازه پیدا نشد');
      if (data.warning) packageBox.insertAdjacentHTML('afterbegin', `<p class="callout callout-warn small">نسخهٔ ذخیره‌شده نمایش داده می‌شود. ${esc(data.warning)}</p>`);
    } catch (err) {
      if (id === packageRequest) packageBox.innerHTML = errorBox(err.message);
    }
  }

  packageBox.addEventListener('toggle', async (event) => {
    const details = event.target;
    if (!details.open || !details.dataset.packageId || details.dataset.loaded) return;
    const body = $('[data-package-body]', details);
    details.dataset.loaded = '1';
    body.innerHTML = skeleton(2);
    try {
      const data = await get(`/digikala/seller-packages/${details.dataset.packageId}`);
      if (data.error) throw new Error(data.error);
      body.innerHTML = data.items.length ? `<ul class="list">${data.items.map(item => `<li class="list-item">
        <span class="grow">${esc(item.title || 'کالای بدون عنوان')} · DKPC ${item.variant_id ? faDigits(item.variant_id) : '—'}
          <span class="small muted"> · ${esc(item.company || 'شرکت نامشخص')}</span></span>
        <span>انتظار ${NUMBER(item.expected)} · تحویل ${NUMBER(item.delivered)}</span></li>`).join('')}</ul>`
        : '<p class="small muted">قلمی در جزئیات محموله گزارش نشده است.</p>';
      if (data.warning) body.insertAdjacentHTML('afterbegin', `<p class="callout callout-warn small">جزئیات ذخیره‌شده · ${esc(data.warning)}</p>`);
    } catch (err) {
      delete details.dataset.loaded;
      body.innerHTML = `${errorBox(err.message)}<a class="link small" href="https://seller.digikala.com/pwa/packages/${details.dataset.packageId}"
        target="_blank" rel="noopener noreferrer">مشاهدهٔ همین محموله در پنل فروشندگان دیجیکالا</a>`;
    }
  }, true);

  function refresh(force = false) { if (range) { void loadOrders(); void loadSales(); void loadPackages(force); } }
  const dates = orderDateRange($('#dk-orders-date', view), {
    from: filters.from_date || today, to: filters.to_date || today, defaultToday: true,
    onApply(next) { range = next; page = 0; updateUrl(); refresh(); }
  });
  if (!dates.apply()) $('#dk-orders-date [data-days="0"]', view).click();
  $('#dk-orders-refresh', view).onclick = () => refresh(true);
  $('#dk-orders-company', view).onchange = (e) => {
    company = e.target.value;
    page = 0;
    updateUrl();
    void loadOrders();
    void loadSales();
  };
  $('#dk-orders-platform', view).onchange = (e) => {
    const params = new URLSearchParams({ view: 'internal', platform: e.target.value, from_date: range.from_date, to_date: range.to_date });
    ctx.go(`#/orders?${params}`);
  };
  $('#dk-orders-search', view).oninput = debounce((e) => {
    query = e.target.value.trim();
    page = 0;
    updateUrl();
    void loadOrders();
    void loadSales();
  }, 300);
  view.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button?.hasAttribute('data-order-all')) {
      const select = $('#dk-orders-company', view);
      select.value = 'all';
      select.dispatchEvent(new Event('change'));
    } else if (button?.dataset.orderState) {
      selected = button.dataset.orderState;
      page = 0;
      view.querySelectorAll('[data-order-state]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      updateUrl();
      void loadOrders();
    } else if (button?.dataset.orderPage) {
      page += Number(button.dataset.orderPage);
      paintOrders();
    }
  });
  return () => { ordersRequest++; salesRequest++; packageRequest++; clearTimeout(ordersPoll); clearTimeout(salesPoll); };
}
