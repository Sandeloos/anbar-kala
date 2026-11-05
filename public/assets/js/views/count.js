/**
 * Stocktake (#/count?warehouse=): count what is really on the shelves of one warehouse.
 * Each row shows what the system expects; type the counted number (empty = not counted).
 * The draft is kept in this browser until it is submitted. Differences become corrections.
 */
import { get, post } from '../api.js';
import { $, esc, icon, fa, skeleton, empty, toast, busy, confirm, latin, debounce } from '../ui.js';
import { createPicker } from '../picker.js';

const KEY = (wh) => `anbar:count:${wh}`;
const load = (wh) => { try { return JSON.parse(localStorage.getItem(KEY(wh)) || '{}'); } catch { return {}; } };
const save = (wh, d) => { try { localStorage.setItem(KEY(wh), JSON.stringify(d)); } catch { /* private mode */ } };
const forget = (wh) => { try { localStorage.removeItem(KEY(wh)); } catch { /* private mode */ } };

export async function render(view, ctx) {
  const [{ items: warehouses }, { items: companies }] = await Promise.all([get('/warehouses'), get('/companies')]);
  const active = warehouses.filter((w) => w.active);
  let wh = Number(ctx.query.get('warehouse')) || (active[0] || {}).id;
  let rows = [];
  let draft = {};
  let filter = '';

  view.innerHTML = `
    <div><a class="back" href="#/stock">${icon('back')}موجودی انبار</a>
      <div class="page-head"><div><h1>انبارگردانی</h1><p>عددی که واقعاً روی قفسه است را بنویسید. ردیف خالی یعنی شمرده نشده و تغییری نمی‌کند. شمارش تا ثبت نهایی در همین مرورگر می‌ماند.</p></div></div></div>
    <div class="card toolbar">
      <select class="input" id="ct-wh" aria-label="انبار">${active.map((w) => `<option value="${w.id}"${w.id === wh ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      <label class="search"><span class="sr-only">جستجو</span>${icon('search')}<input type="search" id="ct-q" placeholder="پیدا کردن ردیف…"></label>
    </div>
    <section class="card card-flush" aria-label="ردیف‌های شمارش"><div id="ct-list">${skeleton(6)}</div></section>
    <section class="card form" aria-labelledby="h-found"><h2 id="h-found" style="font-size:16px">کالایی پیدا شد که در سیستم نیست؟</h2>
      <div class="form-row cols-2"><div class="picker"><label class="field-label" for="ct-pick">کالا</label><div class="search">${icon('search')}<input id="ct-pick" type="search" placeholder="جستجوی کالا…"></div></div>
      <div class="field"><label for="ct-owner">صاحب</label><select id="ct-owner"><option value="">خودمان</option>${companies.map((c) => `<option value="${c.id}">مال ${esc(c.name)}</option>`).join('')}</select></div></div></section>
    <div id="ct-bar"></div>`;

  const key = (r) => `${r.product_id}:${r.owner_company_id ?? ''}`;
  function paint() {
    const box = $('#ct-list', view);
    const shown = rows.filter((r) => !filter || r.product_name.includes(filter) || (r.owner_name || 'خودمان').includes(filter));
    box.innerHTML = shown.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">کالا</th><th scope="col">صاحب</th><th scope="col" class="col-num">در سیستم</th><th scope="col">شمارش</th><th scope="col" class="col-num">اختلاف</th></tr></thead>
      <tbody>${shown.map((r) => {
        const v = draft[key(r)];
        const diff = v === undefined || v === '' ? null : Number(v) - r.units;
        return `<tr data-k="${esc(key(r))}"><td class="cell-main"><div class="cell-title"><strong>${esc(r.product_name)}</strong>${r.units_per_pack > 1 ? `<small>بسته‌ی ${fa(r.units_per_pack)} عددی</small>` : ''}</div></td>
          <td data-label="صاحب">${r.owner_company_id ? `مال ${esc(r.owner_name)}` : 'خودمان'}</td>
          <td class="col-num" data-label="در سیستم">${fa(r.units)}</td>
          <td data-label="شمارش"><input class="pack-input" data-count inputmode="numeric" value="${v === undefined ? '' : fa(v)}" aria-label="شمارش ${esc(r.product_name)}"></td>
          <td class="col-num" data-label="اختلاف">${diff === null ? '<span class="muted">—</span>' : diff === 0 ? '<span class="badge badge-green">درست</span>' : `<span class="badge ${diff > 0 ? 'badge-blue' : 'badge-red'}">${diff > 0 ? '+' : '−'}${fa(Math.abs(diff))}</span>`}</td></tr>`;
      }).join('')}</tbody></table></div>` : empty('warehouse', 'این انبار موجودی ثبت‌شده‌ای ندارد', 'اگر کالایی روی قفسه هست، از پایین اضافه‌اش کنید.');
    paintBar();
  }
  function paintBar() {
    const counted = rows.filter((r) => draft[key(r)] !== undefined && draft[key(r)] !== '');
    const diffs = counted.filter((r) => Number(draft[key(r)]) !== r.units);
    $('#ct-bar', view).innerHTML = counted.length ? `<div class="bulk" role="region" aria-label="ثبت انبارگردانی"><strong>${fa(counted.length)} ردیف شمرده شد · ${fa(diffs.length)} اختلاف</strong>
      <button class="btn btn-accent" type="button" data-submit>${icon('check')}ثبت انبارگردانی</button><button class="btn btn-ghost" type="button" data-clear>پاک کردن شمارش</button></div>` : '';
  }
  async function reload() {
    draft = load(wh);
    const s = await get('/stock', { warehouse: wh });
    rows = s.items.map((r) => ({ ...r }));
    // Rows added by hand in an earlier session of this draft
    for (const k of Object.keys(draft._extra || {})) if (!rows.some((r) => key(r) === k)) rows.push(draft._extra[k]);
    paint();
  }

  $('#ct-wh', view).addEventListener('change', (e) => { wh = Number(e.target.value); ctx.setQuery({ warehouse: wh }); reload(); });
  $('#ct-q', view).addEventListener('input', debounce((e) => { filter = e.target.value.trim(); paint(); }, 200));
  view.addEventListener('change', (e) => {
    if (!e.target.matches('[data-count]')) return;
    const k = e.target.closest('tr').dataset.k;
    const raw = latin(e.target.value).replace(/[,،٬\s]/g, '');
    if (raw === '') delete draft[k];
    else if (!/^\d+$/.test(raw)) { toast('عدد صحیح وارد کنید.', { error: true }); e.target.value = ''; return; }
    else draft[k] = Number(raw);
    save(wh, draft);
    paint();
  });
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('[data-count]')) return;
    e.preventDefault();
    const all = [...view.querySelectorAll('[data-count]')];
    const next = all[all.indexOf(e.target) + 1];
    e.target.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => { const n = next && view.querySelector(`tr[data-k="${next.closest('tr').dataset.k}"] [data-count]`); if (n) n.focus(); }, 0);
  });
  createPicker($('#ct-pick', view), {
    params: () => ({ products_only: 1 }),
    onPick(it) {
      const owner = $('#ct-owner', view).value;
      const r = { product_id: it.product_id, owner_company_id: owner ? Number(owner) : null, owner_name: owner ? companies.find((c) => c.id === Number(owner)).name : null, product_name: it.name, units: 0, units_per_pack: it.units_per_pack };
      if (rows.some((x) => key(x) === key(r))) { toast('این ردیف در فهرست هست.'); return; }
      rows.push(r);
      draft._extra = { ...(draft._extra || {}), [key(r)]: r };
      save(wh, draft);
      paint();
      const input = view.querySelector(`tr[data-k="${key(r)}"] [data-count]`);
      if (input) input.focus();
    }
  });
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-clear')) { if (await confirm({ title: 'شمارش این انبار پاک شود؟', yes: 'پاک کن', danger: true })) { forget(wh); reload(); } return; }
    if (b.hasAttribute('data-submit')) {
      const counts = rows.filter((r) => draft[key(r)] !== undefined).map((r) => ({ product_id: r.product_id, owner_company_id: r.owner_company_id ?? null, counted: Number(draft[key(r)]) }));
      const diffs = rows.filter((r) => draft[key(r)] !== undefined && Number(draft[key(r)]) !== r.units).length;
      if (!(await confirm({ title: 'انبارگردانی ثبت شود؟', text: `${fa(counts.length)} ردیف شمرده شده و ${fa(diffs)} ردیف اختلاف دارد. برای هر اختلاف یک اصلاح موجودی با نام شما ثبت می‌شود.`, yes: 'ثبت' }))) return;
      busy(b, true);
      try {
        const r = await post('/stock/count', { warehouse_id: wh, counts, note: `انبار ${active.find((w) => w.id === wh).name}` });
        forget(wh);
        toast(`ثبت شد: ${fa(r.changed)} ردیف اصلاح شد (${fa(r.plus)} عدد اضافه، ${fa(r.minus)} عدد کم).`);
        await reload();
      } catch (err) { toast(err.message, { error: true }); busy(b, false); }
    }
  };
  await reload();
}
