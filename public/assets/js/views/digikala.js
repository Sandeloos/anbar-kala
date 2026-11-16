/**
 * Digikala automatic pricing (#/digikala): the connection (manager), big changes waiting for
 * approval, variants Digikala refused (off, stock 0, reference-price ticket) with one-click
 * re-activation, and what the robot did recently. The formula of each listing is set on the
 * listing itself (آگهی‌ها).
 */
import { get, post, put } from '../api.js';
import { $, esc, icon, fa, moneyText, when, ago, skeleton, empty, toast, busy, showError, confirm, debounce } from '../ui.js';

const STATUS = {
  pending: ['در صف', 'badge-blue'], approved: ['تأییدشده، در صف', 'badge-blue'], needs_approval: ['منتظر تأیید', 'badge-amber'],
  sent: ['فرستاده شد', 'badge-green'], dry_run: ['آزمایشی (فرستاده نشد)', 'badge-navy'], unchanged: ['بدون تغییر', ''],
  rejected: ['دیجی‌کالا نپذیرفت', 'badge-red'], failed: ['ناموفق', 'badge-red'], skipped: ['رد شد', ''], cancelled: ['لغو شد', '']
};
const badge = (s) => `<span class="badge ${(STATUS[s] || [])[1] || ''}">${esc((STATUS[s] || [s])[0])}</span>`;

export async function render(view, ctx) {
  view.innerHTML = skeleton(6);
  const isManager = ctx.me.role === 'manager';
  let d = null;

  async function load() { d = await get('/digikala'); paint(); }

  function connection(s) {
    const steps = `<ol class="dk-steps">
      <li>در پنل فروشندگی دیجی‌کالا: سرویس‌ها ← توکن اختصاصی. کلید عمومی (RSA ۴۰۹۶) را ثبت کنید.</li>
      <li>متن کامل فایل کلید خصوصی (<span class="ltr">digikala-private.pem</span>) را پایین بگذارید و «ثبت کلید» را بزنید.</li>
      <li>در همان صفحه‌ی دیجی‌کالا «کد کلاینت» و «کد اعتبارسنجی» را کپی کنید و پایین بگذارید (کد فقط چند دقیقه اعتبار دارد).</li>
      <li>اول حالت «آزمایشی» را بگذارید، چند روز نتیجه را ببینید، بعد «فعال».</li></ol>`;
    return `<section class="card" aria-labelledby="h-dk-conn">
      <div class="card-head"><h2 id="h-dk-conn">اتصال و حالت</h2></div>
      <dl class="kv">
        <div><dt>حالت</dt><dd>${s.mode === 'live' ? '<span class="badge badge-green">فعال</span>' : s.mode === 'dry_run' ? '<span class="badge badge-navy">آزمایشی</span>' : '<span class="badge">خاموش</span>'}</dd></div>
        <div><dt>اتصال</dt><dd>${s.connected ? `وصل (${when(s.connected_at, 'date')})` : '<span class="muted">وصل نیست</span>'}</dd></div>
        <div><dt>اعتبار توکن</dt><dd>${s.self_token_days_left === null ? '—' : s.self_token_days_left < 21 ? `<span class="badge badge-red">${fa(s.self_token_days_left)} روز مانده؛ تمدید کنید</span>` : `${fa(s.self_token_days_left)} روز مانده`}</dd></div>
        <div><dt>آگهی‌های خودکار</dt><dd>${fa(s.auto_listings)}</dd></div>
        <div><dt>آخرین ارتباط موفق</dt><dd>${s.last_ok_at ? ago(s.last_ok_at) : '—'}</dd></div>
      </dl>
      ${s.last_error ? `<div class="callout callout-err small">${icon('alert')}<span>آخرین خطا: ${esc(s.last_error)}</span></div>` : ''}
      ${isManager ? `
      <form class="form" id="dk-settings" novalidate>
        <div class="form-row cols-3">
          <div class="field"><label for="dk-mode">حالت</label><select id="dk-mode" name="mode">
            <option value="off"${s.mode === 'off' ? ' selected' : ''}>خاموش</option>
            <option value="dry_run"${s.mode === 'dry_run' ? ' selected' : ''}>آزمایشی</option>
            <option value="live"${s.mode === 'live' ? ' selected' : ''}${s.connected ? '' : ' disabled'}>فعال</option></select><span class="hint">آزمایشی: فقط ثبت می‌شود، چیزی فرستاده نمی‌شود</span></div>
          <div class="field"><label for="dk-max">سقف تغییر خودکار (٪)</label><input id="dk-max" name="max_change_pct" inputmode="numeric" value="${fa(s.max_change_pct)}"><span class="hint">تغییر بیشتر منتظر تأیید می‌ماند</span></div>
          <div class="field"><label for="dk-ticket">زیردسته‌ی تیکت قیمت مرجع</label><input id="dk-ticket" name="ticket_sub_category_id" inputmode="numeric" dir="ltr" value="${s.ticket_sub_category_id || ''}"><span class="hint">خالی یعنی تیکت دستی ثبت شود</span></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('check')}ذخیره</button></div>
      </form>
      <details${s.connected ? '' : ' open'}><summary class="link">${s.connected ? 'اتصال دوباره یا تمدید توکن' : 'وصل کردن به دیجی‌کالا'}</summary>
        ${steps}
        <form class="form" id="dk-key" novalidate>
          <div class="field"><label for="dk-pem">کلید خصوصی ${s.has_key ? '<span class="badge badge-green">ثبت شده</span>' : ''}</label>
            <textarea id="dk-pem" name="private_key" class="input dk-key" spellcheck="false" autocomplete="off" placeholder="-----BEGIN PRIVATE KEY----- …"></textarea>
            <span class="hint">رمزشده نگه داشته می‌شود و دیگر نمایش داده نمی‌شود. به هیچ‌کس نفرستید.</span></div>
          <div class="form-actions"><button class="btn" type="submit">ثبت کلید</button></div>
        </form>
        <form class="form" id="dk-connect" novalidate>
          <div class="field"><label for="dk-client">کد کلاینت</label><input id="dk-client" name="client_code" dir="ltr" autocomplete="off" value="${esc(s.client_code || '')}"></div>
          <div class="field"><label for="dk-challenge">کد اعتبارسنجی</label><textarea id="dk-challenge" name="challenge" class="input dk-key" spellcheck="false" autocomplete="off"></textarea></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit"${s.has_key ? '' : ' disabled'}>وصل شو</button></div>
        </form>
      </details>` : '<p class="small muted">تنظیم اتصال فقط با مدیر است.</p>'}
    </section>`;
  }

  const jobLine = (j) => `<div class="list-item"><span class="grow">
      <span class="title">${esc(j.product_name)} <span class="ltr small muted">${esc(j.code || '')}</span></span>
      <span class="sub"><span>${badge(j.status)}</span><span>فعلی ${moneyText(j.current_price, 'toman')}</span><span>فرمول ${moneyText(j.target_price, 'toman')}</span>
        ${j.reference_price ? `<span>مرجع ${moneyText(j.reference_price, 'toman')}</span>` : ''}${j.change_pct !== null ? `<span>${fa(j.change_pct)}٪</span>` : ''}<span>${ago(j.updated_at)}</span></span>
      ${j.error ? `<span class="sub small">${esc(j.error)}</span>` : ''}</span>
      ${j.status === 'needs_approval' ? `<button class="btn btn-sm btn-primary" type="button" data-approve="${j.id}">${icon('check')}تأیید</button><button class="btn btn-sm btn-ghost" type="button" data-reject="${j.id}">رد</button>` : ''}</div>`;

  function paint() {
    const s = d.status;
    const approval = d.attention.filter((j) => j.status === 'needs_approval');
    view.innerHTML = `
      <div class="page-head"><div><h1>قیمت دیجی‌کالا</h1><p>قیمت آگهی‌های دیجی‌کالا با تغییر قیمت سایت شرکت، با فرمول همان آگهی خودکار عوض می‌شود. فرمول هر بسته‌بندی را در «آگهی‌ها» تعیین کنید.</p></div>
        <div class="page-actions"><a class="btn" href="#/listings?platform=1">${icon('link')}آگهی‌ها</a></div></div>
      ${s.mode === 'dry_run' ? `<div class="callout callout-info">${icon('info')}<span>حالت آزمایشی: چیزی به دیجی‌کالا فرستاده نمی‌شود؛ فقط ثبت می‌شود که چه قیمتی فرستاده می‌شد.</span></div>` : ''}
      <div class="dk-grid">
        ${connection(s)}
        <div class="stack">
          <section class="card" aria-labelledby="h-dk-approve">
            <div class="card-head"><h2 id="h-dk-approve">منتظر تأیید (${fa(approval.length)})</h2></div>
            <p class="small muted">تغییر بیشتر از ${fa(s.max_change_pct)}٪ خودکار فرستاده نمی‌شود؛ شاید قیمت سایت اشتباه وارد شده باشد.</p>
            ${approval.length ? `<div class="list">${approval.map(jobLine).join('')}</div>` : empty('check', 'چیزی منتظر تأیید نیست')}
          </section>
          <section class="card" aria-labelledby="h-dk-blocked">
            <div class="card-head"><h2 id="h-dk-blocked">متوقف‌شده (${fa(d.blocked.length)})</h2></div>
            <p class="small muted">دیجی‌کالا قیمت را نپذیرفت (خارج از بازه‌ی قیمت مرجع): تنوع غیرفعال، موجودی صفر و درخواست تغییر قیمت مرجع ثبت شد. بعد از تأیید قیمت مرجع، دوباره فعال کنید.</p>
            ${d.blocked.length ? `<div class="list">${d.blocked.map((l) => `<div class="list-item"><span class="grow"><span class="title">${esc(l.product_name)} <span class="ltr small muted">${esc(l.code || '')}</span></span>
              <span class="sub"><span>${esc(l.company_name)}</span><span>موجودی قبلی ${fa(l.dk_stock_before)}</span><span>${ago(l.updated_at)}</span></span></span>
              <button class="btn btn-sm" type="button" data-reactivate="${l.id}" data-stock="${l.dk_stock_before ?? ''}">${icon('refresh')}فعال‌سازی دوباره</button></div>`).join('')}</div>` : empty('check', 'تنوع متوقفی نیست')}
          </section>
        </div>
      </div>
      <section class="card" aria-labelledby="h-dk-recent">
        <div class="card-head"><h2 id="h-dk-recent">کارهای اخیر</h2></div>
        ${d.recent.length ? `<div class="list">${d.recent.map(jobLine).join('')}</div>` : empty('trend', 'هنوز کاری انجام نشده', 'بعد از روشن کردن قیمت‌گذاری خودکار یک آگهی، هر تغییر قیمت سایت اینجا دیده می‌شود.')}
      </section>`;
    bindForms();
  }

  function bindForms() {
    const settingsForm = $('#dk-settings', view);
    if (!settingsForm) return;
    const send = (form, fn, okText) => form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      busy(btn, true);
      try { await fn(form); toast(okText); await load(); } catch (err) { showError(form, err); busy(btn, false); }
    });
    send(settingsForm, async (f) => {
      if (f.elements.mode.value === 'live' && d.status.mode !== 'live'
        && !(await confirm({ title: 'قیمت‌ها واقعاً فرستاده شود؟', text: 'از این به بعد قیمت آگهی‌های خودکار در دیجی‌کالا عوض می‌شود.', yes: 'فعال کن' }))) throw Object.assign(new Error('لغو شد.'), { fields: {} });
      await put('/digikala/settings', {
        mode: f.elements.mode.value, max_change_pct: f.elements.max_change_pct.value,
        ticket_sub_category_id: f.elements.ticket_sub_category_id.value.trim() === '' ? null : f.elements.ticket_sub_category_id.value
      });
    }, 'تنظیمات ذخیره شد.');
    send($('#dk-key', view), (f) => post('/digikala/key', { private_key: f.elements.private_key.value }).then(() => { f.reset(); }), 'کلید خصوصی ثبت شد.');
    send($('#dk-connect', view), (f) => post('/digikala/connect', { client_code: f.elements.client_code.value.trim(), challenge: f.elements.challenge.value }), 'به دیجی‌کالا وصل شد.');
  }

  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.approve) {
        if (!(await confirm({ title: 'این تغییر قیمت فرستاده شود؟', yes: 'تأیید و ارسال' }))) return;
        busy(b, true); await post(`/digikala/jobs/${b.dataset.approve}/approve`); toast('تأیید شد؛ قیمت فرستاده می‌شود.');
      } else if (b.dataset.reject) {
        busy(b, true); await post(`/digikala/jobs/${b.dataset.reject}/reject`); toast('رد شد؛ قیمت دیجی‌کالا دست نخورد.');
      } else if (b.dataset.reactivate) {
        if (!(await confirm({ title: 'قیمت مرجع تأیید شده؟', text: `تنوع دوباره فعال می‌شود، موجودی ${fa(b.dataset.stock || 0)} برمی‌گردد و قیمت با فرمول دوباره فرستاده می‌شود.`, yes: 'فعال کن' }))) return;
        busy(b, true); await post(`/digikala/listings/${b.dataset.reactivate}/reactivate`, {}); toast('تنوع دوباره فعال شد.');
      } else return;
      await load();
    } catch (err) { toast(err.message, { error: true }); busy(b, false); }
  };

  await load();
  const off = ctx.subscribe('digikala', debounce(() => load().catch(() => {}), 500));
  return () => off();
}
