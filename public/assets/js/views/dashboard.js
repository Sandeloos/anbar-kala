/** Dashboard: key numbers, the health of every company connection, recent price changes and activity. */
import { get } from '../api.js';
import { esc, icon, fa, money, delta, when, ago, skeleton, empty, debounce } from '../ui.js';

function greeting(name) {
  const h = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tehran', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const part = h < 5 ? 'شب بخیر' : h < 12 ? 'صبح بخیر' : h < 17 ? 'روز بخیر' : 'عصر بخیر';
  return `${part}، ${String(name).split(' ')[0]}`;
}

function syncState(c) {
  if (!c.active) return '<span class="state state-mute">غیرفعال</span>';
  if (c.sync_state === 'running') return '<span class="state state-run">در حال همگام‌سازی</span>';
  if (c.sync_state === 'error') return '<span class="state state-err">خطا در اتصال</span>';
  if (c.sync_state === 'never') return '<span class="state state-mute">هنوز خوانده نشده</span>';
  return '<span class="state state-ok">وصل</span>';
}

export async function render(view, ctx) {
  view.innerHTML = `<div class="page-head"><div><h1>${esc(greeting(ctx.me.name))}</h1><p>خلاصه‌ی وضعیت شرکت‌ها و قیمت‌ها</p></div></div>${skeleton(6)}`;

  async function load() {
    const d = await get('/dashboard');
    const errors = d.companies.filter((c) => c.active && c.sync_state === 'error');
    view.innerHTML = `
      <div class="page-head">
        <div><h1>${esc(greeting(ctx.me.name))}</h1><p>خلاصه‌ی وضعیت شرکت‌ها و قیمت‌ها؛ این صفحه خودش به‌روز می‌شود.</p></div>
        <div class="page-actions"><a class="btn" href="#/companies/new">${icon('plus')}شرکت جدید</a></div>
      </div>
      ${errors.length ? `<div class="callout callout-err" role="alert">${icon('alert')}<div><strong>اتصال ${fa(errors.length)} شرکت مشکل دارد:</strong> ${errors.map((c) => `<a class="link" href="#/companies/${c.id}">${esc(c.name)}</a>`).join('، ')}. قیمت‌های این شرکت‌ها تا رفع مشکل به‌روز نمی‌شود.</div></div>` : ''}
      <div class="metrics">
        <a class="metric" href="#/products">${icon('box')}<strong>${fa(d.products.total)}</strong><span>کالای فعال در همه‌ی سایت‌ها</span></a>
        <a class="metric tone-orange" href="#/products?setup=todo">${icon('edit')}<strong>${fa(d.products.needs_setup)}</strong><span>کالای منتظر تنظیم (تعداد در بسته)</span></a>
        <a class="metric tone-green" href="#/changes">${icon('trend')}<strong>${fa(d.changes_24h.price)}</strong><span>تغییر قیمت در ۲۴ ساعت گذشته</span></a>
        <a class="metric tone-red" href="#/products?stock=outofstock">${icon('alert')}<strong>${fa(d.products.out_of_stock)}</strong><span>کالای ناموجود در سایت‌ها</span></a>
      </div>
      <div class="grid grid-main">
        <section class="card card-flush" aria-labelledby="dash-changes">
          <div class="card-head"><div><h2 id="dash-changes">آخرین تغییرات قیمت</h2><p>قیمت قبل از تخفیف، همان‌طور که روی سایت شرکت است</p></div><a class="btn btn-sm btn-ghost" href="#/changes">همه</a></div>
          ${d.recent.length ? `<div class="list">${d.recent.map((r) => {
            const up = r.prev_regular_price !== null && r.regular_price > r.prev_regular_price;
            return `<a class="list-item" href="#/products/${r.product_id}">
              <span class="list-icon ${up ? 'up' : 'down'}">${icon(up ? 'up' : 'dn')}</span>
              <span class="grow"><span class="title">${esc(r.name)}</span>
                <span class="sub"><span>${esc(r.company_name)}</span><span>${when(r.effective_at)}</span></span></span>
              <span class="price">${money(r.regular_price, r.currency)} ${delta(r.prev_regular_price, r.regular_price)}</span>
            </a>`;
          }).join('')}</div>` : empty('trend', 'هنوز تغییری ثبت نشده', 'هر تغییر قیمتی که روی سایت شرکت‌ها انجام شود اینجا دیده می‌شود.')}
        </section>
        <div class="grid">
          <section class="card card-flush" aria-labelledby="dash-companies">
            <div class="card-head"><h2 id="dash-companies">اتصال شرکت‌ها</h2><a class="btn btn-sm btn-ghost" href="#/companies">مدیریت</a></div>
            ${d.companies.length ? `<div class="list">${d.companies.map((c) => `<a class="list-item" href="#/companies/${c.id}">
                <span class="grow"><span class="title">${esc(c.name)}</span>
                  <span class="sub">${syncState(c)}<span>${fa(c.products)} کالا</span><span title="آخرین همگام‌سازی">${esc(ago(c.last_incremental_at || c.last_full_sync_at))}</span></span></span>
                ${c.price_changes_24h ? `<span class="badge badge-blue">${fa(c.price_changes_24h)} تغییر</span>` : ''}
              </a>`).join('')}</div>`
              : empty('building', 'هنوز شرکتی ثبت نشده', 'اول شرکت طرف قرارداد و سایت ووکامرس آن را اضافه کنید.', '<a class="btn btn-primary" href="#/companies/new">افزودن شرکت</a>')}
          </section>
          <section class="card card-flush" aria-labelledby="dash-activity">
            <div class="card-head"><h2 id="dash-activity">آخرین کارها</h2><a class="btn btn-sm btn-ghost" href="#/activity">گزارش فعالیت</a></div>
            ${d.activity.length ? `<div class="list">${d.activity.map((a) => `<div class="list-item"><span class="grow">
                <span class="title" style="white-space:normal">${esc(a.summary)}</span>
                <span class="sub"><span>${esc(a.user_name || 'سیستم')}</span><span>${when(a.created_at)}</span></span></span></div>`).join('')}</div>`
              : empty('pulse', 'هنوز کاری ثبت نشده')}
          </section>
        </div>
      </div>`;
  }

  await load();
  const reload = debounce(() => load().catch(() => {}), 800);
  const offs = [
    ctx.subscribe('products', (e) => { if (e.priceChanges || e.created || e.removed) reload(); }),
    ctx.subscribe('sync', (e) => { if (e.state !== 'progress') reload(); }),
    ctx.subscribe('company', reload),
    ctx.subscribe('activity', reload)
  ];
  return () => offs.forEach((off) => off());
}
