/** My profile: details, password, signed-in devices and my own recent activity. */
import { get, put, post, del } from '../api.js';
import { $, esc, icon, fa, when, skeleton, empty, toast, fieldErrors, showError, formValues, busy, confirm, ROLES, initials, colorFor, latin } from '../ui.js';
import { entryHtml } from './timeline.js';

function device(ua) {
  const s = String(ua || '');
  const os = /Android/i.test(s) ? 'اندروید' : /iPhone|iPad/i.test(s) ? 'آیفون/آیپد' : /Windows/i.test(s) ? 'ویندوز' : /Mac OS/i.test(s) ? 'مک' : /Linux/i.test(s) ? 'لینوکس' : 'دستگاه';
  const br = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return `${os}${br ? ` · ${br}` : ''}`;
}

export async function render(view, ctx) {
  view.innerHTML = skeleton(5);
  const [{ items: sessions }, { items: mine }] = await Promise.all([get('/me/sessions'), get('/me/activity', { limit: 30 })]);
  const me = ctx.me;
  view.innerHTML = `
    <div class="page-head"><div style="display:flex;gap:14px;align-items:center">
      <span class="avatar lg" style="background:${colorFor(me.username)}" aria-hidden="true">${esc(initials(me.name))}</span>
      <div><h1>${esc(me.name)}</h1><p><span class="badge ${me.role === 'manager' ? 'badge-navy' : ''}">${ROLES[me.role]}</span> · نام کاربری <b class="ltr">${esc(me.username)}</b></p></div></div></div>
    <div class="grid grid-2">
      <section class="card" aria-labelledby="h-me"><div class="card-head"><h2 id="h-me">مشخصات</h2></div>
        <form class="form" id="f-me" novalidate>
          <div class="field"><label for="me-name-i">نام و نام خانوادگی</label><input id="me-name-i" name="name" value="${esc(me.name)}" required></div>
          <div class="field"><label for="me-phone">موبایل</label><input id="me-phone" name="phone" dir="ltr" inputmode="tel" value="${esc(me.phone || '')}"></div>
          <div class="field"><label for="me-email">ایمیل</label><input id="me-email" name="email" type="email" dir="ltr" value="${esc(me.email || '')}"></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">ذخیره</button></div>
        </form></section>
      <section class="card" aria-labelledby="h-pw"><div class="card-head"><div><h2 id="h-pw">تغییر رمز عبور</h2><p>بعد از تغییر رمز، بقیه‌ی دستگاه‌ها خارج می‌شوند.</p></div></div>
        <form class="form" id="f-pw" novalidate>
          <input type="hidden" name="username" autocomplete="username" value="${esc(me.username)}">
          <div class="field"><label for="pw-cur">رمز فعلی</label><input id="pw-cur" name="current" type="password" dir="ltr" autocomplete="current-password" required></div>
          <div class="field"><label for="pw-next">رمز جدید (دست‌کم ۸ نویسه)</label><input id="pw-next" name="next" type="password" dir="ltr" autocomplete="new-password" minlength="8" required></div>
          <div class="field"><label for="pw-rep">تکرار رمز جدید</label><input id="pw-rep" name="repeat" type="password" dir="ltr" autocomplete="new-password" required></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('key')}تغییر رمز</button></div>
        </form></section>
    </div>
    <section class="card card-flush" aria-labelledby="h-dev">
      <div class="card-head"><div><h2 id="h-dev">دستگاه‌هایی که وارد هستند</h2><p>اگر دستگاهی را نمی‌شناسید، از همه خارجش کنید و رمز را عوض کنید.</p></div>
        ${sessions.length > 1 ? `<button class="btn btn-sm" type="button" data-others>${icon('logout')}خروج از بقیه‌ی دستگاه‌ها</button>` : ''}</div>
      <div class="list">${sessions.map((s) => `<div class="list-item"><span class="list-icon">${icon('device')}</span>
        <span class="grow"><span class="title">${esc(device(s.user_agent))}${s.current ? ' <span class="badge badge-green">همین دستگاه</span>' : ''}</span>
        <span class="sub"><span class="ltr">${esc(s.ip || '')}</span><span>ورود: ${when(s.created_at)}</span><span>آخرین فعالیت: ${when(s.last_seen_at, 'ago')}</span></span></span></div>`).join('')}</div>
    </section>
    <section class="card card-flush" aria-labelledby="h-mine">
      <div class="card-head"><h2 id="h-mine">کارهای اخیر من</h2><a class="btn btn-sm btn-ghost" href="#/activity?user=${me.id}">همه</a></div>
      ${mine.length ? `<div class="timeline">${mine.map((a) => entryHtml(a, { showUser: false })).join('')}</div>` : empty('pulse', 'هنوز کاری ثبت نشده')}
    </section>`;

  const fm = $('#f-me', view);
  fm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(fm);
    if (!v.name.trim()) { fieldErrors(fm, { name: 'نام را وارد کنید.' }); return; }
    const btn = $('button[type=submit]', fm);
    busy(btn, true);
    try {
      const { user } = await put('/me', { ...v, phone: latin(v.phone) });
      ctx.setUser(user);
      toast('مشخصات ذخیره شد.');
    } catch (err) { showError(fm, err); } finally { busy(btn, false); }
  });
  const fp = $('#f-pw', view);
  fp.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(fp);
    const errs = {};
    if (!v.current) errs.current = 'رمز فعلی را وارد کنید.';
    if (v.next.length < 8) errs.next = 'رمز جدید باید دست‌کم ۸ نویسه باشد.';
    else if (v.next !== v.repeat) errs.repeat = 'تکرار رمز یکی نیست.';
    if (fieldErrors(fp, errs)) return;
    const btn = $('button[type=submit]', fp);
    busy(btn, true);
    try {
      const r = await post('/me/password', { current: v.current, next: v.next });
      fp.reset();
      toast(r.signed_out_others ? `رمز عوض شد و ${fa(r.signed_out_others)} دستگاه دیگر خارج شد.` : 'رمز عوض شد.');
    } catch (err) { showError(fp, err); } finally { busy(btn, false); }
  });
  view.onclick = async (e) => {
    const b = e.target.closest('[data-others]');
    if (!b) return;
    if (!(await confirm({ title: 'از بقیه‌ی دستگاه‌ها خارج شوید؟', text: 'فقط همین دستگاه وارد می‌ماند.', yes: 'خروج از بقیه' }))) return;
    try {
      const r = await del('/me/sessions/others');
      toast(`${fa(r.ended)} دستگاه خارج شد.`);
      render(view, ctx);
    } catch (err) { toast(err.message, { error: true }); }
  };
}
