/**
 * Import of Digikala listings (#/digikala/import): reads every seller variant through the Open API,
 * leaves out those that already have a listing and suggests the site product of each (same supplier
 * code as the product SKU, else the closest name). Nothing is linked by itself: a person checks the
 * product and the units of each sale, then the chosen listings are created together.
 */
import { get, post } from '../api.js';
import { $, $$, esc, icon, fa, moneyText, toast, busy, skeleton, empty } from '../ui.js';
import { createPicker } from '../picker.js';


const latin = (s) => String(s ?? '').replace(/[٬,]/g, '').replace(/٫/g, '.').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim();
const kindOf = (it) => {
  const top = it.suggestions[0];
  if (!top) return 'none';
  return top.confident ? 'sure' : 'check';
};
const why = (s) => (s.why === 'sku' ? 'کد یکسان' : `امتیاز نام و توضیحات ${fa(Math.round(s.score * 100))}٪`);

export async function render(view) {
  view.innerHTML = skeleton(4);
  const st = (await get('/digikala')).status;
  let data = null;
  let filter = 'check';
  let page = 0;
  let query = '';
  let mode = 'match';
  let sitePage = 0;
  let saving = false;
  const drafts = new Map();
  const extra = new Map(); // variant id → products picked by search (added to its options)

  view.innerHTML = `
    <div class="page-head"><div><h1>مدیریت کاتالوگ دیجی‌کالا</h1>
      <p>۱. سایت‌ها را به‌روز کنید · ۲. کالاها را مقایسه کنید · ۳. تطبیق‌ها را تأیید کنید</p></div>
      <div class="page-actions"><a class="btn" href="#/digikala">${icon('back')}قیمت دیجی‌کالا</a></div></div>
    ${st.connected ? `<section class="card" aria-labelledby="h-di-read">
      <div class="card-head"><h2 id="h-di-read">خواندن از دیجی‌کالا</h2></div>
      <p class="small muted">تنوع‌هایی که آگهی دارند دوباره نمی‌آیند. هر وقت کالای تازه‌ای در دیجی‌کالا گذاشتید، دوباره بخوانید. در دیجی‌کالا چیزی عوض نمی‌شود.</p>
      <div class="form-actions"><button class="btn btn-primary" type="button" id="di-read">${icon('download')}خواندن تنوع‌ها از دیجی‌کالا</button></div>
    </section>
    <div id="di-result"></div>`
    : `<div class="callout callout-info">${icon('info')}<span>اول مدیر باید از صفحه‌ی «قیمت دیجی‌کالا» به پنل فروشندگی وصل شود.</span><a class="btn btn-sm" href="#/digikala">قیمت دیجی‌کالا</a></div>`}`;

  /** The best suggestion is chosen from the start; the checkbox (ticked only when sure) decides. */
  function options(it) {
    const list = [...it.suggestions, ...(extra.get(it.variant_id) || [])];
    return `<option value="">— کالای سایت را انتخاب کنید —</option>` +
      list.map((s, i) => `<option value="${s.product_id}"${i === 0 ? ' selected' : ''}>${esc(s.name)} — ${esc(s.company_name)}${s.why ? ` (${why(s)})` : ''}</option>`).join('') +
      '<option value="search">جستجوی کالای دیگر…</option>';
  }

  function row(it) {
    const sure = kindOf(it) === 'sure';
    const units = it.units_guess ?? '';
    return `<div class="list-item di-row" data-v="${it.variant_id}" data-kind="${kindOf(it)}">
      <input type="checkbox" class="di-check" data-pick aria-label="انتخاب ${esc(it.title)}"${sure ? ' checked' : ''}>
      <span class="grow">
        <span class="title">${it.product_url ? `<a class="link" href="${esc(it.product_url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}</span>
        <span class="sub"><span class="ltr">DKPC ${esc(it.variant_id)}</span>${it.supplier_code ? `<span>کد تأمین‌کننده <span class="ltr">${esc(it.supplier_code)}</span></span>` : ''}
          <span>قیمت فعلی ${moneyText(it.price_sale, 'toman')}</span>${it.extra ? `<span>${esc(it.extra)}</span>` : ''}${it.active ? '' : '<span class="badge">غیرفعال در دیجی‌کالا</span>'}</span>
        <span class="di-fields">
          <span class="field"><label for="di-p-${it.variant_id}">کالای سایت</label><select id="di-p-${it.variant_id}" data-product>${options(it)}</select></span>
          <span class="field di-units"><label for="di-u-${it.variant_id}">هر فروش چند عدد؟</label><input id="di-u-${it.variant_id}" data-units inputmode="numeric" placeholder="تأیید تعداد" value="${units === '' ? '' : fa(units)}"></span>
        </span>
        <span class="small muted" data-hint></span>
        <a class="link small" data-site-link target="_blank" rel="noopener noreferrer" hidden>مشاهدهٔ کالا در سایت شرکت ↗</a>
        <details class="di-copy"><summary>مقایسهٔ توضیحات</summary><p>دیجی‌کالا: ${esc(it.description || 'توضیحات در دسترس نیست؛ تطبیق بر اساس نام است.')}</p><p data-site-copy></p></details>
        <div class="form-actions"><button class="btn btn-sm" type="button" data-formula-toggle aria-expanded="false" aria-controls="di-f-${it.variant_id}">+ ضریب قیمت</button></div>
        <div id="di-f-${it.variant_id}" data-formula hidden>
          <div class="field"><label for="di-m-${it.variant_id}">قیمت پایه ضربدر چند؟</label><input id="di-m-${it.variant_id}" data-multiplier inputmode="decimal" value="۱٫۳" aria-describedby="di-price-${it.variant_id}"></div>
          <p id="di-price-${it.variant_id}" class="small" data-price aria-live="polite"></p>
          <p class="small muted">${st.mode === 'live' ? 'پس از ثبت، قیمت به صف ارسال دیجی‌کالا می‌رود؛ تغییر بزرگ منتظر تأیید می‌ماند.' : st.mode === 'dry_run' ? 'حالت آزمایشی: قیمت محاسبه می‌شود و ارسال واقعی انجام نمی‌شود.' : 'ارسال قیمت خاموش است؛ فرمول ذخیره می‌شود تا قیمت‌گذاری را فعال کنید.'}</p>
          <button class="btn btn-primary btn-sm" type="button" data-save-one>اتصال و ثبت ضریب</button>
        </div>
        <span class="picker" data-search hidden><span class="search">${icon('search')}<input type="search" aria-label="جستجوی کالای سایت برای ${esc(it.title)}" placeholder="نام یا کد کالای سایت…"></span></span>
      </span>
    </div>`;
  }

  const item = (vid) => data.items.find((x) => x.variant_id === vid);
  const productOf = (it, pid) => [...it.suggestions, ...(extra.get(it.variant_id) || [])].find((s) => s.product_id === pid);

  function hint(r) {
    const it = item(Number(r.dataset.v));
    const p = productOf(it, Number($('[data-product]', r).value));
    const link = $('[data-site-link]', r);
    link.hidden = true;
    link.removeAttribute('href');
    try {
      const url = new URL(p?.permalink);
      if (['http:', 'https:'].includes(url.protocol)) { link.href = url.href; link.hidden = false; }
    } catch { /* A missing site URL leaves the link hidden. */ }
    $('[data-site-copy]', r).textContent = `سایت: ${p?.description || 'توضیحات در دسترس نیست؛ سایت را به‌روز کنید.'}`;
    const factor = Number(latin($('[data-multiplier]', r).value));
    const units = Number(latin($('[data-units]', r).value));
    const base = p?.regular_price != null && units > 0 ? Math.round(p.regular_price * units / p.units_per_pack) : null;
    $('[data-price]', r).textContent = base !== null && factor >= 0.5 && factor <= 11 ? `قیمت ${fa(units)} عدد: ${moneyText(base, p.currency)} × ${fa(factor)} = ${moneyText(Math.ceil(Math.round(base * factor)), p.currency)} — افزایش روی قیمت پایه ${fa(Math.round((factor - 1) * 10000) / 100)}٪` : 'کالا، تعداد فروش و ضریب معتبر بین ۰٫۵ و ۱۱ را وارد کنید.';
    $('[data-hint]', r).textContent = p ? `بسته‌ی کامل این کالا ${fa(p.units_per_pack)} عدد است؛ قیمت سایت ${moneyText(p.regular_price, p.currency)}.` : '';
  }

  function paint() {
    const box = $('#di-result', view);
    if (!data.items.length && !data.opportunities?.length) {
      box.innerHTML = `<div class="card">${empty('check', 'تنوع تازه‌ای نیست', `${fa(data.total)} تنوع در دیجی‌کالا خوانده شد و همه آگهی دارند.`)}</div>`;
      return;
    }
    const n = (k) => data.items.filter((x) => k === 'all' || kindOf(x) === k).length;
    box.innerHTML = `
      <div class="callout callout-ok">${icon('check')}<span>${fa(data.total)} تنوع خوانده شد؛ ${fa(data.already_linked)} تا آگهی دارند و ${fa(data.items.length)} تا تازه است. فقط تطبیق‌های دارای شناسهٔ معتبر و بدون ابهام انتخاب شده‌اند.</span></div>
      <div class="form-actions"><button class="btn ${mode === 'match' ? 'btn-primary' : ''}" data-mode="match">تطبیق آگهی‌ها</button><button class="btn ${mode === 'site' ? 'btn-primary' : ''}" data-mode="site">کالاهای سایت (${fa(data.opportunities?.length || 0)})</button><button class="btn" id="di-sync">به‌روزرسانی از سایت‌ها</button></div>
      <div class="small muted">${(data.companies || []).map((c) => `${esc(c.name)}: ${c.last_full_sync_at ? esc(new Date(c.last_full_sync_at).toLocaleString('fa-IR')) : 'هنوز همگام نشده'}${c.sync_error ? ' — خطا در همگام‌سازی' : ''}`).join(' · ')}</div>
      ${data.description_pending ? `<p class="small muted">توضیحات ${fa(data.description_pending)} کالا هنوز خوانده نشده؛ با خواندن دوباره، بررسی ادامه پیدا می‌کند.</p>` : ''}
      ${data.complete === false ? '<p class="callout callout-warn">خواندن کاتالوگ کامل نشده؛ پیشنهاد کالای جدید تا خواندن کامل نمایش داده نمی‌شود.</p>' : ''}
      <div id="di-site" ${mode === 'site' ? '' : 'hidden'} class="card"><p class="small muted">این کالاها آگهی متصل در حساب شما ندارند. «پیدا نشد» به معنی نبودن در کل دیجی‌کالا نیست. ثبت محصول جدید فعلاً از پنل فروشنده انجام می‌شود.</p><div class="list">${(data.opportunities || []).map((p) => `<div class="list-item" data-site-row><span class="grow"><a class="link" href="#/products/${p.id}">${esc(p.name)}</a><span class="sub">${esc(p.company_name)} · ${esc(p.sku || '')} · ${p.presence === 'uncertain' ? 'تطبیق احتمالی؛ بررسی کنید' : 'در تنوع‌های حساب پیدا نشد'}</span></span><a class="btn btn-sm" href="https://seller.digikala.com/" target="_blank" rel="noopener">پنل فروشنده</a></div>`).join('')}</div><div class="form-actions"><button class="btn" id="di-site-prev">قبلی</button><span id="di-site-page"></span><button class="btn" id="di-site-next">بعدی</button></div></div>
      <div id="di-matches" ${mode === 'match' ? '' : 'hidden'}>
      <div class="field"><label for="di-query">جستجو در تنوع‌ها</label><input type="search" id="di-query" value="${esc(query)}" placeholder="نام، مدل یا DKPC"></div>
      <div class="seg" role="group" aria-label="نمایش" id="di-filter">
        ${[['all', 'همه'], ['sure', 'پیشنهاد مطمئن'], ['check', 'نیاز به بررسی'], ['none', 'بدون پیشنهاد']].map(([k, t]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${t} <small>${fa(n(k))}</small></button>`).join('')}
      </div>
      <section class="card" aria-label="تنوع‌های دیجی‌کالا"><div class="list">${data.items.map(row).join('')}</div><p id="di-no-matches" class="small muted" hidden>در این فیلتر موردی نیست؛ فیلتر دیگری انتخاب کنید.</p></section><div class="form-actions"><button class="btn" id="di-prev">قبلی</button><span id="di-page"></span><button class="btn" id="di-next">بعدی</button></div>
      <div class="card"><div class="field"><label for="di-bulk-multiplier">ضریب گروهی برای همهٔ انتخاب‌شده‌ها (حتی صفحات دیگر)</label><input id="di-bulk-multiplier" inputmode="decimal" value="۱٫۳"></div><button class="btn" type="button" id="di-bulk-apply">اعمال ضریب به انتخاب‌شده‌ها</button><p class="small muted">قبل از تأیید اتصال، قیمت هر ردیف را بررسی کنید. ضریب گروهی جای ضریب قبلی انتخاب‌شده‌ها می‌نشیند.</p></div>
      <div class="di-bar"><span id="di-count"></span><button class="btn btn-primary" type="button" id="di-save">${icon('check')}تأیید اتصال آگهی‌ها</button></div></div>`;
    $$('.di-row', box).forEach((r) => {
      const draft = drafts.get(r.dataset.v);
      if (draft) {
        $('[data-product]', r).value = draft.product;
        $('[data-units]', r).value = draft.units;
        $('[data-pick]', r).checked = draft.picked;
        $('[data-multiplier]', r).value = draft.multiplier;
        $('[data-formula]', r).hidden = !draft.formula;
        $('[data-formula-toggle]', r).setAttribute('aria-expanded', String(draft.formula));
      }
      hint(r); r.hidden = filter !== 'all' && r.dataset.kind !== filter; });
    paginate();
    paginateSite();
    count();
  }

  function paginateSite() {
    const rows = $$('[data-site-row]', view);
    sitePage = Math.max(0, Math.min(sitePage, Math.ceil(rows.length / 20) - 1));
    rows.forEach((r, i) => { r.hidden = i < sitePage * 20 || i >= (sitePage + 1) * 20; });
    $('#di-site-page', view).textContent = `صفحه ${fa(sitePage + 1)} از ${fa(Math.max(1, Math.ceil(rows.length / 20)))}`;
    $('#di-site-prev', view).disabled = sitePage === 0;
    $('#di-site-next', view).disabled = (sitePage + 1) * 20 >= rows.length;
  }

  function paginate() {
    const rows = $$('.di-row', view);
    const eligible = rows.filter((r) => (filter === 'all' || r.dataset.kind === filter) && latin(r.textContent).toLowerCase().includes(latin(query).toLowerCase()));
    page = Math.max(0, Math.min(page, Math.ceil(eligible.length / 20) - 1));
    $('#di-no-matches', view).hidden = eligible.length > 0;
    rows.forEach((r) => { r.hidden = true; });
    eligible.slice(page * 20, (page + 1) * 20).forEach((r) => { r.hidden = false; });
    $('#di-page', view).textContent = `${fa(eligible.length)} مورد · صفحه ${fa(page + 1)} از ${fa(Math.max(1, Math.ceil(eligible.length / 20)))}`;
    $('#di-prev', view).disabled = page === 0;
    $('#di-next', view).disabled = (page + 1) * 20 >= eligible.length;
  }

  view.oninput = (e) => {
    const row = e.target.closest('.di-row');
    if (row && e.target.matches('[data-units], [data-multiplier]')) hint(row);
    if (e.target.id === 'di-query') { query = e.target.value; page = 0; paginate(); } };

  function count() {
    const n = $$('.di-row [data-pick]:checked', view).length;
    $('#di-count', view).textContent = `${fa(n)} تنوع انتخاب شده`;
    $('#di-save', view).disabled = !n;
  }

  function openSearch(r) {
    const wrap = $('[data-search]', r);
    wrap.hidden = false;
    const input = $('input', wrap);
    if (!input.dataset.ready) {
      input.dataset.ready = '1';
      createPicker(input, {
        params: () => ({ products_only: 1 }),
        onPick(p) {
          const vid = Number(r.dataset.v);
          const it = item(vid);
          const s = { product_id: p.product_id, name: p.name, company_name: p.company_name, currency: p.currency, units_per_pack: p.units_per_pack, regular_price: p.regular_price, permalink: p.permalink, description: p.description || '' };
          extra.set(vid, [...(extra.get(vid) || []).filter((x) => x.product_id !== s.product_id), s]);
          const sel = $('[data-product]', r);
          sel.innerHTML = options(it);
          sel.value = String(s.product_id);
          if (!latin($('[data-units]', r).value)) $('[data-units]', r).value = it.units_guess === null ? '' : fa(it.units_guess);
          $('[data-pick]', r).checked = true;
          wrap.hidden = true;
          hint(r);
          count();
        }
      });
    }
    input.focus();
  }

  async function read(btn) {
    busy(btn, true, 'در حال خواندن کالاها و توضیحات…');
    try {
      data = await post('/digikala/import/preview');
      extra.clear();
      drafts.clear();
      filter = 'check';
      page = 0;
      paint();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      busy(btn, false);
    }
  }

  async function save(btn, onlyRow = null) {
    if (saving) return;
    const rows = [];
    for (const r of $$('.di-row', view)) {
      if (onlyRow ? r !== onlyRow : !$('[data-pick]', r).checked) continue;
      const product = Number($('[data-product]', r).value);
      const units = Number(latin($('[data-units]', r).value));
      if (!product) { r.hidden = false; $('[data-product]', r).focus(); return toast('برای همه‌ی تنوع‌های انتخاب‌شده کالای سایت را انتخاب کنید.', { error: true }); }
      if (!Number.isInteger(units) || units < 1) { r.hidden = false; $('[data-units]', r).focus(); return toast('تعداد عدد در هر فروش را درست بنویسید.', { error: true }); }
      const formula = !$('[data-formula]', r).hidden;
      const multiplier = Number(latin($('[data-multiplier]', r).value));
      if (formula && (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 11)) { r.hidden = false; $('[data-multiplier]', r).focus(); return toast('ضریب قیمت باید بین ۰٫۵ و ۱۱ باشد.', { error: true }); }
      rows.push({ variant_id: Number(r.dataset.v), product_id: product, units, ...(formula ? { multiplier } : {}) });
    }
    if (!rows.length) return;
    for (const r of $$('.di-row', view)) drafts.set(r.dataset.v, {
      product: $('[data-product]', r).value, units: $('[data-units]', r).value,
      picked: $('[data-pick]', r).checked, multiplier: $('[data-multiplier]', r).value, formula: !$('[data-formula]', r).hidden
    });
    saving = true;
    busy(btn, true);
    try {
      const res = await post('/digikala/import', { preview_id: data.preview_id, rows });
      const skipped = new Set(res.skipped.map((s) => Number(s.variant_id)));
      data.items = data.items.filter((x) => skipped.has(x.variant_id) || !rows.some((r) => r.variant_id === x.variant_id));
      data.already_linked += res.created;
      const connected = new Set(rows.filter((r) => !skipped.has(r.variant_id)).map((r) => r.product_id));
      data.opportunities = (data.opportunities || []).filter((p) => !connected.has(p.id));
      paint();
      toast(`${fa(res.created)} آگهی ساخته شد.${res.skipped.length ? ` ${fa(res.skipped.length)} مورد ساخته نشد: ${res.skipped.map((s) => s.reason).join('، ')}.` : ''} ${rows.some((r) => r.multiplier !== undefined) ? 'فرمول ثبت شد؛ وضعیت ارسال را در «قیمت دیجی‌کالا» ببینید.' : 'برای قیمت‌گذاری خودکار، فرمول را در «آگهی‌ها» روشن کنید.'}`,
        { action: rows.some((r) => r.multiplier !== undefined) ? 'وضعیت ارسال' : 'آگهی‌ها', onAction: () => { location.hash = rows.some((r) => r.multiplier !== undefined) ? '#/digikala' : '#/listings?platform=1'; } });
    } catch (err) {
      toast(err.message, { error: true });
      busy(btn, false);
    } finally { saving = false; }
  }

  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'di-bulk-apply') {
      const multiplier = Number(latin($('#di-bulk-multiplier', view).value));
      if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 11) return toast('ضریب قیمت باید بین ۰٫۵ و ۱۱ باشد.', { error: true });
      const rows = $$('.di-row', view).filter((r) => $('[data-pick]', r).checked);
      if (!rows.length) return toast('ابتدا تنوع‌ها را انتخاب کنید.', { error: true });
      rows.forEach((r) => {
        $('[data-multiplier]', r).value = fa(multiplier);
        $('[data-formula]', r).hidden = false;
        $('[data-formula-toggle]', r).setAttribute('aria-expanded', 'true');
        hint(r);
      });
      toast(`ضریب ${fa(multiplier)} برای ${fa(rows.length)} تنوع اعمال شد؛ برای ذخیره «تأیید اتصال آگهی‌ها» را بزنید.`);
    } else if (b.hasAttribute('data-formula-toggle')) {
      const row = b.closest('.di-row');
      const formula = $('[data-formula]', row);
      formula.hidden = !formula.hidden;
      b.setAttribute('aria-expanded', String(!formula.hidden));
      hint(row);
    } else if (b.hasAttribute('data-save-one')) save(b, b.closest('.di-row'));
    else if (b.dataset.mode) {
      mode = b.dataset.mode;
      $('#di-site', view).hidden = mode !== 'site';
      $('#di-matches', view).hidden = mode !== 'match';
      $$('[data-mode]', view).forEach((x) => x.classList.toggle('btn-primary', x === b));
    } else if (b.id === 'di-site-prev' || b.id === 'di-site-next') { sitePage += b.id === 'di-site-next' ? 1 : -1; paginateSite(); }
    else if (b.id === 'di-sync') {
      busy(b, true);
      Promise.allSettled((data.companies || []).map((c) => post(`/companies/${c.id}/sync`, { kind: 'full' }))).then((results) => {
        const failed = results.filter((r) => r.status === 'rejected');
        toast(failed.length ? failed.map((r) => r.reason.message).join('، ') : 'خواندن محصولات سایت‌ها شروع شد. پس از پایان همگام‌سازی، دوباره مقایسه را اجرا کنید.', { error: !!failed.length });
      }).finally(() => busy(b, false));
    } else if (b.id === 'di-prev' || b.id === 'di-next') { page += b.id === 'di-next' ? 1 : -1; paginate(); }
    else if (b.id === 'di-read') read(b);
    else if (b.id === 'di-save') save(b);
    else if (b.dataset.f) {
      filter = b.dataset.f;
      $$('[data-f]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      page = 0; paginate();
    }
  };
  view.onchange = (e) => {
    const r = e.target.closest('.di-row');
    if (!r) return;
    if (e.target.matches('[data-product]')) {
      if (e.target.value === 'search') { e.target.value = ''; openSearch(r); }
      else if (e.target.value) {
        const it = item(Number(r.dataset.v));
        const p = productOf(it, Number(e.target.value));
        if (p && it.units_guess !== null) $('[data-units]', r).value = fa(it.units_guess);
        $('[data-pick]', r).checked = true;
      }
      hint(r);
    }
    count();
  };
}
