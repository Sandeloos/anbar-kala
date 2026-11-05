/**
 * Customer returns (#/returns): record one (from an order number), then decide:
 * keep it (our stock, sellable), send it back to the company (credited this month), or damaged.
 * Waiting returns show how many days they have been waiting.
 */
import { get, post } from '../api.js';
import { $, $$, esc, icon, fa, when, skeleton, empty, toast, openSheet, closeSheet, showError, fieldErrors, busy, debounce, confirm, faDigits, latin, moneyText } from '../ui.js';

const LABEL = { kept: ['نگه داشتیم', 'badge-navy'], to_company: ['برگشت به شرکت', 'badge-orange'], damaged: ['معیوب', 'badge-red'] };

export async function render(view, ctx) {
  const f = { status: ctx.query.get('status') || 'waiting', q: ctx.query.get('q') || '' };
  const { items: warehouses } = await get('/warehouses');
  let items = [];

  view.innerHTML = `
    <div class="page-head"><div><h1>مرجوعی‌ها</h1><p>کالایی که مشتری پس فرستاده به انبار ما می‌آید و مال خودمان حساب می‌شود (پولش به شرکت داده شده). بعد تصمیم می‌گیرید: نگه داشتن، برگشت به شرکت (از حساب این ماه شرکت کم می‌شود) یا معیوب.</p></div>
      <div class="page-actions"><button class="btn btn-primary" type="button" data-new>${icon('plus')}ثبت مرجوعی</button></div></div>
    <div class="card toolbar">
      <label class="search"><span class="sr-only">جستجو</span>${icon('search')}<input type="search" id="rt-q" value="${esc(f.q)}" placeholder="شماره‌ی سفارش یا نام کالا…"></label>
      <div class="seg" role="group" aria-label="وضعیت">${[['waiting', 'منتظر تصمیم'], ['done', 'تعیین تکلیف‌شده'], ['void', 'باطل‌شده']]
        .map(([k, v]) => `<button type="button" data-status="${k}" aria-pressed="${k === f.status}">${v}</button>`).join('')}</div>
    </div>
    <section class="card card-flush" aria-label="مرجوعی‌ها"><div id="rt-list">${skeleton(5)}</div></section>`;

  function paint() {
    const box = $('#rt-list', view);
    if (!items.length) {
      box.innerHTML = empty('refresh', f.status === 'waiting' ? 'مرجوعی منتظری نیست' : 'چیزی نیست', f.status === 'waiting' ? 'مرجوعی را از «ثبت مرجوعی» یا از صفحه‌ی سفارش ثبت کنید.' : '');
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">کالا و سفارش</th><th scope="col" class="col-num">تعداد</th><th scope="col">انبار</th><th scope="col">${f.status === 'waiting' ? 'منتظر از' : 'تصمیم'}</th><th scope="col" class="col-actions"><span class="sr-only">کارها</span></th></tr></thead>
      <tbody>${items.map((r, i) => `<tr data-i="${i}">
        <td class="cell-main"><div class="cell-title"><a href="#/products/${r.product_id}">${esc(r.product_name)}</a>
          <div class="cell-meta"><span>${esc(r.company_name)}</span><a class="link" href="#/orders/${r.order_id}">${esc(r.platform_name)} ${esc(faDigits(r.order_number || ''))}</a>${r.reason ? `<span>${esc(r.reason)}</span>` : ''}</div></div></td>
        <td class="col-num" data-label="تعداد">${fa(r.units)} عدد</td>
        <td data-label="انبار">${esc(r.warehouse_name)}</td>
        <td data-label="${f.status === 'waiting' ? 'منتظر از' : 'تصمیم'}">${f.status === 'waiting'
          ? `${when(r.returned_at, 'date')} ${r.age_days >= 7 ? `<span class="badge badge-red">${fa(r.age_days)} روز</span>` : r.age_days >= 2 ? `<span class="badge badge-amber">${fa(r.age_days)} روز</span>` : ''}`
          : r.voided_at ? `<span class="badge">باطل</span><div class="small muted">${esc(r.void_reason || '')}</div>`
            : `<span class="badge ${LABEL[r.disposition][1]}">${LABEL[r.disposition][0]}</span>${r.value ? `<div class="small">کسر ${moneyText(r.value, r.currency)}</div>` : ''}<div class="small muted">${esc(r.disposition_by_name || '')} ${when(r.disposition_at)}</div>`}</td>
        <td class="col-actions">${f.status === 'waiting'
          ? `<button class="btn btn-sm btn-soft" type="button" data-decide="kept">نگه داشتیم</button> <button class="btn btn-sm" type="button" data-decide="to_company">برگشت به شرکت</button>
             <button class="btn btn-sm btn-ghost" type="button" data-decide="damaged">معیوب</button> <button class="btn btn-sm btn-ghost" type="button" data-void aria-label="ابطال">${icon('x')}</button>`
          : r.voided_at ? '' : `<button class="btn btn-sm btn-ghost" type="button" data-undo>${icon('refresh')}برگرداندن تصمیم</button>`}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  async function load() {
    ctx.setQuery(f);
    try { items = (await get('/returns', f)).items; paint(); } catch (err) { $('#rt-list', view).innerHTML = empty('alert', 'فهرست نیامد', err.message); }
  }

  $('#rt-q', view).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); load(); }, 250));
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.status) { f.status = b.dataset.status; $$('[data-status]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); return load(); }
    if (b.hasAttribute('data-new')) return newReturn(ctx, warehouses, load);
    const tr = b.closest('tr[data-i]');
    if (!tr) return;
    const r = items[Number(tr.dataset.i)];
    if (b.dataset.decide) {
      const label = { kept: 'نگه داشتیم (قابل فروش از انبار ما)', to_company: `برگشت به ${r.company_name} (از حساب این ماه کم می‌شود)`, damaged: 'معیوب (از موجودی حذف می‌شود)' }[b.dataset.decide];
      if (!(await confirm({ title: `${fa(r.units)} عدد «${r.product_name}»: ${label}؟`, yes: 'ثبت' }))) return;
      busy(b, true);
      try { await post(`/returns/${r.id}/decide`, { disposition: b.dataset.decide }); toast('ثبت شد.'); await load(); ctx.refreshCounts(); } catch (err) { toast(err.message, { error: true }); busy(b, false); }
    }
    if (b.hasAttribute('data-undo')) {
      try { await post(`/returns/${r.id}/undo`); toast('تصمیم برگردانده شد.'); await load(); } catch (err) { toast(err.message, { error: true }); }
    }
    if (b.hasAttribute('data-void')) {
      const body = openSheet('ابطال مرجوعی', `<form class="form" id="f-rv" novalidate><p>${esc(r.product_name)} — ${fa(r.units)} عدد</p>
        <div class="field"><label for="rv-reason">دلیل</label><input id="rv-reason" name="reason" required placeholder="مثلاً: اشتباه ثبت شده بود"></div>
        <div class="form-actions"><button class="btn btn-danger" type="submit">ابطال</button></div></form>`);
      const form = $('#f-rv', body);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!form.elements.reason.value.trim()) { fieldErrors(form, { reason: 'دلیل را بنویسید.' }); return; }
        try { await post(`/returns/${r.id}/void`, { reason: form.elements.reason.value.trim() }); closeSheet(); toast('باطل شد.'); await load(); ctx.refreshCounts(); } catch (err) { showError(form, err); }
      });
    }
  };
  await load();
  const off = ctx.subscribe('returns', debounce(load, 600));
  return () => off();
}

/** Record a return: find the order, pick the line, how many units, where. Also used from the order page. */
export function newReturn(ctx, warehouses, done, preset) {
  const body = openSheet('ثبت مرجوعی', `<form class="form" id="f-ret" novalidate>
    ${preset ? '' : `<div class="field"><label for="ret-order">شماره‌ی سفارش</label><input id="ret-order" dir="ltr" autocomplete="off" placeholder="شماره‌ی سفارش در دیجی‌کالا، باسلام، …"></div>`}
    <div id="ret-lines" aria-live="polite"></div>
    <div id="ret-fields" class="form" hidden>
      <div class="field"><label for="ret-units">چند عدد مرجوع شد؟</label><input id="ret-units" name="units" inputmode="numeric"><span class="hint" id="ret-hint"></span></div>
      <div class="field"><label for="ret-wh">به کدام انبار رسید؟</label><select id="ret-wh" name="warehouse_id">${warehouses.filter((w) => w.active).map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="ret-reason">دلیل (اختیاری)</label><input id="ret-reason" name="reason" placeholder="مثلاً: آسیب دیده بود، مشتری منصرف شد"></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت مرجوعی</button></div>
    </div></form>`);
  const form = $('#f-ret', body);
  let line = null;
  async function showLines(orderId) {
    const d = await get(`/orders/${orderId}`);
    const shipped = d.lines.filter((l) => l.units_from_company + l.units_from_stock > 0);
    $('#ret-lines', body).innerHTML = shipped.length ? `<fieldset class="outcomes"><legend class="field-label">کدام کالا؟ (${esc(d.order.platform_name)} ${esc(faDigits(d.order.order_number || ''))})</legend>
      ${shipped.map((l) => `<label class="outcome"><input type="radio" name="line" value="${l.id}"${preset && preset.lineId === l.id ? ' checked' : ''}><span><strong>${esc(l.product_name)}</strong><small>${esc(l.company_name)} · ${fa(l.units_from_company + l.units_from_stock)} عدد ارسال شده</small></span></label>`).join('')}</fieldset>`
      : `<p class="callout callout-warn small">${icon('info')}<span>از این سفارش هنوز چیزی ارسال نشده.</span></p>`;
    if (preset) pickLine(preset.lineId);
  }
  async function pickLine(id) {
    const c = await get(`/order-lines/${id}/returns`);
    line = { id, ...c };
    $('#ret-fields', body).hidden = false;
    $('#ret-hint', body).textContent = `حداکثر ${c.returnable} عدد (${c.shipped} ارسال شده${c.returned ? `، ${c.returned} قبلاً مرجوع شده` : ''}).`;
    form.elements.units.value = fa(c.returnable);
    form.elements.units.focus();
    form.elements.units.select();
  }
  if (preset) showLines(preset.orderId);
  else {
    const input = $('#ret-order', body);
    input.addEventListener('input', debounce(async () => {
      const q = latin(input.value).trim();
      line = null; $('#ret-fields', body).hidden = true;
      if (q.length < 3) { $('#ret-lines', body).innerHTML = ''; return; }
      const r = await get('/orders', { q, per: 5 });
      const exact = r.items.filter((o) => o.order_number && latin(o.order_number).includes(q));
      if (!exact.length) { $('#ret-lines', body).innerHTML = '<p class="small muted">سفارشی با این شماره پیدا نشد.</p>'; return; }
      if (exact.length === 1) return showLines(exact[0].id);
      $('#ret-lines', body).innerHTML = `<div class="list">${exact.map((o) => `<button class="list-item" type="button" data-order="${o.id}" style="padding-inline:0;text-align:start"><span class="grow"><span class="title">${esc(o.platform_name)} ${esc(faDigits(o.order_number))}</span><span class="sub">${esc(o.products || '')}</span></span></button>`).join('')}</div>`;
    }, 300));
  }
  body.addEventListener('click', (e) => { const b = e.target.closest('[data-order]'); if (b) showLines(Number(b.dataset.order)); });
  body.addEventListener('change', (e) => { if (e.target.name === 'line') pickLine(Number(e.target.value)); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!line) { toast('اول کالای سفارش را انتخاب کنید.', { error: true }); return; }
    const btn = $('button[type=submit]', form);
    busy(btn, true);
    try {
      await post(`/order-lines/${line.id}/returns`, { units: latin(form.elements.units.value), warehouse_id: Number(form.elements.warehouse_id.value), reason: form.elements.reason.value.trim() || undefined });
      closeSheet(); toast('مرجوعی ثبت شد؛ حالا درباره‌اش تصمیم بگیرید.'); if (done) await done(); ctx.refreshCounts();
    } catch (err) { showError(form, err); busy(btn, false); }
  });
}
