import { orderDateRange } from '../order-date-range.js';
import { get, post } from '../api.js';
import { $, esc, fa, moneyText, when, skeleton, toast, busy, confirm, debounce } from '../ui.js';

const money = (v) => moneyText(v, 'toman');
const states = { pending: 'منتظر تنظیم یا ارسال', sending: 'نتیجهٔ ارسال نیاز به بررسی دارد', uncertain: 'نتیجهٔ ارسال نامشخص؛ پنل را بررسی کنید', submitted: 'ثبت‌شده', open: 'باز', assigned: 'ارجاع‌شده', in_progress: 'در حال بررسی', closed: 'بسته‌شده', on_hold: 'در انتظار', resolved: 'پاسخ داده‌شده' };

export async function render(view, ctx) {
  let data;
  let tab = 'buybox';
  let query = '';
  let page = 0;
  let attention = false;
  let acting = false;
  let selectedRange = null;
  view.innerHTML = skeleton(5);
  const matches = (r) => `${r.product_name || ''} ${r.code || ''} ${r.remote_id || ''}`.includes(query);
  const needs = (r) => tab === 'orders' ? !!r.error || !r.order_id : tab === 'reference' ? !['closed', 'resolved'].includes(r.status) : r.is_winner !== 1 || !!r.error;
  const rows = () => (tab === 'orders' && !selectedRange ? [] : data[tab]).filter((r) => matches(r) && (!attention || needs(r)));

  function buybox(r) {
    const difference = r.formula_price != null && r.current_price != null ? Math.max(0, r.formula_price - r.current_price) : null;
    return `<div class="list-item dk-operation-row"><span class="grow"><span class="title">${esc(r.product_name)} <span class="ltr">DKPC ${esc(r.code)}</span></span>
      <span class="sub">${r.is_winner === 1 ? 'برندهٔ بای‌باکس' : r.is_winner === 0 ? 'بای‌باکس ندارید' : 'وضعیت بای‌باکس مشخص نیست'} · فعلی ${money(r.current_price)} · قیمت بای‌باکس ${money(r.winning_price)} · ${when(r.checked_at)}</span>
      ${r.formula_price != null ? `<span class="sub">قیمت فرمول ${money(r.formula_price)}${difference ? ` · اکنون ${money(difference)} پایین‌تر از فرمول می‌فروشید${r.applied_price === r.current_price ? ' (با تأیید پیشنهاد بای‌باکس)' : ''}` : ''}</span>` : ''}
      ${r.suggested_price && !r.error ? `<span class="sub">پیشنهاد رسمی دیجی‌کالا ${money(r.suggested_price)} · کاهش لازم نسبت به فعلی ${money(r.current_price - r.suggested_price)}${r.formula_price != null ? ` · پایین‌تر از فرمول ${money(Math.max(0, r.formula_price - r.suggested_price))}` : ''}</span>` : ''}
      ${r.error ? `<span class="sub">${esc(r.error)}</span>` : ''}</span>
      ${r.suggested_price && !r.error && !r.dk_state ? `<button class="btn btn-primary btn-sm" data-approve="${r.listing_id}" data-price="${r.suggested_price}">تأیید کاهش قیمت</button>` : ''}</div>`;
  }
  function reference(r) {
    return `<div class="list-item dk-operation-row"><span class="grow"><span class="title">${esc(r.product_name)} · ${esc(r.code)}</span>
      <span class="sub">${esc(states[r.status] || r.status)} · درخواست ${esc(r.request_number || r.ticket_id || 'هنوز شناسه ندارد')} · قیمت درخواستی ${money(r.target_price)} · ${when(r.updated_at)}</span>
      ${r.error ? `<span class="sub">${esc(r.error)}</span><a class="link small" href="#/digikala">بررسی تنظیمات تیکت قیمت مرجع</a>` : ''}</span><button class="btn btn-sm" data-reference="${r.id}">${r.status === 'pending' ? 'ارسال درخواست' : 'بررسی وضعیت'}</button></div>`;
  }
  function order(r) {
    return `<div class="list-item dk-operation-row"><span class="grow"><span class="title">سفارش ${esc(r.remote_id)}</span><span class="sub">دیجی‌کالا: ${esc(r.remote_status)} · زمان سفارش ${r.ordered_at ? when(r.ordered_at) : 'نامشخص'} · آخرین بررسی ${when(r.updated_at)}</span>
      ${r.error ? `<span class="sub">نیاز به رسیدگی: ${esc(r.error)}</span>` : ''}
      <details><summary>تاریخچهٔ پیگیری</summary>${r.history.map((h) => `<p class="small">${when(h.created_at)} · ${esc(h.status)}</p>`).join('')}</details></span>
      ${r.order_id ? `<a class="btn btn-sm" href="#/orders/${r.order_id}">مشاهدهٔ سفارش${r.cancelled_at ? ' (لغوشده)' : ''}</a>` : '<a class="btn btn-sm" href="#/digikala/import">بررسی تطبیق آگهی‌ها</a>'}</div>`;
  }
  function paintRows() {
    const eligible = rows();
    page = Math.max(0, Math.min(page, Math.ceil(eligible.length / 20) - 1));
    $('#do-list', view).innerHTML = eligible.slice(page * 20, page * 20 + 20).map(tab === 'buybox' ? buybox : tab === 'reference' ? reference : order).join('') || '<p class="muted">موردی برای نمایش نیست.</p>';
    $('#do-page', view).textContent = `${fa(eligible.length)} مورد · صفحهٔ ${fa(page + 1)} از ${fa(Math.max(1, Math.ceil(eligible.length / 20)))}`;
    $('#do-prev', view).disabled = page === 0;
    $('#do-next', view).disabled = (page + 1) * 20 >= eligible.length;
  }
  function paint() {
    view.innerHTML = `<div class="page-head"><div><h1>پیگیری دیجی‌کالا</h1><p>درخواست قیمت مرجع، رقابت بای‌باکس و سفارش‌ها در یک جا.</p></div><a class="btn" href="#/digikala">قیمت دیجی‌کالا</a></div>
      <div class="seg" role="group" aria-label="بخش پیگیری">${[['buybox', 'بای‌باکس'], ['reference', 'قیمت مرجع'], ['orders', 'سفارش‌ها']].map(([k, t]) => `<button data-tab="${k}" aria-pressed="${tab === k}">${t} (${fa(data[k].length)})</button>`).join('')}</div>
      <div id="do-range"></div><section class="card"><p class="small muted">${tab === 'buybox' ? 'پیشنهاد از API رسمی دیجی‌کالا خوانده می‌شود؛ برنده‌شدن به عوامل دیگری هم بستگی دارد. ارسال فقط در حالت فعال و با تأیید شماست. کاهش تأییدشده تا تغییر فرمول پایه حفظ می‌شود.' : tab === 'reference' ? 'با رد قیمت به علت مرجع، درخواست خودکار ثبت می‌شود؛ فرم مناسب با نوع قیمت کالا خودکار انتخاب می‌شود؛ اگر تشخیص ممکن نباشد، مدیر باید زیردستهٔ تیکت را تنظیم کند. پاسخ یا بسته‌شدن تیکت به معنی تأیید قیمت نیست؛ نتیجه را بررسی و از صفحهٔ قیمت دوباره فعال کنید.' : 'هر ۵ دقیقه سفارش‌های جاری و تاریخچهٔ ۳۰ روز اخیر خوانده می‌شود؛ سوابق ذخیره‌شده باقی می‌مانند. ثبت داخلی پس از تطبیق آگهی و مشخص‌بودن قیمت زمان سفارش انجام می‌شود. تغییرات لغو، ارسال و مرجوعی برای رسیدگی نمایش داده می‌شوند.'}</p>
      <div class="form-actions"><button class="btn" id="do-refresh">تازه‌سازی نمایش</button>${tab === 'buybox' ? '<button class="btn btn-primary" id="do-check">بررسی بای‌باکس</button>' : tab === 'orders' ? '<button class="btn btn-primary" id="do-sync">همگام‌سازی سفارش‌ها</button>' : ''}</div>
      ${tab === 'orders' ? `<p class="small">آخرین همگام‌سازی موفق: ${data.sync.checked_at ? when(data.sync.checked_at) : 'هنوز انجام نشده'}${data.sync.error ? ` · خطا: ${esc(data.sync.error)}` : ''}</p>` : ''}
      <div class="field"><label for="do-query">جستجو با نام یا کد</label><input id="do-query" type="search" value="${esc(query)}"></div><label><input type="checkbox" id="do-attention"${attention ? ' checked' : ''}> فقط نیازمند پیگیری</label>
      <p class="small muted">تا ۵۰۰ مورد اخیر هر بخش نمایش داده می‌شود.</p><div class="list" id="do-list"></div>
      <div class="form-actions"><button class="btn" id="do-prev">قبلی</button><span id="do-page"></span><button class="btn" id="do-next">بعدی</button></div></section>`;
    if (tab === 'orders') orderDateRange($('#do-range', view), { from: selectedRange?.from_date, to: selectedRange?.to_date, onApply: (r) => { selectedRange = r; page = 0; load().catch((err) => toast(err.message, { error: true })); } });
    paintRows();
    if (tab === 'orders' && !selectedRange) $('#do-list', view).textContent = 'برای دیدن سفارش‌ها ابتدا تاریخ را مشخص کنید.';
  }
  async function load() { data = await get('/digikala/operations', selectedRange || {}); paint(); }
  view.oninput = (e) => { if (e.target.id === 'do-query') { query = e.target.value; page = 0; paintRows(); } };
  view.onchange = (e) => { if (e.target.id === 'do-attention') { attention = e.target.checked; page = 0; paintRows(); } };
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tab) { tab = b.dataset.tab; page = 0; paint(); return; }
    if (b.id === 'do-prev' || b.id === 'do-next') { page += b.id === 'do-next' ? 1 : -1; paintRows(); return; }
    if (acting) return;
    acting = true;
    try {
      if (b.dataset.approve && !(await confirm({ title: 'کاهش قیمت برای بای‌باکس؟', text: `قیمت به ${money(Number(b.dataset.price))} تغییر می‌کند. برنده‌شدن پس از ارسال دوباره بررسی می‌شود.`, yes: 'تأیید و ارسال' }))) return;
      busy(b, true);
      if (b.id === 'do-check') await post('/digikala/buybox/check');
      else if (b.id === 'do-sync') await post('/digikala/orders/sync');
      else if (b.dataset.reference) await post(`/digikala/reference/${b.dataset.reference}/check`);
      else if (b.dataset.approve) await post(`/digikala/buybox/${b.dataset.approve}/approve`, { price: Number(b.dataset.price) });
      else if (b.id !== 'do-refresh') return;
      await load();
      toast('نتیجه به‌روز شد.');
    } catch (err) { toast(err.message, { error: true }); busy(b, false); await load().catch(() => {}); } finally { acting = false; }
  };
  await load();
  return ctx.subscribe('digikala', debounce(() => { if (!acting) load().catch(() => {}); }, 500));
}
