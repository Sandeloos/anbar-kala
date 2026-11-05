/** People who use the software (manager only): add, edit, deactivate, one-time passwords. */
import { get, post, put } from '../api.js';
import { $, esc, icon, ago, skeleton, toast, openSheet, closeSheet, fieldErrors, showError, formValues, busy, confirm, copy, ROLES, initials, colorFor, latin } from '../ui.js';

export async function render(view, ctx) {
  view.innerHTML = skeleton(4);
  let items = [];

  function paint() {
    view.innerHTML = `
      <div class="page-head">
        <div><h1>کاربران</h1><p>مدیر کاربران را می‌سازد و مدیریت می‌کند؛ ادمین‌ها به همه‌ی بخش‌های کاری دسترسی دارند. کاربر پاک نمی‌شود، فقط غیرفعال می‌شود تا سابقه‌ی کارهایش بماند.</p></div>
        <div class="page-actions"><button class="btn btn-primary" type="button" data-add>${icon('plus')}کاربر جدید</button></div>
      </div>
      <section class="card card-flush"><div class="table-wrap"><table class="table">
        <thead><tr><th scope="col">کاربر</th><th scope="col">نقش</th><th scope="col">وضعیت</th><th scope="col">آخرین فعالیت</th><th scope="col" class="col-actions"><span class="sr-only">کارها</span></th></tr></thead>
        <tbody>${items.map((u) => `<tr>
          <td class="cell-main"><div style="display:flex;gap:10px;align-items:center"><span class="avatar" style="background:${colorFor(u.username)}" aria-hidden="true">${esc(initials(u.name))}</span>
            <div class="cell-title"><strong>${esc(u.name)}${u.id === ctx.me.id ? ' <span class="badge">شما</span>' : ''}</strong><small class="ltr">${esc(u.username)}</small></div></div></td>
          <td data-label="نقش"><span class="badge ${u.role === 'manager' ? 'badge-navy' : ''}">${ROLES[u.role]}</span></td>
          <td data-label="وضعیت">${!u.active ? '<span class="state state-mute">غیرفعال</span>' : u.must_change_password ? '<span class="state state-warn">منتظر اولین ورود</span>' : '<span class="state state-ok">فعال</span>'}</td>
          <td data-label="آخرین فعالیت">${esc(ago(u.last_seen_at || u.last_login_at))}</td>
          <td class="col-actions"><a class="btn btn-sm btn-ghost" href="#/activity?user=${u.id}">${icon('pulse')}کارها</a>
            ${u.id !== ctx.me.id ? `<button class="btn btn-sm" type="button" data-edit="${u.id}">${icon('edit')}ویرایش</button>` : '<a class="btn btn-sm" href="#/profile">پروفایل</a>'}</td>
        </tr>`).join('')}</tbody></table></div></section>`;
  }

  function showTemp(title, user, pw) {
    openSheet(title, `<div class="form">
      <p>این رمز موقت را به <b>${esc(user.name)}</b> بدهید. با اولین ورود باید رمز شخصی خودش را بگذارد.</p>
      <div class="secret"><span class="small muted">نام کاربری: <b class="ltr">${esc(user.username)}</b></span><code>${esc(pw)}</code></div>
      <div class="form-actions"><button class="btn btn-primary" type="button" data-copy-pw>${icon('copy')}کپی نام کاربری و رمز</button><button class="btn btn-ghost" type="button" data-done>بستم</button></div>
      <p class="small muted">این رمز دوباره نشان داده نمی‌شود؛ اگر گم شد، از «ویرایش ← رمز موقت جدید» یکی دیگر بسازید.</p></div>`);
    $('[data-copy-pw]').addEventListener('click', () => copy(`نام کاربری: ${user.username}\nرمز موقت: ${pw}\nنشانی: ${location.origin}`, 'اطلاعات ورود'));
    $('[data-done]').addEventListener('click', closeSheet);
  }

  function sheet(u) {
    const body = openSheet(u ? `ویرایش «${u.name}»` : 'کاربر جدید', `<form class="form" id="f-user" novalidate>
      <div class="field"><label for="u-name">نام و نام خانوادگی</label><input id="u-name" name="name" value="${esc(u ? u.name : '')}" required></div>
      <div class="field"><label for="u-username">نام کاربری (برای ورود)</label><input id="u-username" name="username" dir="ltr" autocapitalize="none" spellcheck="false" value="${esc(u ? u.username : '')}" placeholder="ali.rezaei" required>
        <span class="hint">حروف انگلیسی، عدد، نقطه یا خط تیره.</span></div>
      <div class="field"><label for="u-role">نقش</label><select id="u-role" name="role">
        <option value="admin"${!u || u.role === 'admin' ? ' selected' : ''}>ادمین — همه‌ی کارهای روزانه</option>
        <option value="manager"${u && u.role === 'manager' ? ' selected' : ''}>مدیر — به‌علاوه‌ی مدیریت کاربران و تنظیمات</option></select></div>
      <div class="form-row cols-2">
        <div class="field"><label for="u-phone">موبایل (اختیاری)</label><input id="u-phone" name="phone" dir="ltr" inputmode="tel" value="${esc(u ? u.phone || '' : '')}"></div>
        <div class="field"><label for="u-email">ایمیل (اختیاری)</label><input id="u-email" name="email" type="email" dir="ltr" value="${esc(u ? u.email || '' : '')}"></div>
      </div>
      ${u ? `<label class="switch"><span><strong>فعال</strong><small>کاربر غیرفعال نمی‌تواند وارد شود و همان لحظه از همه‌ی دستگاه‌ها خارج می‌شود.</small></span><input type="checkbox" name="active" ${u.active ? 'checked' : ''}><i></i></label>` : ''}
      <div class="form-actions"><button class="btn btn-primary" type="submit">${u ? 'ذخیره' : 'ساخت کاربر و رمز موقت'}</button>
        ${u ? `<button class="btn btn-ghost push" type="button" data-reset>${icon('key')}رمز موقت جدید</button>` : ''}</div>
    </form>`);
    const f = $('#f-user', body);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(f);
      v.phone = latin(v.phone);
      const errs = {};
      if (!v.name.trim()) errs.name = 'نام را وارد کنید.';
      if (!v.username.trim()) errs.username = 'نام کاربری را وارد کنید.';
      if (fieldErrors(f, errs)) return;
      const btn = $('button[type=submit]', f);
      busy(btn, true);
      try {
        if (u) {
          await put(`/users/${u.id}`, v, { version: u.version });
          closeSheet();
          toast('تغییرات کاربر ذخیره شد.');
        } else {
          const r = await post('/users', v);
          showTemp('کاربر ساخته شد', r.user, r.temp_password);
        }
        items = (await get('/users')).items;
        paint();
      } catch (err) { showError(f, err); busy(btn, false); }
    });
    const reset = $('[data-reset]', body);
    if (reset) reset.addEventListener('click', async () => {
      if (!(await confirm({ title: `رمز موقت جدید برای «${u.name}»؟`, text: 'رمز فعلی‌اش دیگر کار نمی‌کند و از همه‌ی دستگاه‌ها خارج می‌شود.', yes: 'ساخت رمز موقت', danger: true }))) return;
      try {
        const r = await post(`/users/${u.id}/reset-password`);
        showTemp('رمز موقت جدید', u, r.temp_password);
        items = (await get('/users')).items;
        paint();
      } catch (err) { toast(err.message, { error: true }); }
    });
  }

  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-add')) sheet(null);
    if (b.dataset.edit) sheet(items.find((u) => u.id === Number(b.dataset.edit)));
  };
  items = (await get('/users')).items;
  paint();
}
