/** Sandeloos' own warehouses (Sandeloos, Radloos, …). */
import { get, post, put } from '../api.js';
import { $, esc, icon, fa, when, skeleton, empty, toast, openSheet, closeSheet, fieldErrors, showError, formValues, busy } from '../ui.js';

export async function render(view) {
  view.innerHTML = skeleton(3);
  let items = [];

  function paint() {
    view.innerHTML = `
      <div class="page-head">
        <div><h1>انبارها</h1><p>انبارهای خود مجموعه. کالای اضافه، کالای خودتان و مرجوعی‌ها در این انبارها نگه داشته می‌شود.</p></div>
        <div class="page-actions"><button class="btn btn-primary" type="button" data-add>${icon('plus')}انبار جدید</button></div>
      </div>
      <section class="card card-flush">
        ${items.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th scope="col">انبار</th><th scope="col" class="col-num">شرکت‌هایی که اضافه‌شان اینجا می‌آید</th><th scope="col" class="col-num">کالاهایی که اینجا تنظیم شده</th><th scope="col">ساخته شده</th><th scope="col" class="col-actions"><span class="sr-only">کارها</span></th></tr></thead>
          <tbody>${items.map((w) => `<tr>
            <td class="cell-main"><div class="cell-title"><strong>${esc(w.name)}</strong>${w.notes ? `<small>${esc(w.notes)}</small>` : ''}</div>
              ${w.active ? '' : '<span class="badge">غیرفعال</span>'}</td>
            <td class="col-num" data-label="شرکت‌ها">${fa(w.companies)}</td>
            <td class="col-num" data-label="کالاها">${fa(w.products)}</td>
            <td data-label="ساخته شده">${when(w.created_at, 'date')}</td>
            <td class="col-actions"><button class="btn btn-sm" type="button" data-edit="${w.id}">${icon('edit')}ویرایش</button></td>
          </tr>`).join('')}</tbody></table></div>` : empty('warehouse', 'انباری نیست')}
      </section>
      <div class="callout callout-info small">${icon('info')}<span>موجودی هر انبار (به تفکیک صاحب کالا: هر شرکت، سندلوس یا رادلوس) از فاز دوم و با ثبت دریافت روزانه پر می‌شود. انبار هیچ‌وقت پاک نمی‌شود تا سابقه‌اش بماند؛ فقط غیرفعال می‌شود.</span></div>`;
  }

  function sheet(w) {
    const body = openSheet(w ? `ویرایش انبار «${w.name}»` : 'انبار جدید', `<form class="form" id="f-wh" novalidate>
      <div class="field"><label for="w-name">نام انبار</label><input id="w-name" name="name" value="${esc(w ? w.name : '')}" required></div>
      <div class="field"><label for="w-notes">توضیح (اختیاری)</label><textarea id="w-notes" name="notes" placeholder="مثلاً نشانی یا مسئول انبار">${esc(w ? w.notes || '' : '')}</textarea></div>
      ${w ? `<label class="switch"><span><strong>فعال</strong><small>انبار غیرفعال در انتخاب‌ها نمی‌آید.</small></span><input type="checkbox" name="active" ${w.active ? 'checked' : ''}><i></i></label>` : ''}
      <div class="form-actions"><button class="btn btn-primary" type="submit">ذخیره</button></div></form>`);
    const f = $('#f-wh', body);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(f);
      if (!v.name.trim()) { fieldErrors(f, { name: 'نام انبار را وارد کنید.' }); return; }
      const btn = $('button[type=submit]', f);
      busy(btn, true);
      try {
        items = (w ? await put(`/warehouses/${w.id}`, v) : await post('/warehouses', v)).items;
        closeSheet();
        paint();
        toast('انبار ذخیره شد.');
      } catch (err) { showError(f, err); busy(btn, false); }
    });
  }

  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-add')) sheet(null);
    if (b.dataset.edit) sheet(items.find((w) => w.id === Number(b.dataset.edit)));
  };
  items = (await get('/warehouses')).items;
  paint();
}
