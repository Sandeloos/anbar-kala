/**
 * Daily receiving (#/receiving?company=&scope=). For one company: everything it should have
 * sent (orders up to yesterday by default). Most lines are fine: tick them and press
 * "all arrived right". For the rest, "problem…" records what happened (the five cases).
 */
import { get, post } from '../api.js';
import {
  $, $$, esc, icon, fa, when, skeleton, empty, toast, openSheet, closeSheet, showError, busy, debounce, confirm, faDigits, latin, colorFor, initials
} from '../ui.js';
import { gregorianDay } from '../jalali.js';
import { createPicker } from '../picker.js';
import { lineStatus } from './orders.js';

export async function render(view, ctx) {
  const f = { company: ctx.query.get('company') || '', scope: ctx.query.get('scope') || '' };
  const { items: warehouses } = await get('/warehouses');
  const activeWh = warehouses.filter((w) => w.active);
  let data = null;
  const selected = new Set();

  view.innerHTML = `
    <div class="page-head">
      <div><h1>دریافت روزانه</h1><p>کالاهایی که هر شرکت باید برای سفارش‌ها می‌فرستاد. هر ردیف را تیک بزنید یا مشکلش را ثبت کنید.</p></div>
      <div class="page-actions"><button class="btn" type="button" data-unexpected>${icon('plus')}کالای بدون سفارش رسید</button></div>
    </div>
    <div id="r-companies" class="company-tabs" role="group" aria-label="شرکت">${skeleton(1)}</div>
    <div class="seg" role="group" aria-label="کدام سفارش‌ها">
      <button type="button" data-scope="" aria-pressed="${!f.scope}">سفارش‌های تا دیروز</button>
      <button type="button" data-scope="all" aria-pressed="${f.scope === 'all'}">همه، حتی امروز</button>
    </div>
    <section class="card card-flush" aria-label="ردیف‌های دریافت"><div id="r-list"></div></section>
    <div id="r-bulk"></div>`;

  function paintCompanies() {
    const box = $('#r-companies', view);
    if (!data.companies.length) { box.innerHTML = ''; return; }
    box.innerHTML = data.companies.map((c) => {
      const n = f.scope === 'all' ? c.pending : c.due;
      return `<button class="company-tab" type="button" data-company="${c.id}" aria-pressed="${String(c.id) === f.company}">
        <span class="logo sm" style="background:${colorFor(c.name)}" aria-hidden="true">${esc(initials(c.name))}</span>
        <span><strong>${esc(c.name)}</strong><small>${n ? `${fa(n)} منتظر` : 'چیزی منتظر نیست'}${c.done_today ? ` · ${fa(c.done_today)} امروز` : ''}</small></span></button>`;
    }).join('');
  }

  function rowHtml(l) {
    const pending = l.status === 'pending';
    return `<tr data-id="${l.id}" class="${selected.has(l.id) ? 'is-selected' : ''}">
      <td class="col-check">${pending ? `<input type="checkbox" class="row-check" aria-label="انتخاب ${esc(l.product_name)}" ${selected.has(l.id) ? 'checked' : ''}>` : ''}</td>
      <td class="cell-main"><div class="cell-title"><a href="#/products/${l.product_id}">${esc(l.product_name)}</a>
        <div class="cell-meta"><a class="link" href="#/orders/${l.order_id}">${esc(l.platform_name)} ${l.order_number ? `<span class="ltr">${esc(faDigits(l.order_number))}</span>` : ''}</a><span>${when(l.ordered_at)}</span>
        ${l.listing_title && l.listing_title !== l.product_name ? `<span>${esc(l.listing_title)}</span>` : ''}</div></div></td>
      <td class="col-num" data-label="باید برسد"><b>${fa(l.units_total)}</b> عدد${l.qty > 1 || l.units_per_sale !== l.product_units ? `<div class="small muted">${fa(l.qty)} × ${fa(l.units_per_sale)}</div>` : ''}</td>
      <td data-label="موجودی ما">${l.stock_available > 0 ? `<span class="badge badge-blue">${fa(l.stock_available)} عدد در انبار</span>` : '<span class="muted small">—</span>'}</td>
      <td data-label="وضعیت">${lineStatus(l)}${!pending ? `<div class="small muted">${detail(l)}</div>` : ''}</td>
      <td class="col-actions">${pending
        ? `<button class="btn btn-sm btn-soft" type="button" data-ok>${icon('check')}درست رسید</button> <button class="btn btn-sm" type="button" data-problem>مشکل…</button>`
        : `<button class="btn btn-sm btn-ghost" type="button" data-undo title="برگرداندن به انتظار">${icon('refresh')}برگرداندن</button>`}</td>
    </tr>`;
  }
  const detail = (l) => [
    l.units_from_company ? `${fa(l.units_from_company)} از شرکت` : '',
    l.units_from_stock ? `${fa(l.units_from_stock)} از انبار ما` : '',
    l.units_cancelled ? `${fa(l.units_cancelled)} لغو` : '',
    l.received_by_name ? `${esc(l.received_by_name)}` : ''
  ].filter(Boolean).join('، ');

  function paintList() {
    const box = $('#r-list', view);
    if (!f.company) {
      box.innerHTML = empty('warehouse', 'یک شرکت را انتخاب کنید', data.companies.length ? 'بالا روی شرکتی که کالاهایش رسیده بزنید.' : 'هنوز شرکتی ثبت نشده.');
      return;
    }
    const pending = data.lines.filter((l) => l.status === 'pending');
    const done = data.lines.filter((l) => l.status !== 'pending');
    if (!data.lines.length) {
      box.innerHTML = empty('check', 'چیزی منتظر نیست', f.scope ? 'برای این شرکت ردیف منتظری نیست.' : 'سفارش‌های تا دیروز همه تعیین تکلیف شده‌اند. سفارش‌های امروز را با «همه، حتی امروز» ببینید.');
      return;
    }
    const allChecked = pending.length && pending.every((l) => selected.has(l.id));
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <caption class="sr-only">ردیف‌های دریافت</caption>
      <thead><tr><th scope="col" class="col-check">${pending.length ? `<input type="checkbox" id="check-all" aria-label="انتخاب همه‌ی منتظرها" ${allChecked ? 'checked' : ''}>` : ''}</th>
        <th scope="col">کالا و سفارش</th><th scope="col" class="col-num">باید برسد</th><th scope="col">موجودی ما</th><th scope="col">وضعیت</th><th scope="col" class="col-actions"><span class="sr-only">کارها</span></th></tr></thead>
      <tbody>${pending.map(rowHtml).join('')}${done.length ? `<tr class="group-row"><td colspan="6">دریافت‌شده‌های امروز (${fa(done.length)})</td></tr>${done.map(rowHtml).join('')}` : ''}</tbody></table></div>`;
  }
  function paintBulk() {
    const box = $('#r-bulk', view);
    if (!selected.size) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="bulk" role="region" aria-label="دریافت گروهی"><strong>${fa(selected.size)} ردیف انتخاب شده</strong>
      <button class="btn btn-accent" type="button" data-bulk-ok>${icon('check')}همه درست رسید و ارسال شد</button>
      <button class="btn btn-ghost" type="button" data-bulk-clear>لغو انتخاب</button></div>`;
  }

  let token = 0;
  async function load() {
    ctx.setQuery(f);
    const t = ++token;
    try {
      const fresh = await get('/receiving', { company: f.company, until: f.scope === 'all' ? gregorianDay(1) : gregorianDay(0) });
      // A slower, older request must not overwrite a newer answer (live reloads overlap)
      if (t !== token) return;
      data = fresh;
      if (!f.company && data.companies.length) {
        const first = data.companies.find((c) => (f.scope === 'all' ? c.pending : c.due) > 0);
        if (first) { f.company = String(first.id); return load(); }
      }
      for (const id of [...selected]) if (!data.lines.some((l) => l.id === id && l.status === 'pending')) selected.delete(id);
      paintCompanies(); paintList(); paintBulk();
    } catch (err) { $('#r-list', view).innerHTML = empty('alert', 'فهرست نیامد', err.message); }
  }

  view.onclick = async (e) => {
    const b = e.target.closest('button, input[type=checkbox]');
    if (!b) return;
    if (b.dataset.company) { f.company = b.dataset.company; selected.clear(); return load(); }
    if (b.dataset.scope !== undefined) {
      f.scope = b.dataset.scope;
      $$('[data-scope]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      return load();
    }
    if (b.id === 'check-all') {
      data.lines.filter((l) => l.status === 'pending').forEach((l) => (b.checked ? selected.add(l.id) : selected.delete(l.id)));
      paintList(); paintBulk();
      return;
    }
    if (b.classList.contains('row-check')) {
      const id = Number(b.closest('tr').dataset.id);
      if (b.checked) selected.add(id); else selected.delete(id);
      b.closest('tr').classList.toggle('is-selected', b.checked);
      paintBulk();
      return;
    }
    if (b.hasAttribute('data-bulk-clear')) { selected.clear(); paintList(); paintBulk(); return; }
    if (b.hasAttribute('data-bulk-ok')) {
      busy(b, true);
      try {
        const r = await post('/receiving/ok', { ids: [...selected] });
        toast(`${fa(r.done)} ردیف ثبت شد: درست رسید و ارسال شد.${r.errors.length ? ` ${fa(r.errors.length)} ردیف ثبت نشد.` : ''}`, { error: !!r.errors.length });
        selected.clear();
        await load();
        ctx.refreshCounts();
      } catch (err) { toast(err.message, { error: true }); busy(b, false); }
      return;
    }
    if (b.hasAttribute('data-unexpected')) return unexpectedSheet();
    const tr = b.closest('tr[data-id]');
    if (!tr) return;
    const l = data.lines.find((x) => x.id === Number(tr.dataset.id));
    if (!l) { await load(); return; }
    if (b.hasAttribute('data-ok')) {
      busy(b, true);
      try { await post(`/order-lines/${l.id}/receive`, { outcome: 'ok' }); selected.delete(l.id); await load(); ctx.refreshCounts(); } catch (err) { toast(err.message, { error: true }); busy(b, false); }
    }
    if (b.hasAttribute('data-undo')) {
      if (!(await confirm({ title: 'این ردیف به حالت انتظار برگردد؟', text: 'هر چیزی که با این دریافت به انبار رفته یا از انبار برداشته شده برعکس ثبت می‌شود.', yes: 'برگرداندن' }))) return;
      try { await post(`/order-lines/${l.id}/undo`); await load(); ctx.refreshCounts(); toast('به حالت انتظار برگشت.'); } catch (err) { toast(err.message, { error: true }); }
    }
    if (b.hasAttribute('data-problem')) problemSheet(l);
  };

  /* ---------- the four problem cases ---------- */
  async function problemSheet(l) {
    const info = await get(`/order-lines/${l.id}/stock`);
    const options = [{ id: l.product_id, name: l.product_name }, ...info.siblings.map((s) => ({ id: s.id, name: s.name, units: s.units_per_pack }))];
    const whOptions = (sel) => activeWh.map((w) => `<option value="${w.id}"${w.id === sel ? ' selected' : ''}>${esc(w.name)}</option>`).join('');
    const defaultWh = info.line.product_warehouse_id || info.line.company_warehouse_id || (activeWh[0] || {}).id;
    const body = openSheet(`مشکل در «${l.product_name}»`, `<form class="form" id="f-prob" novalidate>
      <p class="small muted">باید ${fa(l.units_total)} عدد می‌رسید (${esc(l.platform_name)} ${esc(faDigits(l.order_number || ''))}).</p>
      <fieldset class="outcomes"><legend class="field-label">چه شد؟</legend>
        <label class="outcome"><input type="radio" name="outcome" value="excess"><span><strong>اضافه رسید</strong><small>مثلاً بسته‌ی ۱۰۰ تایی به‌جای ۲۵ تایی؛ اضافه‌ها به انبار ما می‌رود ولی مال شرکت است</small></span></label>
        <label class="outcome"><input type="radio" name="outcome" value="short"><span><strong>کم رسید یا نرسید</strong><small>باقی از انبار ما ارسال می‌شود یا لغو می‌شود</small></span></label>
        <label class="outcome"><input type="radio" name="outcome" value="wrong"><span><strong>اشتباه رسید</strong><small>کالای دیگری فرستاده‌اند</small></span></label>
        <label class="outcome"><input type="radio" name="outcome" value="cancelled"><span><strong>سفارش لغو شد</strong><small>مشتری لغو کرده و چیزی ارسال نمی‌شود</small></span></label>
      </fieldset>
      <div id="p-excess" class="form" hidden>
        <div class="field"><label for="x-product">چه رسید؟</label><select id="x-product" name="arrived_product_id">${options.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="x-units">چند عدد رسید؟</label><input id="x-units" name="arrived_units_x" inputmode="numeric" placeholder="مثلاً ۱۰۰"></div>
        <div class="field"><label for="x-wh">اضافه‌ها به کدام انبار می‌رود؟</label><select id="x-wh" name="warehouse_x">${whOptions(defaultWh)}</select></div>
        <p class="callout callout-info small" id="x-preview" hidden></p>
      </div>
      <div id="p-wrong" class="form" hidden>
        <div class="picker"><label class="field-label" for="w-pick">چه رسید؟ (از کالاهای ${esc(l.company_name)})</label><div class="search">${icon('search')}<input id="w-pick" type="search" placeholder="جستجوی کالا…"></div></div>
        <div id="w-chosen"></div>
        <div class="field"><label for="w-desc">یا توضیح کالا (اگر بین کالاهای شرکت نیست)</label><input id="w-desc" name="arrived_description"></div>
        <div class="field"><label for="w-units">چند عدد؟</label><input id="w-units" name="arrived_units_w" inputmode="numeric"></div>
        <fieldset class="field"><legend class="field-label">کالای اشتباه کجا می‌رود؟</legend>
          <label class="check"><input type="radio" name="wrong_to" value="stock" checked> به انبار ما (مال شرکت می‌ماند)</label>
          <label class="check"><input type="radio" name="wrong_to" value="returned"> همان موقع به شرکت برگشت داده شد</label></fieldset>
        <div class="field"><label for="w-wh">انبار</label><select id="w-wh" name="warehouse_w">${whOptions(defaultWh)}</select></div>
      </div>
      <div id="p-short" class="form" hidden>
        <div class="field"><label for="s-units">چند عدد رسید؟</label><input id="s-units" name="arrived_units_s" inputmode="numeric" value="۰"></div>
      </div>
      <div id="p-rest" class="form" hidden>
        <fieldset class="field"><legend class="field-label">سفارش (یا باقی آن) چه شد؟</legend>
          <label class="check"><input type="radio" name="rest" value="stock" ${info.available.length ? 'checked' : 'disabled'}> از انبار ما ارسال شد${info.available.length ? '' : ' (موجودی نداریم)'}</label>
          <label class="check"><input type="radio" name="rest" value="cancel" ${info.available.length ? '' : 'checked'}> لغو شد</label></fieldset>
        <div id="picks"></div>
      </div>
      <div class="field"><label for="p-note">یادداشت (اختیاری)</label><input id="p-note" name="note"></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت</button></div>
    </form>`);
    const form = $('#f-prob', body);
    let wrongProduct = null;
    createPicker($('#w-pick', body), {
      params: () => ({ company: l.company_id, products_only: 1 }),
      onPick(it) { wrongProduct = it; $('#w-chosen', body).innerHTML = `<div class="callout callout-info small">${icon('box')}<span>${esc(it.name)}</span></div>`; }
    });
    const n = (s) => Number(latin(s || '').replace(/[,،٬\s]/g, ''));
    function restUnits() {
      const o = form.elements.outcome.value;
      if (o === 'short') return Math.max(0, l.units_total - (n(form.elements.arrived_units_s.value) || 0));
      if (o === 'wrong') return l.units_total;
      return 0;
    }
    function paintPicks() {
      const box = $('#picks', body);
      const units = restUnits();
      if (form.elements.rest.value !== 'stock' || !units) { box.innerHTML = ''; return; }
      let left = units;
      const rows = info.available.map((a) => { const take = Math.min(left, a.units); left -= take; return { ...a, take }; });
      box.innerHTML = `<div class="picks"><p class="small">باید <b>${fa(units)}</b> عدد از انبار برداشته شود. پیشنهاد (اول اضافه‌های خود ${esc(l.company_name)}):</p>
        ${rows.map((a, i) => `<div class="pick-row"><span class="grow"><b>${esc(a.owner_name || 'خودمان')}</b> · ${esc(a.warehouse_name)}<br><span class="small muted">${esc(a.product_name)} — موجود ${fa(a.units)} عدد</span></span>
          <label class="sr-only" for="pk-${i}">برداشت</label><input id="pk-${i}" class="pack-input" data-pick="${i}" inputmode="numeric" value="${fa(a.take)}"></div>`).join('')}
        ${left > 0 ? `<p class="callout callout-err small">${icon('alert')}<span>موجودی کافی نیست؛ ${fa(left)} عدد کم است. «لغو شد» را بزنید یا تعداد رسیده را درست کنید.</span></p>` : ''}</div>`;
      box._rows = rows;
    }
    function show() {
      const o = form.elements.outcome.value;
      $('#p-excess', body).hidden = o !== 'excess';
      $('#p-wrong', body).hidden = o !== 'wrong';
      $('#p-short', body).hidden = o !== 'short';
      $('#p-rest', body).hidden = !(o === 'short' || o === 'wrong');
      $('#w-wh', body).closest('.field').hidden = form.elements.wrong_to.value !== 'stock';
      const xu = n(form.elements.arrived_units_x.value);
      const prev = $('#x-preview', body);
      if (o === 'excess' && xu > l.units_total) {
        prev.hidden = false;
        prev.textContent = `${fa(l.units_total)} عدد ارسال می‌شود و ${fa(xu - l.units_total)} عدد به انبار ${form.elements.warehouse_x.selectedOptions[0].textContent} می‌رود (مال ${l.company_name}).`;
      } else prev.hidden = true;
      paintPicks();
    }
    form.addEventListener('change', (e) => { if (!e.target.dataset.pick) show(); });
    form.addEventListener('input', (e) => { if (/arrived_units/.test(e.target.name)) show(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const o = form.elements.outcome.value;
      if (!o) { toast('اول بگویید چه شد.', { error: true }); return; }
      const payload = { outcome: o, note: form.elements.note.value.trim() || undefined };
      if (o === 'excess') Object.assign(payload, { arrived_units: n(form.elements.arrived_units_x.value), arrived_product_id: Number(form.elements.arrived_product_id.value), warehouse_id: Number(form.elements.warehouse_x.value) });
      if (o === 'short') Object.assign(payload, { arrived_units: n(form.elements.arrived_units_s.value) || 0 });
      if (o === 'wrong') Object.assign(payload, { arrived_units: n(form.elements.arrived_units_w.value) || 0, arrived_product_id: wrongProduct ? wrongProduct.product_id : undefined,
        arrived_description: form.elements.arrived_description.value.trim() || undefined, wrong_to: form.elements.wrong_to.value, warehouse_id: Number(form.elements.warehouse_w.value) });
      if (o === 'short' || o === 'wrong') {
        payload.rest = form.elements.rest.value || 'cancel';
        const rows = $('#picks', body)._rows;
        if (payload.rest === 'stock' && rows) {
          payload.picks = rows.map((a, i) => ({ product_id: a.product_id, warehouse_id: a.warehouse_id, owner_company_id: a.owner_company_id, units: n($(`[data-pick="${i}"]`, body).value) || 0 })).filter((p) => p.units > 0);
        }
      }
      const btn = $('button[type=submit]', form);
      busy(btn, true);
      try {
        await post(`/order-lines/${l.id}/receive`, payload);
        closeSheet();
        toast('ثبت شد.');
        await load();
        ctx.refreshCounts();
      } catch (err) { showError(form, err); busy(btn, false); }
    });
  }

  function unexpectedSheet() {
    const comp = data.companies.find((c) => String(c.id) === f.company);
    const body = openSheet('کالای بدون سفارش رسید', `<form class="form" id="f-unx" novalidate>
      <div class="field"><label for="u-company">از کدام شرکت؟</label><select id="u-company" name="company_id">${data.companies.map((c) => `<option value="${c.id}"${comp && c.id === comp.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="picker"><label class="field-label" for="u-pick">کالا</label><div class="search">${icon('search')}<input id="u-pick" type="search" placeholder="جستجوی کالای شرکت…"></div></div>
      <div id="u-chosen"></div>
      <div class="field"><label for="u-desc">یا توضیح (اگر بین کالاهای شرکت نیست)</label><input id="u-desc" name="description"></div>
      <div class="field"><label for="u-units">چند عدد؟</label><input id="u-units" name="units" inputmode="numeric"></div>
      <fieldset class="field"><legend class="field-label">کجا رفت؟</legend>
        <label class="check"><input type="radio" name="disposition" value="stock" checked> به انبار ما (مال شرکت می‌ماند)</label>
        <label class="check"><input type="radio" name="disposition" value="returned"> به شرکت برگشت داده شد</label></fieldset>
      <div class="field"><label for="u-wh">انبار</label><select id="u-wh" name="warehouse_id">${activeWh.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="u-note">یادداشت</label><input id="u-note" name="note"></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت</button></div></form>`);
    const form = $('#f-unx', body);
    let product = null;
    createPicker($('#u-pick', body), {
      params: () => ({ company: form.elements.company_id.value, products_only: 1 }),
      onPick(it) { product = it; $('#u-chosen', body).innerHTML = `<div class="callout callout-info small">${icon('box')}<span>${esc(it.name)}</span></div>`; }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await post('/arrivals', {
          company_id: Number(form.elements.company_id.value), product_id: product ? product.product_id : undefined, description: form.elements.description.value.trim() || undefined,
          units: latin(form.elements.units.value), disposition: form.elements.disposition.value, warehouse_id: Number(form.elements.warehouse_id.value), note: form.elements.note.value.trim() || undefined
        });
        closeSheet();
        toast('ثبت شد.');
      } catch (err) { showError(form, err); }
    });
  }

  await load();
  const reload = debounce(() => load(), 700);
  const offs = [ctx.subscribe('orders', reload), ctx.subscribe('stock', reload)];
  return () => offs.forEach((o) => o());
}
