/**
 * The inbox (#/inbox): what to change on Digikala / Basalam because a company site changed.
 * Price tasks suggest a new platform price with the same margin; "done" records the price
 * actually set (it becomes the listing's price). Stock tasks say what happened to the site stock.
 */
import { get, post } from '../api.js';
import { $, $$, esc, icon, fa, money, moneyText, delta, when, skeleton, empty, toast, openSheet, closeSheet, showError, fieldErrors, busy, debounce, copy, latin, inCurrency, STOCK } from '../ui.js';

const STATUS = { done: ['انجام شد', 'badge-green'], dismissed: ['لازم نبود', ''], reverted: ['خودش برگشت', 'badge-blue'] };

export async function render(view, ctx) {
  const f = { status: ctx.query.get('status') || 'open', platform: ctx.query.get('platform') || '', kind: ctx.query.get('kind') || '' };
  const { items: platforms } = await get('/platforms');
  let items = [];

  view.innerHTML = `
    <div class="page-head"><div><h1>کارتابل</h1><p>وقتی قیمت یا موجودی کالایی روی سایت شرکت عوض می‌شود و آن کالا را در دیجی‌کالا یا باسلام می‌فروشیم، اینجا می‌آید تا آنجا هم عوضش کنید.</p></div></div>
    <div class="card toolbar">
      <div class="seg" role="group" aria-label="وضعیت">${[['open', 'باز'], ['closed', 'بسته‌شده']].map(([k, v]) => `<button type="button" data-status="${k}" aria-pressed="${k === f.status}">${v}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="نوع">${[['', 'همه'], ['price', 'قیمت'], ['stock', 'موجودی']].map(([k, v]) => `<button type="button" data-kind="${k}" aria-pressed="${k === f.kind}">${v}</button>`).join('')}</div>
      <select class="input" id="ib-platform" aria-label="پلتفرم"><option value="">همه‌ی پلتفرم‌ها</option>${platforms.filter((p) => p.code !== 'site').map((p) => `<option value="${p.id}"${String(p.id) === f.platform ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    </div>
    <div id="ib-list" class="grid">${skeleton(4)}</div>`;

  const stockText = (status, qty) => `${(STOCK[status] || { label: status || '—' }).label}${status === 'instock' && qty !== null && qty !== undefined ? ` (${fa(qty)})` : ''}`;
  function card(t, i) {
    const cur = t.currency;
    const head = `<div class="task-head">
      <span class="badge badge-blue">${esc(t.platform_name)}</span>${t.listing_code ? `<button class="badge ltr" type="button" data-copy="${esc(t.listing_code)}" title="کپی کد آگهی">${esc(t.listing_code)} ${icon('copy')}</button>` : ''}
      <a class="link" href="#/products/${t.product_id}">${esc(t.listing_title || t.product_name)}</a><span class="muted small">${esc(t.company_name)}</span>
      <span class="muted small push">${when(t.created_at)}${t.changes > 1 ? ` · ${fa(t.changes)} تغییر` : ''}</span></div>`;
    let body;
    if (t.kind === 'price') {
      body = `<div class="task-facts">
        <div><span class="field-label">قیمت سایت شرکت</span><span><span class="strike">${money(t.site_price_before, cur)}</span> ← <b class="price">${money(t.site_price_after, cur)}</b> ${delta(t.site_price_before, t.site_price_after)}</span></div>
        <div><span class="field-label">قیمت فعلی ما در ${esc(t.platform_name)}</span><span>${t.listing_platform_price ? moneyText(t.listing_platform_price, 'toman') : '<span class="muted">ثبت نشده</span>'}</span></div>
        <div><span class="field-label">پیشنهاد (همان حاشیه‌ی سود)</span><span>${t.suggested_price ? `<b class="price">${moneyText(t.suggested_price, 'toman')}</b>` : '<span class="muted">قیمت فعلی ما ثبت نشده؛ خودتان تعیین کنید</span>'}</span></div>
        ${t.listing_units !== t.units_per_pack ? `<div><span class="field-label">این آگهی</span><span>${fa(t.listing_units)} عدد از بسته‌ی ${fa(t.units_per_pack)} عددی</span></div>` : ''}
      </div>`;
    } else {
      const perSale = t.qty_after !== null && t.qty_after !== undefined ? Math.floor((t.qty_after * t.units_per_pack) / t.listing_units) : null;
      body = `<div class="task-facts">
        <div><span class="field-label">موجودی سایت شرکت</span><span>${esc(stockText(t.stock_before, t.qty_before))} ← <b>${esc(stockText(t.stock_after, t.qty_after))}</b></span></div>
        <div><span class="field-label">یعنی در ${esc(t.platform_name)}</span><span>${t.stock_after !== 'instock' ? '<b style="color:var(--red)">آگهی را ناموجود کنید</b>' : t.stock_before !== 'instock' ? '<b style="color:var(--green)">آگهی را دوباره موجود کنید</b>' : `<b>موجودی کم است</b>${perSale !== null ? ` — حداکثر ${fa(perSale)} فروش` : ''}`}</span></div>
      </div>`;
    }
    const foot = f.status === 'open'
      ? `<div class="form-actions"><button class="btn btn-primary btn-sm" type="button" data-done>${icon('check')}انجام شد</button><button class="btn btn-ghost btn-sm" type="button" data-dismiss>لازم نیست</button></div>`
      : `<div class="small muted"><span class="badge ${STATUS[t.status][1]}">${STATUS[t.status][0]}</span> ${esc(t.closed_by_name || '')} ${when(t.closed_at)}${t.done_price ? ` · قیمت گذاشته‌شده ${moneyText(t.done_price, 'toman')}` : ''}${t.note ? ` · ${esc(t.note)}` : ''}</div>`;
    return `<article class="card task" data-i="${i}">${head}${body}${foot}</article>`;
  }
  function paint() {
    const box = $('#ib-list', view);
    box.innerHTML = items.length ? items.map(card).join('')
      : `<div class="card">${empty('check', f.status === 'open' ? 'کارتابل خالی است' : 'چیزی نیست', f.status === 'open' ? 'هر وقت قیمت یا موجودی کالایی که در دیجی‌کالا یا باسلام آگهی دارد روی سایت شرکت عوض شود، اینجا می‌آید.' : '')}</div>`;
  }
  async function load() {
    ctx.setQuery(f);
    try { items = (await get('/tasks', f)).items; paint(); } catch (err) { $('#ib-list', view).innerHTML = empty('alert', 'کارتابل نیامد', err.message); }
  }

  $('#ib-platform', view).addEventListener('change', (e) => { f.platform = e.target.value; load(); });
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy) return copy(b.dataset.copy, 'کد آگهی');
    for (const k of ['status', 'kind']) {
      if (b.dataset[k] !== undefined) { f[k] = b.dataset[k]; $$(`[data-${k}]`, view).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); return load(); }
    }
    const art = b.closest('[data-i]');
    if (!art) return;
    const t = items[Number(art.dataset.i)];
    if (b.hasAttribute('data-done')) {
      if (t.kind !== 'price') {
        busy(b, true);
        try { await post(`/tasks/${t.id}/done`, {}); toast('ثبت شد.'); await load(); ctx.refreshCounts(); } catch (err) { toast(err.message, { error: true }); busy(b, false); }
        return;
      }
      const body = openSheet('قیمت در پلتفرم عوض شد', `<form class="form" id="f-done" novalidate>
        <p><b>${esc(t.listing_title || t.product_name)}</b><br><span class="small muted">${esc(t.platform_name)} ${esc(t.listing_code || '')}</span></p>
        <div class="field"><label for="dn-price">قیمتی که در ${esc(t.platform_name)} گذاشتید (تومان)</label><input id="dn-price" name="platform_price" inputmode="numeric" value="${t.suggested_price ? fa(inCurrency(t.suggested_price, 'toman')) : ''}">
          <span class="hint">پیشنهاد با همان حاشیه‌ی قبلی پر شده؛ اگر عدد دیگری گذاشتید عوضش کنید.</span></div>
        <div class="field"><label for="dn-note">یادداشت (اختیاری)</label><input id="dn-note" name="note"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت</button></div></form>`);
      const form = $('#f-done', body);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const price = latin(form.elements.platform_price.value).replace(/[,،٬\s]/g, '');
        if (!price) { fieldErrors(form, { platform_price: 'قیمت را وارد کنید.' }); return; }
        try { await post(`/tasks/${t.id}/done`, { platform_price: price, note: form.elements.note.value.trim() || undefined }); closeSheet(); toast('ثبت شد؛ قیمت آگهی به‌روز شد.'); await load(); ctx.refreshCounts(); } catch (err) { showError(form, err); }
      });
    }
    if (b.hasAttribute('data-dismiss')) {
      const body = openSheet('لازم نیست', `<form class="form" id="f-dis" novalidate><p>${esc(t.listing_title || t.product_name)}</p>
        <div class="field"><label for="ds-note">چرا؟</label><input id="ds-note" name="note" required placeholder="مثلاً: قیمت دیجی‌کالا را عمداً ثابت نگه می‌داریم"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">ثبت</button></div></form>`);
      const form = $('#f-dis', body);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!form.elements.note.value.trim()) { fieldErrors(form, { note: 'دلیل را بنویسید.' }); return; }
        try { await post(`/tasks/${t.id}/dismiss`, { note: form.elements.note.value.trim() }); closeSheet(); toast('ثبت شد.'); await load(); ctx.refreshCounts(); } catch (err) { showError(form, err); }
      });
    }
  };
  await load();
  const off = ctx.subscribe('tasks', debounce(load, 500));
  return () => off();
}
