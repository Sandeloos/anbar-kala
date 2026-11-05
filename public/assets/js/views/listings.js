/**
 * Listings (#/listings): what each platform sells as one item and which company product
 * (and how many units of it) that is. A "25 pieces" Digikala listing of a 100-piece product
 * is settled as a quarter of the product's site price.
 */
import { get, post, put } from '../api.js';
import { $, $$, esc, icon, fa, money, moneyText, skeleton, empty, toast, openSheet, closeSheet, showError, fieldErrors, busy, debounce, latin, inCurrency } from '../ui.js';
import { createPicker } from '../picker.js';

export async function render(view, ctx) {
  const f = { q: ctx.query.get('q') || '', platform: ctx.query.get('platform') || '', partial: ctx.query.get('partial') || '', page: ctx.query.get('page') || '' };
  let { items: platforms } = await get('/platforms');
  let data = null;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>آگهی‌ها</h1><p>هر آگهی در دیجی‌کالا، باسلام یا سایت به یک کالای سایت شرکت وصل است و می‌گوید هر فروشش چند عدد است.</p></div>
      <div class="page-actions"><button class="btn" type="button" data-platform-new>${icon('plus')}پلتفرم جدید</button><button class="btn btn-primary" type="button" data-new>${icon('plus')}آگهی جدید</button></div>
    </div>
    <div class="card toolbar">
      <label class="search"><span class="sr-only">جستجو</span>${icon('search')}<input type="search" id="l-q" value="${esc(f.q)}" placeholder="کد آگهی، عنوان یا نام کالا…"></label>
      <div class="seg" role="group" aria-label="پلتفرم" id="l-platforms"></div>
      <button class="chip" type="button" data-partial aria-pressed="${f.partial === '1'}">فقط بخشی از بسته</button>
    </div>
    <section class="card card-flush" aria-label="آگهی‌ها"><div id="l-list">${skeleton(6)}</div></section>`;

  function paintPlatforms() {
    $('#l-platforms', view).innerHTML = `<button type="button" data-pl="" aria-pressed="${!f.platform}">همه</button>` +
      platforms.filter((p) => p.active).map((p) => `<button type="button" data-pl="${p.id}" aria-pressed="${String(p.id) === f.platform}">${esc(p.name)}</button>`).join('');
  }
  function paint() {
    const box = $('#l-list', view);
    if (!data.items.length) {
      box.innerHTML = empty('link', 'آگهی‌ای پیدا نشد', 'آگهی‌ها را اینجا، هنگام ثبت سفارش یا هنگام ورود از اکسل می‌سازید.', '<button class="btn btn-primary" type="button" data-new>آگهی جدید</button>');
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">آگهی</th><th scope="col">کالای سایت شرکت</th><th scope="col" class="col-num">هر فروش</th><th scope="col" class="col-num">ارزش هر فروش برای شرکت</th><th scope="col" class="col-actions"><span class="sr-only">کارها</span></th></tr></thead>
      <tbody>${data.items.map((l, i) => `<tr data-i="${i}">
        <td class="cell-main"><div class="cell-title"><strong>${esc(l.title || l.product_name)}</strong><div class="cell-meta"><span class="badge badge-blue">${esc(l.platform_name)}</span>${l.code ? `<span class="ltr">${esc(l.code)}</span>` : ''}${l.active ? '' : '<span class="badge">غیرفعال</span>'}</div></div></td>
        <td data-label="کالای سایت"><a class="link" href="#/products/${l.product_id}">${esc(l.product_name)}</a><div class="small muted">${esc(l.company_name)}</div></td>
        <td class="col-num" data-label="هر فروش">${fa(l.units)} عدد${l.units !== l.units_per_pack ? `<div><span class="badge badge-orange">${fa(l.units)} از ${fa(l.units_per_pack)}</span></div>` : ''}</td>
        <td class="col-num" data-label="ارزش هر فروش"><span class="price">${money(l.regular_price === null ? null : Math.round((l.regular_price * l.units) / l.units_per_pack), l.currency)}</span>
          ${l.platform_price ? `<div class="small muted">در پلتفرم: ${moneyText(l.platform_price, 'toman')}</div>` : ''}</td>
        <td class="col-actions"><button class="btn btn-sm" type="button" data-edit>${icon('edit')}ویرایش</button></td></tr>`).join('')}</tbody></table></div>
      <div class="table-foot"><span>${fa(data.total)} آگهی</span><div class="pager">
        <button class="icon-btn sm" type="button" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''} aria-label="صفحه‌ی قبل">${icon('back')}</button>
        <span>صفحه‌ی ${fa(data.page)} از ${fa(data.pages)}</span>
        <button class="icon-btn sm" type="button" data-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''} aria-label="صفحه‌ی بعد">${icon('next')}</button></div></div>`;
  }
  async function load() {
    ctx.setQuery(f);
    try { data = await get('/listings', f); paint(); } catch (err) { $('#l-list', view).innerHTML = empty('alert', 'آگهی‌ها نیامد', err.message); }
  }

  function sheet(l) {
    const body = openSheet(l ? 'ویرایش آگهی' : 'آگهی جدید', `<form class="form" id="f-li" novalidate>
      <div class="field"><label for="li-platform">پلتفرم</label><select id="li-platform" name="platform_id">${platforms.filter((p) => p.active || (l && p.id === l.platform_id)).map((p) => `<option value="${p.id}"${(l ? l.platform_id : Number(f.platform) || platforms[0].id) === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="picker"><label class="field-label" for="li-pick">کالای سایت شرکت</label><div class="search">${icon('search')}<input id="li-pick" type="search" placeholder="جستجوی کالا…"></div></div>
      <div id="li-chosen">${l ? `<div class="callout callout-info small">${icon('box')}<span>${esc(l.product_name)} — ${esc(l.company_name)} (${fa(l.units_per_pack)} عدد در هر بسته)</span></div>` : ''}</div>
      <div class="form-row cols-2">
        <div class="field"><label for="li-code">کد در پلتفرم</label><input id="li-code" name="code" dir="ltr" value="${esc(l ? l.code || '' : '')}" placeholder="مثلاً DKPC-123"></div>
        <div class="field"><label for="li-units">هر فروش چند عدد است؟</label><input id="li-units" name="units" inputmode="numeric" value="${l ? fa(l.units) : ''}"><span class="hint" id="li-units-hint"></span></div>
      </div>
      <div class="field"><label for="li-title">عنوان در پلتفرم</label><input id="li-title" name="title" value="${esc(l ? l.title || '' : '')}"></div>
      <div class="field"><label for="li-price">قیمت فعلی ما در پلتفرم (تومان، اختیاری)</label><input id="li-price" name="platform_price" inputmode="numeric" value="${l && l.platform_price ? fa(inCurrency(l.platform_price, 'toman')) : ''}"></div>
      <div class="field"><label for="li-note">یادداشت</label><input id="li-note" name="note" value="${esc(l ? l.note || '' : '')}"></div>
      ${l ? `<label class="switch"><span><strong>فعال</strong><small>آگهی غیرفعال در جستجوی ثبت سفارش نمی‌آید.</small></span><input type="checkbox" name="active" ${l.active ? 'checked' : ''}><i></i></label>` : ''}
      <div class="form-actions"><button class="btn btn-primary" type="submit">ذخیره</button></div></form>`);
    const form = $('#f-li', body);
    let product = l ? { product_id: l.product_id, units_per_pack: l.units_per_pack } : null;
    const hint = () => { $('#li-units-hint', body).textContent = product ? `بسته‌ی کامل این کالا ${product.units_per_pack} عدد است.` : ''; };
    hint();
    createPicker($('#li-pick', body), {
      params: () => ({ products_only: 1 }),
      onPick(it) {
        product = it;
        $('#li-chosen', body).innerHTML = `<div class="callout callout-info small">${icon('box')}<span>${esc(it.name)} — ${esc(it.company_name)} (${fa(it.units_per_pack)} عدد در هر بسته)</span></div>`;
        if (!form.elements.units.value) form.elements.units.value = fa(it.units_per_pack);
        if (!form.elements.title.value) form.elements.title.value = it.name;
        hint();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!product) { fieldErrors(form, { _: 'کالای سایت شرکت را انتخاب کنید.' }); return; }
      const v = Object.fromEntries(new FormData(form));
      const payload = {
        platform_id: Number(v.platform_id), product_id: product.product_id, code: latin(v.code || '').trim() || null, title: v.title, units: latin(v.units),
        platform_price: latin(v.platform_price || '').replace(/[,،٬\s]/g, '') || null, note: v.note, active: l ? form.elements.active.checked : true
      };
      const btn = $('button[type=submit]', form);
      busy(btn, true);
      try {
        if (l) await put(`/listings/${l.id}`, payload); else await post('/listings', payload);
        closeSheet(); toast('آگهی ذخیره شد.'); await load();
      } catch (err) { showError(form, err); busy(btn, false); }
    });
  }

  $('#l-q', view).addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); f.page = ''; load(); }, 250));
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pl !== undefined) { f.platform = b.dataset.pl; f.page = ''; $$('[data-pl]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); return load(); }
    if (b.hasAttribute('data-partial')) { f.partial = f.partial === '1' ? '' : '1'; b.setAttribute('aria-pressed', String(f.partial === '1')); return load(); }
    if (b.dataset.page) { f.page = b.dataset.page === '1' ? '' : b.dataset.page; return load(); }
    if (b.hasAttribute('data-new')) return sheet(null);
    if (b.hasAttribute('data-edit')) return sheet(data.items[Number(b.closest('tr').dataset.i)]);
    if (b.hasAttribute('data-platform-new')) {
      const body = openSheet('پلتفرم جدید', `<form class="form" id="f-pl" novalidate><div class="field"><label for="pl-name">نام پلتفرم</label><input id="pl-name" name="name" placeholder="مثلاً اسنپ‌شاپ"></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">افزودن</button></div></form>`);
      const form = $('#f-pl', body);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try { platforms = (await post('/platforms', { name: form.elements.name.value })).items; closeSheet(); paintPlatforms(); toast('پلتفرم اضافه شد.'); } catch (err) { showError(form, err); }
      });
    }
  };
  paintPlatforms();
  await load();
}
