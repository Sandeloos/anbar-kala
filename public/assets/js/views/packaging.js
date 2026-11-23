import { get, post } from '../api.js';
import { $, $$, esc, fa, moneyText, skeleton, toast, busy, latin } from '../ui.js';

export async function render(view) {
  view.innerHTML = skeleton(4);
  const { items } = await get('/packaging/reviews');
  view.innerHTML = `<div class="page-head"><div><h1>بررسی بسته‌بندی</h1><p>قیمت‌گذاری این کالاها تا تأیید دوباره متوقف است. قیمت تکی با تعداد داخل بستهٔ فروش فرق دارد.</p></div><a class="btn" href="#/digikala">قیمت دیجی‌کالا</a></div>
  ${items.map((r) => `<section class="card" data-review="${r.product_id}"><h2>${esc(r.name)}</h2><p>${esc(r.reason)}</p>
  <p class="small muted">قبلاً: ${esc(r.before.name)} · قیمت ${moneyText(r.before.regular_price, 'toman')} برای ${fa(r.before.price_units)} عدد. اکنون قیمت سایت ${moneyText(r.regular_price, 'toman')} است.</p>
  ${r.after?.verified_pack ? `<p class="small muted">صفحهٔ رادن قیمت را برای یک عدد اعلام کرده است. اندازهٔ بستهٔ فروش در سایت: ${r.after.verified_pack.sizes.map(fa).join('، ')} عدد.</p>` : ''}
  <form class="form" novalidate><div class="form-row cols-2">
  <div class="field"><label for="pack-price-${r.id}">قیمت سایت برای چند عدد است؟</label><input id="pack-price-${r.id}" data-price-units inputmode="numeric" value="${fa(r.after?.verified_pack?.price_units ?? r.units_per_pack)}"><span class="hint">اگر قیمت سایت برای یک عدد است، ۱ وارد کنید.</span></div>
  <div class="field"><label for="pack-sale-${r.id}">در بستهٔ فروش سایت چند عدد است؟</label><input id="pack-sale-${r.id}" data-sale-units inputmode="numeric" value="${fa(r.after?.verified_pack?.sale_units ?? (r.sale_pack_units || r.units_per_pack))}"><span class="hint">تعداد فیزیکی در یک بستهٔ فروش سایت را وارد کنید.</span></div></div>
  ${r.listings.map((l) => `<div class="field"><label for="pack-listing-${l.id}">${esc(l.platform_name)} · ${esc(l.code || l.title || '')} — هر فروش چند عدد؟</label><input id="pack-listing-${l.id}" data-listing="${l.id}" inputmode="numeric" value="${fa(l.declared_units ?? l.units)}">${l.declared_units ? `<span class="hint">طبق عنوان تنوع دیجیکالا، هر بسته ${fa(l.declared_units)} عدد دارد.</span>` : ''}</div>`).join('')}
  <button class="btn btn-primary" type="submit">تأیید مبنای قیمت و تطبیق آگهی‌ها</button></form></section>`).join('') || '<section class="card">بسته‌بندی نیازمند بررسی ندارید.</section>'}`;
  view.onsubmit = async (e) => {
    e.preventDefault();
    const box = e.target.closest('[data-review]');
    if (!box) return;
    const record = items.find((r) => r.product_id === Number(box.dataset.review));
    const number = (el) => Number(latin(el.value).replace(/[٬,٫]/g, ''));
    const price = number($('[data-price-units]', box)), sale = number($('[data-sale-units]', box));
    const listings = $$('[data-listing]', box).map((el) => ({ id: Number(el.dataset.listing), units: number(el), version: record.listings.find((l) => l.id === Number(el.dataset.listing)).version }));
    if (![price, sale, ...listings.map((l) => l.units)].every((n) => Number.isInteger(n) && n > 0 && n <= 100000)) return toast('تعدادها باید عدد صحیح بین ۱ و ۱۰۰٬۰۰۰ باشند.', { error: true });
    const button = $('button[type=submit]', box);
    busy(button, true);
    try {
      await post(`/products/${record.product_id}/packaging`, { version: record.version, price_units: price, sale_units: sale, listings });
      toast('تطبیق دوباره تأیید شد؛ قیمت‌گذاری خودکار طبق تنظیم هر آگهی ادامه پیدا می‌کند.');
      box.remove();
    } catch (err) { toast(err.message, { error: true }); busy(button, false); }
  };
}
