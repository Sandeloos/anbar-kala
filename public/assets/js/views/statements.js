/**
 * Monthly statements (#/statements and #/statements/<company>/<month>).
 * Overview per company; one month shows the issued statement (frozen) or the live draft,
 * with sections, adjustments to earlier months, facts, Excel, print, issue, paid, void.
 */
import { get, post } from '../api.js';
import { $, esc, icon, fa, money, moneyText, when, skeleton, empty, toast, openSheet, closeSheet, showError, fieldErrors, busy, debounce, confirm, faDigits, colorFor, initials, CURRENCY } from '../ui.js';

const SECTIONS = {
  sales: ['فروش‌های ارسال‌شده از کالای شرکت', 'کالایی که خود شرکت فرستاد و ارسال شد.'],
  stock: ['ارسال از اضافه‌های شرکت در انبار ما', 'کالای امانی شرکت (اضافه‌های قبلی) که برای سفارش‌ها از انبار ما رفت.'],
  returns: ['مرجوعی‌های برگشت‌داده‌شده به شرکت', 'از حساب کم می‌شود؛ در ماهی که برگشت زده شد.'],
  adjust: ['اصلاحیه‌ی ماه‌های قبل', 'تغییرهای بعد از صدور صورت‌حساب‌های قبلی: دریافت دیرهنگام، اصلاح قیمت، برگرداندن.']
};
const STATUS = { issued: ['صادرشده، منتظر تسویه', 'badge-orange'], paid: ['تسویه‌شده', 'badge-green'], void: ['باطل‌شده', ''] };

export async function render(view, ctx, params) {
  if (params[0] && params[1]) return renderMonth(view, ctx, Number(params[0]), params[1]);
  return renderOverview(view, ctx);
}

async function renderOverview(view, ctx) {
  view.innerHTML = skeleton(4);
  const load = async () => {
    const d = await get('/statements/overview');
    view.innerHTML = `
      <div class="page-head"><div><h1>صورت‌حساب‌ها</h1><p>تسویه‌ی ماهانه با هر شرکت، بر اساس قیمت سایتش در ساعت هر سفارش. صورت‌حساب صادرشده ثابت می‌ماند و هر تغییر بعدی در ماه بعد به‌صورت اصلاحیه می‌آید.</p></div></div>
      ${d.companies.length ? `<div class="companies-grid">${d.companies.map((c) => `<article class="card company-card">
        <div class="top"><span class="logo" style="background:${colorFor(c.name)}" aria-hidden="true">${esc(initials(c.name))}</span>
          <div style="flex:1;min-width:0"><h3>${esc(c.name)}</h3><div class="small muted">${esc(CURRENCY[c.currency])}</div></div></div>
        <a class="month-tile" href="#/statements/${c.id}/${c.last_month}">
          <span><strong>${esc(c.last_month_label)}</strong><small>${c.last_statement ? `<span class="badge ${STATUS[c.last_statement.status][1]}">${STATUS[c.last_statement.status][0]}</span>` : '<span class="badge badge-blue">آماده‌ی صدور</span>'}</small></span>
          <span class="price">${moneyText(c.last_statement ? c.last_statement.total : c.last_draft_total, c.currency)}</span></a>
        <a class="month-tile" href="#/statements/${c.id}/${c.this_month}">
          <span><strong>${esc(c.this_month_label)}</strong><small>ماه جاری، تا این لحظه</small></span>
          <span class="price">${moneyText(c.this_month_total, c.currency)}</span></a>
        ${c.unpaid.length ? `<div class="small" style="color:var(--amber)">${icon('alert')} ${fa(c.unpaid.length)} صورت‌حساب تسویه‌نشده: ${c.unpaid.map((u) => `<a class="link" href="#/statements/${c.id}/${u.month}">${esc(faDigits(u.month.replace('-', '/')))}</a>`).join('، ')}</div>` : ''}
      </article>`).join('')}</div>` : `<div class="card">${empty('building', 'شرکتی نیست')}</div>`}`;
  };
  await load();
  const off = ctx.subscribe('statements', debounce(load, 600));
  return () => off();
}

async function renderMonth(view, ctx, companyId, month) {
  view.innerHTML = skeleton(6);
  const [{ months, companies }] = await Promise.all([get('/statements/overview')]);
  let d = null;

  async function load() {
    d = await get('/statements/month', { company: companyId, month });
    paint();
  }
  function paint() {
    const cur = d.company.currency;
    const s = d.statement;
    document.title = `صورت‌حساب ${d.month_label} ${d.company.name} | انبار`;
    const warnings = [];
    if (!s && !d.ended) warnings.push(`ماه ${d.month_label} هنوز تمام نشده؛ این عددها تا این لحظه است و صدور بعد از پایان ماه ممکن است.`);
    if (d.facts.pending_lines) warnings.push(`${fa(d.facts.pending_lines)} ردیف از سفارش‌های این ماه هنوز دریافت نشده و در این صورت‌حساب نیست؛ بعد از دریافت در صورت‌حساب بعدی به‌صورت اصلاحیه می‌آید. <a class="link" href="#/receiving?company=${companyId}&scope=all">دریافت روزانه</a>`);
    if (d.facts.returns_waiting) warnings.push(`${fa(d.facts.returns_waiting)} مرجوعی این شرکت هنوز تعیین تکلیف نشده. <a class="link" href="#/returns">مرجوعی‌ها</a>`);
    if (s && d.changes_since) warnings.push(`بعد از صدور، ${moneyText(d.changes_since, cur)} تغییر برای این ماه یا قبل از آن ثبت شده که در صورت‌حساب ماه بعد به‌صورت اصلاحیه می‌آید.`);
    view.innerHTML = `
      <div class="no-print"><a class="back" href="#/statements">${icon('back')}صورت‌حساب‌ها</a></div>
      <div class="page-head">
        <div><div class="title-row"><h1>صورت‌حساب ${esc(d.month_label)}</h1>${s ? `<span class="badge ${STATUS[s.status][1]}">${STATUS[s.status][0]}</span>` : '<span class="badge badge-blue">پیش‌نویس</span>'}</div>
          <p><b>${esc(d.company.name)}</b> · مبالغ به ${esc(CURRENCY[cur])}${s ? ` · صادرشده ${when(s.issued_at, 'full')} توسط ${esc(s.issued_by_name || '')}` : ''}${s && s.paid_at ? ` · تسویه ${when(s.paid_at, 'date')}${s.paid_reference ? ` (${esc(s.paid_reference)})` : ''}` : ''}</p></div>
        <div class="page-actions no-print">
          <select class="input" id="st-company" aria-label="شرکت">${companies.map((c) => `<option value="${c.id}"${c.id === companyId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          <select class="input" id="st-month" aria-label="ماه">${months.map((m) => `<option value="${m.month}"${m.month === month ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="card statement-actions no-print"><div class="form-actions">
        ${!s ? `<button class="btn btn-primary" type="button" data-issue ${d.ended ? '' : 'disabled title="ماه هنوز تمام نشده"'}>${icon('check')}صدور صورت‌حساب</button>` : ''}
        ${s && s.status === 'issued' ? `<button class="btn btn-primary" type="button" data-paid>${icon('check')}ثبت تسویه</button>` : ''}
        <a class="btn" href="/api/statements/excel?company=${companyId}&month=${month}">${icon('download')}دانلود اکسل</a>
        <button class="btn" type="button" data-print>${icon('copy')}چاپ</button>
        ${s && s.status === 'issued' && ctx.me.role === 'manager' ? `<button class="btn btn-ghost push" type="button" data-void>${icon('x')}ابطال صورت‌حساب</button>` : ''}
      </div></div>
      ${warnings.map((w) => `<div class="callout callout-warn">${icon('info')}<span>${w}</span></div>`).join('')}
      <div class="metrics statement-totals">
        <div class="metric">${icon('box')}<strong>${moneyText(d.totals.sales, cur)}</strong><span>فروش از کالای شرکت</span></div>
        <div class="metric">${icon('layers')}<strong>${moneyText(d.totals.stock, cur)}</strong><span>ارسال از اضافه‌های شرکت</span></div>
        <div class="metric tone-red">${icon('refresh')}<strong>${moneyText(d.totals.returns + d.totals.adjust, cur)}</strong><span>مرجوعی و اصلاحیه</span></div>
        <div class="metric tone-orange">${icon('check')}<strong>${moneyText(d.totals.total, cur)}</strong><span>مبلغ قابل پرداخت به شرکت</span></div>
      </div>
      ${Object.entries(SECTIONS).map(([key, [title, hint]]) => sectionHtml(key, title, hint, d.sections[key], d.totals[key], cur)).join('')}
      ${!Object.values(d.sections).some((x) => x.length) ? `<div class="card">${empty('box', 'در این ماه چیزی برای حساب نیست', 'سفارشی از این شرکت در این ماه ارسال نشده و تغییری از ماه‌های قبل نمانده است.')}</div>` : ''}
      <section class="card"><div class="card-head"><h2>کالا و انبار در این ماه</h2></div><dl class="kv">
        <div><dt>سفارش‌های این ماه</dt><dd>${fa(d.facts.orders)}</dd></div>
        <div><dt>اضافه‌های رسیده در این ماه</dt><dd>${fa(d.facts.surplus_in_units)} عدد</dd></div>
        <div><dt>اضافه‌های برگشت‌داده‌شده به شرکت در این ماه</dt><dd>${fa(d.facts.surplus_back_units)} عدد</dd></div>
        <div><dt>کالای این شرکت در انبار ما در پایان ماه</dt><dd>${fa(d.facts.consigned_units)} عدد</dd></div>
      </dl></section>
      ${d.history.length ? `<section class="card card-flush no-print"><div class="card-head"><h2>صورت‌حساب‌های این شرکت</h2></div><div class="list">${d.history.map((h) => `<a class="list-item" href="#/statements/${companyId}/${h.month}">
        <span class="grow"><span class="title">${esc(faDigits(h.month.replace('-', '/')))}</span><span class="sub"><span class="badge ${STATUS[h.status][1]}">${STATUS[h.status][0]}</span><span>${when(h.issued_at, 'date')}</span></span></span>
        <span class="price">${moneyText(h.total, cur)}</span></a>`).join('')}</div></section>` : ''}`;
    $('#st-company', view).addEventListener('change', (e) => ctx.go(`#/statements/${e.target.value}/${month}`));
    $('#st-month', view).addEventListener('change', (e) => ctx.go(`#/statements/${companyId}/${e.target.value}`));
  }

  function sectionHtml(key, title, hint, list, total, cur) {
    if (!list.length) return '';
    return `<section class="card card-flush statement-section" aria-labelledby="sec-${key}">
      <div class="card-head"><div><h2 id="sec-${key}">${esc(title)}</h2><p>${esc(hint)}</p></div><span class="price">${money(total, cur)}</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">سفارش</th><th scope="col">کالا</th><th scope="col" class="col-num">تعداد</th><th scope="col" class="col-num">مبلغ هر فروش</th><th scope="col" class="col-num">مبلغ</th></tr></thead>
        <tbody>${list.map((i) => `<tr>
          <td class="cell-main"><div class="cell-title">${i.order_id ? `<a href="#/orders/${i.order_id}">${esc(i.platform_name || '')} ${esc(faDigits(i.order_number || ''))}</a>` : '<strong>—</strong>'}<small>${i.ordered_at ? when(i.ordered_at) : ''}</small></div></td>
          <td data-label="کالا">${esc(i.product_name || '')}${i.note ? `<div class="small muted">${esc(i.note)}</div>` : ''}${key === 'adjust' && i.previous ? `<div class="small muted">قبلاً حساب شده: ${moneyText(i.previous, cur)}</div>` : ''}</td>
          <td class="col-num" data-label="تعداد">${fa(i.units)} عدد${i.sales && i.sales !== i.units ? `<div class="small muted">${fa(Math.round(i.sales * 100) / 100)} فروش</div>` : ''}</td>
          <td class="col-num" data-label="مبلغ هر فروش">${i.unit_price !== null && i.unit_price !== undefined ? money(Math.abs(i.unit_price), cur) : '—'}</td>
          <td class="col-num" data-label="مبلغ"><span class="price">${money(i.amount, cur)}</span></td></tr>`).join('')}</tbody></table></div></section>`;
  }

  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-print')) { window.print(); return; }
    if (b.hasAttribute('data-issue')) {
      const text = `جمع ${moneyText(d.totals.total, d.company.currency)}. بعد از صدور این صورت‌حساب تغییر نمی‌کند و هر تغییری در ماه بعد به‌صورت اصلاحیه می‌آید.${d.facts.pending_lines ? ` ${fa(d.facts.pending_lines)} ردیف این ماه هنوز دریافت نشده است.` : ''}`;
      if (!(await confirm({ title: `صدور صورت‌حساب ${d.month_label} برای ${d.company.name}؟`, text, yes: 'صدور' }))) return;
      busy(b, true);
      try { d = await post('/statements', { company_id: companyId, month }); paint(); toast('صورت‌حساب صادر شد.'); } catch (err) { toast(err.message, { error: true }); busy(b, false); }
      return;
    }
    if (b.hasAttribute('data-paid')) {
      const body = openSheet('ثبت تسویه', `<form class="form" id="f-paid" novalidate>
        <p>${esc(d.company.name)} · ${esc(d.month_label)} · <b>${moneyText(d.totals.total, d.company.currency)}</b></p>
        <div class="field"><label for="pd-ref">شماره‌ی پیگیری یا توضیح پرداخت</label><input id="pd-ref" name="reference" placeholder="مثلاً شماره‌ی فیش یا چک"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت تسویه</button></div></form>`);
      const f = $('#f-paid', body);
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try { d = await post(`/statements/${d.statement.id}/paid`, { reference: f.elements.reference.value.trim() || undefined }); closeSheet(); paint(); toast('تسویه ثبت شد.'); } catch (err) { showError(f, err); }
      });
      return;
    }
    if (b.hasAttribute('data-void')) {
      const body = openSheet('ابطال صورت‌حساب', `<form class="form" id="f-void" novalidate>
        <div class="callout callout-warn small">${icon('alert')}<span>صورت‌حساب باطل می‌شود و دوباره به پیش‌نویس برمی‌گردد؛ بعد از اصلاح می‌شود دوباره صادرش کرد. فقط آخرین صورت‌حساب تسویه‌نشده باطل می‌شود.</span></div>
        <div class="field"><label for="vd-reason">دلیل</label><input id="vd-reason" name="reason" required></div>
        <div class="form-actions"><button class="btn btn-danger" type="submit">ابطال</button></div></form>`);
      const f = $('#f-void', body);
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!f.elements.reason.value.trim()) { fieldErrors(f, { reason: 'دلیل را بنویسید.' }); return; }
        try { d = await post(`/statements/${d.statement.id}/void`, { reason: f.elements.reason.value.trim() }); closeSheet(); paint(); toast('صورت‌حساب باطل شد.'); } catch (err) { showError(f, err); }
      });
    }
  };

  await load();
  const reload = debounce(() => load().catch(() => {}), 800);
  const offs = [ctx.subscribe('statements', reload), ctx.subscribe('orders', reload), ctx.subscribe('returns', reload)];
  return () => offs.forEach((o) => o());
}
