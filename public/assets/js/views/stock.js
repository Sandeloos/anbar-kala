/**
 * Stock in our warehouses (#/stock): by product, warehouse and owner (a partner company,
 * or our own goods). Operations: our goods in, surplus back to the company, transfer,
 * correction; and every movement of a row.
 */
import { get, post } from '../api.js';
import { $, esc, icon, fa, when, skeleton, empty, toast, openSheet, closeSheet, showError, busy, debounce, latin, moneyText } from '../ui.js';
import { createPicker } from '../picker.js';

export async function render(view, ctx) {
  const f = { q: ctx.query.get('q') || '', owner: ctx.query.get('owner') || '', warehouse: ctx.query.get('warehouse') || '' };
  const [{ items: companies }, { items: warehouses }] = await Promise.all([get('/companies'), get('/warehouses')]);
  const activeWh = warehouses.filter((w) => w.active);
  let data = null;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>موجودی انبار</h1><p>هر ردیف: کالا، صاحبش (یکی از شرکت‌ها یا خودمان) و انباری که در آن است. همه به عدد.</p></div>
      <div class="page-actions"><button class="btn btn-primary" type="button" data-own-in>${icon('plus')}ورود کالای خودمان</button></div>
    </div>
    <div class="metrics" id="s-totals"></div>
    <div class="card toolbar">
      <label class="search"><span class="sr-only">جستجو</span>${icon('search')}<input type="search" id="s-q" value="${esc(f.q)}" placeholder="نام یا کد کالا…"></label>
      <select class="input" id="s-owner" aria-label="صاحب کالا"><option value="">همه‌ی صاحبان</option><option value="own"${f.owner === 'own' ? ' selected' : ''}>کالای خودمان</option>
        ${companies.map((c) => `<option value="${c.id}"${String(c.id) === f.owner ? ' selected' : ''}>مال ${esc(c.name)}</option>`).join('')}</select>
      <select class="input" id="s-wh" aria-label="انبار"><option value="">همه‌ی انبارها</option>${warehouses.map((w) => `<option value="${w.id}"${String(w.id) === f.warehouse ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    </div>
    <section class="card card-flush" aria-label="موجودی"><div id="s-list">${skeleton(6)}</div></section>`;

  function paint() {
    $('#s-totals', view).innerHTML = `
      <div class="metric">${icon('warehouse')}<strong>${fa(data.totals.own)}</strong><span>عدد کالای خودمان</span></div>
      <div class="metric tone-orange">${icon('building')}<strong>${fa(data.totals.consigned)}</strong><span>عدد کالای امانی شرکت‌ها (اضافه‌ها)</span></div>`;
    const box = $('#s-list', view);
    if (!data.items.length) {
      box.innerHTML = empty('warehouse', 'موجودی‌ای نیست', 'کالای اضافه‌ای که از شرکت‌ها می‌رسد، کالای اشتباه و کالای خودتان اینجا دیده می‌شود.');
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">کالا</th><th scope="col">صاحب</th><th scope="col">انبار</th><th scope="col" class="col-num">موجودی</th><th scope="col">آخرین گردش</th><th scope="col" class="col-actions"><span class="sr-only">کارها</span></th></tr></thead>
      <tbody>${data.items.map((r, i) => `<tr data-i="${i}">
        <td class="cell-main"><div class="cell-title"><a href="#/products/${r.product_id}">${esc(r.product_name)}</a><div class="cell-meta"><span>${esc(r.company_name)}</span></div></div></td>
        <td data-label="صاحب">${r.owner_company_id ? `<span class="badge badge-orange">مال ${esc(r.owner_name)}</span>` : '<span class="badge badge-navy">خودمان</span>'}</td>
        <td data-label="انبار">${esc(r.warehouse_name)}</td>
        <td class="col-num" data-label="موجودی"><b>${fa(r.units)}</b> عدد${r.units_per_pack > 1 ? `<div class="small muted">${fa(Math.floor(r.units / r.units_per_pack))} بسته‌ی کامل${r.units % r.units_per_pack ? ` + ${fa(r.units % r.units_per_pack)}` : ''}</div>` : ''}</td>
        <td data-label="آخرین گردش">${when(r.last_move_at)}</td>
        <td class="col-actions">
          ${r.owner_company_id ? `<button class="btn btn-sm" type="button" data-op="return">برگشت به شرکت</button>` : ''}
          <button class="btn btn-sm btn-ghost" type="button" data-op="transfer">انتقال</button>
          <button class="btn btn-sm btn-ghost" type="button" data-op="adjust">اصلاح</button>
          <button class="btn btn-sm btn-ghost" type="button" data-op="moves">گردش</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  async function load() {
    ctx.setQuery(f);
    try { data = await get('/stock', f); paint(); } catch (err) { $('#s-list', view).innerHTML = empty('alert', 'موجودی نیامد', err.message); }
  }

  $('#s-q', view).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); load(); }, 250));
  $('#s-owner', view).addEventListener('change', (e) => { f.owner = e.target.value; load(); });
  $('#s-wh', view).addEventListener('change', (e) => { f.warehouse = e.target.value; load(); });

  const whSelect = (name, sel, except) => `<select id="op-${name}" name="${name}">${activeWh.filter((w) => w.id !== except).map((w) => `<option value="${w.id}"${w.id === sel ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</select>`;
  const ownerText = (r) => (r.owner_company_id ? `مال ${r.owner_name}` : 'کالای خودمان');

  async function submit(form, url, payload) {
    const btn = $('button[type=submit]', form);
    busy(btn, true);
    try { await post(url, payload); closeSheet(); toast('ثبت شد.'); await load(); } catch (err) { showError(form, err); busy(btn, false); }
  }

  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-own-in')) return ownInSheet();
    if (!b.dataset.op) return;
    const r = data.items[Number(b.closest('tr').dataset.i)];
    const head = `<p><b>${esc(r.product_name)}</b><br><span class="small muted">${esc(ownerText(r))} · انبار ${esc(r.warehouse_name)} · موجود ${fa(r.units)} عدد</span></p>`;
    const n = (s) => latin(s).replace(/[,،٬\s]/g, '');
    if (b.dataset.op === 'return') {
      const body = openSheet('برگشت به شرکت', `<form class="form" id="f-op" novalidate>${head}
        <div class="field"><label for="op-units">چند عدد برگشت داده شد؟</label><input id="op-units" name="units" inputmode="numeric" value="${fa(r.units)}"></div>
        <div class="field"><label for="op-note">یادداشت</label><input id="op-note" name="note" placeholder="مثلاً شماره‌ی بارنامه"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت برگشت</button></div></form>`);
      const form = $('#f-op', body);
      form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(form, '/stock/return', { product_id: r.product_id, warehouse_id: r.warehouse_id, owner_company_id: r.owner_company_id, units: n(form.elements.units.value), note: form.elements.note.value.trim() || undefined }); });
    }
    if (b.dataset.op === 'transfer') {
      if (activeWh.length < 2) { toast('برای انتقال دست‌کم دو انبار فعال لازم است.', { error: true }); return; }
      const body = openSheet('انتقال بین انبارها', `<form class="form" id="f-op" novalidate>${head}
        <div class="field"><label for="op-to_warehouse_id">به انبار</label>${whSelect('to_warehouse_id', null, r.warehouse_id)}</div>
        <div class="field"><label for="op-units">چند عدد؟</label><input id="op-units" name="units" inputmode="numeric" value="${fa(r.units)}"></div>
        <div class="field"><label for="op-note">یادداشت</label><input id="op-note" name="note"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت انتقال</button></div></form>`);
      const form = $('#f-op', body);
      form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(form, '/stock/transfer', { product_id: r.product_id, warehouse_id: r.warehouse_id, to_warehouse_id: Number(form.elements.to_warehouse_id.value), owner_company_id: r.owner_company_id ?? 'own', units: n(form.elements.units.value), note: form.elements.note.value.trim() || undefined }); });
    }
    if (b.dataset.op === 'adjust') {
      const body = openSheet('اصلاح موجودی', `<form class="form" id="f-op" novalidate>${head}
        <div class="field"><label for="op-count">موجودی واقعی (شمارش‌شده)</label><input id="op-count" name="count" inputmode="numeric" value="${fa(r.units)}">
          <span class="hint" id="op-diff"></span></div>
        <div class="field"><label for="op-note">دلیل</label><input id="op-note" name="note" required placeholder="مثلاً: شمارش آخر هفته، ۲ عدد شکسته بود"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت اصلاح</button></div></form>`);
      const form = $('#f-op', body);
      const diff = () => Number(n(form.elements.count.value)) - r.units;
      form.elements.count.addEventListener('input', () => { const d = diff(); $('#op-diff', body).textContent = Number.isNaN(d) || !d ? '' : `${d > 0 ? 'اضافه' : 'کم'} شدن ${fa(Math.abs(d))} عدد ثبت می‌شود.`; });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (!diff()) { toast('موجودی تغییری نکرده است.', { error: true }); return; }
        submit(form, '/stock/adjust', { product_id: r.product_id, warehouse_id: r.warehouse_id, owner_company_id: r.owner_company_id ?? 'own', units: diff(), note: form.elements.note.value.trim() });
      });
    }
    if (b.dataset.op === 'moves') {
      const m = await get('/stock/moves', { product: r.product_id, warehouse: r.warehouse_id, owner: r.owner_company_id ?? 'own', per: 100 });
      openSheet('گردش موجودی', `${head}<div class="list">${m.items.map((x) => `<div class="list-item" style="padding-inline:0">
        <span class="list-icon ${x.units > 0 ? 'down' : 'up'}">${icon(x.units > 0 ? 'dn' : 'up')}</span>
        <span class="grow"><span class="title">${x.units > 0 ? '+' : '−'}${fa(Math.abs(x.units))} عدد · ${esc(x.kind_label)}</span>
          <span class="sub"><span>${when(x.created_at)}</span>${x.user_name ? `<span>${esc(x.user_name)}</span>` : ''}
          ${x.order_id ? `<a class="link" href="#/orders/${x.order_id}">${esc(x.platform_name || '')} ${esc(x.order_number || '')}</a>` : ''}
          ${x.value ? `<span>ارزش برای شرکت: ${moneyText(x.value, x.currency)}</span>` : ''}${x.note ? `<span>${esc(x.note)}</span>` : ''}${x.reversed_by ? '<span class="badge">برگردانده شده</span>' : ''}</span></span></div>`).join('')}</div>`);
    }
  };

  function ownInSheet() {
    const body = openSheet('ورود کالای خودمان', `<form class="form" id="f-own" novalidate>
      <p class="small muted">کالایی که مال خودمان است (خریده‌ایم یا مرجوعی که نگه داشته‌ایم). در گزارش هیچ شرکتی حساب نمی‌شود.</p>
      <div class="picker"><label class="field-label" for="own-pick">کالا</label><div class="search">${icon('search')}<input id="own-pick" type="search" placeholder="جستجوی کالا…"></div></div>
      <div id="own-chosen"></div>
      <div class="field"><label for="own-wh">انبار</label>${whSelect('warehouse_id', (activeWh[0] || {}).id).replace('id="op-warehouse_id"', 'id="own-wh"')}</div>
      <div class="field"><label for="own-units">چند عدد؟</label><input id="own-units" name="units" inputmode="numeric"></div>
      <div class="field"><label for="own-note">یادداشت</label><input id="own-note" name="note" placeholder="مثلاً: خرید از شرکت، فاکتور ۱۲۳"></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت</button></div></form>`);
    const form = $('#f-own', body);
    let product = null;
    createPicker($('#own-pick', body), {
      params: () => ({ products_only: 1 }),
      onPick(it) { product = it; $('#own-chosen', body).innerHTML = `<div class="callout callout-info small">${icon('box')}<span>${esc(it.name)} — ${esc(it.company_name)} (${fa(it.units_per_pack)} عدد در هر بسته)</span></div>`; }
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!product) { toast('کالا را انتخاب کنید.', { error: true }); return; }
      submit(form, '/stock/own-in', { product_id: product.product_id, warehouse_id: Number(form.elements.warehouse_id.value), units: latin(form.elements.units.value).replace(/[,،٬\s]/g, ''), note: form.elements.note.value.trim() || undefined });
    });
  }

  await load();
  const off = ctx.subscribe('stock', debounce(() => load(), 700));
  return () => off();
}
