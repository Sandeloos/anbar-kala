import { $, esc, toast } from './ui.js';
import { jalaliToday, toIso } from './jalali.js';

export function orderDateRange(view, { prefix = 'order-range', from = '', to = '', onApply }) {
  const host = document.createElement('section');
  host.className = 'card';
  host.innerHTML = `<h2>انتخاب تاریخ سفارش‌ها</h2><p class="small muted">ابتدا بازه را مشخص کنید، سپس سفارش‌ها را ببینید.</p>
    <form class="form" novalidate><div class="form-row cols-2">
    <div class="field"><label for="${prefix}-from">از تاریخ</label><input id="${prefix}-from" inputmode="numeric" dir="ltr" placeholder="۱۴۰۵/۰۸/۲۷" value="${esc(from)}"></div>
    <div class="field"><label for="${prefix}-to">تا تاریخ (شامل این روز)</label><input id="${prefix}-to" inputmode="numeric" dir="ltr" placeholder="۱۴۰۵/۰۸/۲۷" value="${esc(to)}"></div></div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">نمایش سفارش‌ها</button><button class="btn" type="button" data-days="0">امروز</button><button class="btn" type="button" data-days="-1">دیروز</button><button class="btn" type="button" data-days="-6">۷ روز اخیر</button></div></form>`;
  view.prepend(host);
  const apply = () => {
    const fromDate = $(`#${prefix}-from`, host).value;
    const toDate = $(`#${prefix}-to`, host).value;
    const start = toIso(fromDate, '0'), end = toIso(toDate, '0');
    if (!start || !end || start > end) { toast('بازهٔ تاریخ معتبر وارد کنید؛ تاریخ پایان نباید قبل از شروع باشد.', { error: true }); return; }
    onApply({ from: start, to: new Date(Date.parse(end) + 864e5).toISOString(), from_date: fromDate, to_date: toDate });
  };
  $('form', host).onsubmit = (e) => { e.preventDefault(); e.stopPropagation(); apply(); };
  host.onclick = (e) => {
    const b = e.target.closest('[data-days]');
    if (!b) return;
    e.stopPropagation();
    const n = Number(b.dataset.days);
    $(`#${prefix}-from`, host).value = jalaliToday(n);
    $(`#${prefix}-to`, host).value = jalaliToday(n === -1 ? -1 : 0);
    apply();
  };
  return { apply, element: host };
}
