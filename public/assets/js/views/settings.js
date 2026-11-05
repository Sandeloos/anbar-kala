/** Software settings (manager only): sync timing, inbox limit, backups and system health. */
import { get, put, post } from '../api.js';
import { $, esc, icon, fa, when, toast, showError, formValues, busy, latin, confirm } from '../ui.js';

const size = (b) => (b > 1048576 ? `${fa(Math.round(b / 104857.6) / 10)} مگابایت` : `${fa(Math.max(1, Math.round(b / 1024)))} کیلوبایت`);

export async function render(view) {
  const [{ settings: s, limits }, sys] = await Promise.all([get('/settings'), get('/system')]);
  const num = (name, label, unit, hint) => `<div class="field"><label for="s-${name}">${label}</label>
    <div class="input-suffix"><input id="s-${name}" name="${name}" inputmode="numeric" value="${fa(s[name])}"><span>${unit}</span></div>
    <span class="hint">${hint} (بین ${fa(limits[name][0])} تا ${fa(limits[name][1])})</span></div>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>تنظیمات</h1><p>فقط مدیر این بخش را می‌بیند. هر تغییر در گزارش فعالیت ثبت می‌شود.</p></div></div>
    <div class="grid grid-2">
      <section class="card" aria-labelledby="h-set">
        <div class="card-head"><h2 id="h-set">همگام‌سازی و کارتابل</h2></div>
        <form class="form" id="f-set" novalidate>
          ${num('incremental_sync_minutes', 'هر چند دقیقه کالاهای تغییرکرده خوانده شود؟', 'دقیقه', 'با افزونه‌ی وردپرس تغییرات همان لحظه می‌رسد؛ این پشتیبان است')}
          ${num('full_sync_minutes', 'هر چند دقیقه همه‌ی کالاها کامل خوانده شود؟', 'دقیقه', 'کالاهای حذف‌شده و تغییر موجودی را هم پیدا می‌کند')}
          ${num('low_stock_units', 'موجودی سایت چقدر باشد «کم» حساب شود؟', 'عدد', 'کمتر یا مساوی این، برای آگهی‌های دیجی‌کالا و باسلام در کارتابل کار می‌سازد')}
          ${num('backup_keep', 'چند نسخه‌ی پشتیبان نگه داشته شود؟', 'نسخه', 'هر شب یک نسخه گرفته می‌شود')}
          <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('check')}ذخیره</button></div>
        </form>
      </section>
      <section class="card" aria-labelledby="h-sys">
        <div class="card-head"><h2 id="h-sys">سیستم و پشتیبان</h2><button class="btn btn-sm" type="button" data-backup>${icon('download')}پشتیبان‌گیری همین الان</button></div>
        <dl class="kv">
          <div><dt>نسخه‌ی نرم‌افزار</dt><dd class="ltr">${esc(sys.version)} · Node ${esc(sys.node)}</dd></div>
          <div><dt>روشن از</dt><dd>${when(sys.started_at, 'full')}</dd></div>
          <div><dt>آدرس عمومی (برای افزونه)</dt><dd class="ltr small">${esc(sys.public_url || 'تنظیم نشده (PUBLIC_URL)')}</dd></div>
          <div><dt>حجم دیتابیس</dt><dd>${size(sys.db_size)}</dd></div>
          <div><dt>داده‌ها</dt><dd class="small">${fa(sys.counts.companies)} شرکت · ${fa(sys.counts.products)} کالا · ${fa(sys.counts.orders)} سفارش · ${fa(sys.counts.history)} تغییر قیمت</dd></div>
        </dl>
        <h3 class="fieldset-title" style="margin-top:14px;font-size:14px">نسخه‌های پشتیبان</h3>
        <div class="list backup-list" id="backups"></div>
        <p class="small muted">نسخه‌ی پشتیبان همه‌ی داده‌هاست؛ کلیدهای API شرکت‌ها در آن رمزشده می‌ماند و فقط با همین APP_SECRET باز می‌شود. برای بازگرداندن، راهنمای docs/deploy.md را ببینید.</p>
      </section>
    </div>`;
  const paintBackups = (list) => {
    $('#backups', view).innerHTML = list.length ? list.map((b) => `<div class="list-item"><span class="grow"><span class="title ltr">${esc(b.name)}</span><span class="sub"><span>${when(b.at, 'full')}</span><span>${size(b.size)}</span></span></span>
      <a class="btn btn-sm btn-ghost" href="/api/system/backups/${encodeURIComponent(b.name)}">${icon('download')}دانلود</a></div>`).join('')
      : '<p class="small muted">هنوز نسخه‌ای گرفته نشده.</p>';
  };
  paintBackups(sys.backups);

  const f = $('#f-set', view);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(Object.entries(formValues(f)).map(([k, x]) => [k, latin(x)]));
    const btn = $('button[type=submit]', f);
    busy(btn, true);
    try { await put('/settings', v); toast('تنظیمات ذخیره شد.'); } catch (err) { showError(f, err); } finally { busy(btn, false); }
  });
  view.onclick = async (e) => {
    const b = e.target.closest('[data-backup]');
    if (!b) return;
    if (!(await confirm({ title: 'همین الان نسخه‌ی پشتیبان گرفته شود؟', yes: 'پشتیبان‌گیری' }))) return;
    busy(b, true);
    try { const r = await post('/system/backup'); paintBackups(r.backups); toast(`نسخه‌ی پشتیبان ساخته شد (${size(r.backup.size)}).`); } catch (err) { toast(err.message, { error: true }); } finally { busy(b, false); }
  };
}
