/** Dashboard: key numbers, the health of every company connection, recent price changes and activity. */
import { get } from '../api.js';
import { $, esc, icon, fa, money, moneyText, delta, when, ago, skeleton, empty, debounce } from '../ui.js';

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
        <div class="page-actions"><a class="btn" href="#/receiving">${icon('truck')}دریافت روزانه</a><a class="btn btn-primary" href="#/orders/new">${icon('plus')}سفارش جدید</a></div>
      </div>
      ${errors.length ? `<div class="callout callout-err" role="alert">${icon('alert')}<div><strong>اتصال ${fa(errors.length)} شرکت مشکل دارد:</strong> ${errors.map((c) => `<a class="link" href="#/companies/${c.id}">${esc(c.name)}</a>`).join('، ')}. قیمت‌های این شرکت‌ها تا رفع مشکل به‌روز نمی‌شود.</div></div>` : ''}
      <div class="metrics">
        <a class="metric" href="#/orders?period=today">${icon('cart')}<strong>${fa(d.ops.orders_today)}</strong><span>سفارش امروز (${fa(d.ops.lines_today)} قلم)</span></a>
        <a class="metric tone-orange" href="#/receiving">${icon('truck')}<strong>${fa(d.ops.receiving_due)}</strong><span>ردیف منتظر دریافت از روزهای قبل</span></a>
        <a class="metric tone-green" href="#/inbox">${icon('inbox')}<strong>${fa(d.ops.tasks_open)}</strong><span>کار باز در کارتابل (دیجی‌کالا و باسلام)</span></a>
        <a class="metric tone-red" href="#/stock">${icon('layers')}<strong>${fa(d.ops.consigned_units)}</strong><span>عدد کالای امانی شرکت‌ها در انبار ما</span></a>
      </div>
      ${d.ops.returns_waiting ? `<div class="callout callout-warn">${icon('refresh')}<span>${fa(d.ops.returns_waiting)} مرجوعی منتظر تصمیم است. <a class="link" href="#/returns">تعیین تکلیف</a></span></div>` : ''}
      ${d.products.needs_setup ? `<div class="callout callout-warn">${icon('edit')}<span>${fa(d.products.needs_setup)} کالا هنوز «تعداد در بسته»اش تأیید نشده. <a class="link" href="#/products?setup=guessed">بررسی و تأیید</a></span></div>` : ''}
      <div class="grid grid-main">
        <section class="card" aria-labelledby="dash-days">
          <div class="card-head"><div><h2 id="dash-days">سفارش‌های ۱۴ روز گذشته</h2><p>تعداد سفارش در هر روز؛ روی هر ستون بروید تا جزئیاتش را ببینید.</p></div><a class="btn btn-sm btn-ghost" href="#/orders">سفارش‌ها</a></div>
          <div class="chart" id="days-chart"></div>
        </section>
        <section class="card card-flush" aria-labelledby="dash-acc">
          <div class="card-head"><div><h2 id="dash-acc">حساب ${esc(d.accounts[0] ? d.accounts[0].month_label : 'این ماه')} با شرکت‌ها</h2><p>تا این لحظه، پیش‌نویس صورت‌حساب</p></div><a class="btn btn-sm btn-ghost" href="#/statements">صورت‌حساب‌ها</a></div>
          ${d.accounts.length ? `<div class="list">${d.accounts.map((a) => `<a class="list-item" href="#/statements/${a.id}/${a.month}"><span class="grow"><span class="title">${esc(a.name)}</span></span><span class="price">${moneyText(a.total, a.currency)}</span></a>`).join('')}</div>` : empty('building', 'شرکتی نیست')}
        </section>
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
    drawDays($('#days-chart', view), d.days);
  }

  await load();
  const reload = debounce(() => load().catch(() => {}), 800);
  const offs = [
    ctx.subscribe('products', (e) => { if (e.priceChanges || e.created || e.removed) reload(); }),
    ctx.subscribe('sync', (e) => { if (e.state !== 'progress') reload(); }),
    ctx.subscribe('company', reload),
    ctx.subscribe('activity', reload),
    ctx.subscribe('tasks', reload),
    ctx.subscribe('orders', reload),
    ctx.subscribe('stock', reload)
  ];
  return () => offs.forEach((off) => off());
}

/* Orders per day: one series, thin bars, quiet grid, a tooltip per bar (the table view is the orders page). */
function drawDays(box, days) {
  if (!box) return;
  const W = Math.max(280, Math.round(box.clientWidth || 600)), H = 170, padT = 12, padB = 26, padS = 8;
  const max = Math.max(1, ...days.map((d) => d.orders));
  const step = (W - padS * 2) / days.length;
  const bw = Math.max(6, Math.min(26, step * 0.55));
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const dayLabel = (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric' }).format(new Date(iso));
  const full = (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  // Oldest on the left like the price chart; bars have a 4px rounded top on the baseline
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="تعداد سفارش در ۱۴ روز گذشته؛ امروز ${fa(days[days.length - 1].orders)} سفارش" style="direction:ltr">
    ${ticks.map((v) => `<line class="grid-line" x1="${padS}" x2="${W - padS}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}
    ${days.map((d, i) => {
      const x = padS + step * i + (step - bw) / 2;
      const top = y(d.orders);
      const h = Math.max(0, H - padB - top);
      return `<g class="bar-g" data-i="${i}"><rect class="hit" x="${padS + step * i}" y="${padT}" width="${step}" height="${H - padT - padB}" fill="transparent"/>
        ${h ? `<path class="bar" d="M${x},${H - padB}V${top + 4}Q${x},${top} ${x + 4},${top}H${x + bw - 4}Q${x + bw},${top} ${x + bw},${top + 4}V${H - padB}Z"/>` : ''}
        <text class="axis-text" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${dayLabel(d.start)}</text></g>`;
    }).join('')}
  </svg><div class="chart-tip" hidden></div>`;
  const tip = box.querySelector('.chart-tip');
  box.querySelector('svg').addEventListener('pointermove', (e) => {
    const g = e.target.closest('.bar-g');
    if (!g) { tip.hidden = true; return; }
    const d = days[Number(g.dataset.i)];
    tip.hidden = false;
    tip.textContent = `${full(d.start)}: ${fa(d.orders)} سفارش، ${fa(d.lines)} قلم`;
    const i = Number(g.dataset.i);
    tip.style.left = `${padS + step * i + step / 2}px`;
    tip.style.top = `${y(d.orders)}px`;
    tip.style.transform = `translate(${i > days.length / 2 ? '-100%' : '0'}, -120%)`;
  });
  box.querySelector('svg').addEventListener('pointerleave', () => { tip.hidden = true; });
}
