/** Software settings (manager only): how often the company sites are read. */
import { get, put } from '../api.js';
import { $, icon, fa, toast, showError, formValues, busy, latin } from '../ui.js';

export async function render(view) {
  const { settings: s, limits } = await get('/settings');
  view.innerHTML = `
    <div class="page-head"><div><h1>تنظیمات</h1><p>فقط مدیر این بخش را می‌بیند. هر تغییر در گزارش فعالیت ثبت می‌شود.</p></div></div>
    <section class="card" aria-labelledby="h-sync" style="max-width:720px">
      <div class="card-head"><div><h2 id="h-sync">همگام‌سازی با سایت شرکت‌ها</h2>
        <p>اگر افزونه‌ی وردپرس روی سایت نصب باشد، تغییرات همان لحظه می‌رسد و این زمان‌بندی فقط پشتیبان است.</p></div></div>
      <form class="form" id="f-set" novalidate>
        <div class="field"><label for="s-inc">هر چند دقیقه کالاهای تغییرکرده خوانده شود؟</label>
          <div class="input-suffix"><input id="s-inc" name="incremental_sync_minutes" inputmode="numeric" value="${fa(s.incremental_sync_minutes)}"><span>دقیقه</span></div>
          <span class="hint">بین ${fa(limits.incremental_sync_minutes[0])} تا ${fa(limits.incremental_sync_minutes[1])}. هرچه کمتر، قیمت‌ها تازه‌تر (بار کمی روی سایت دارد).</span></div>
        <div class="field"><label for="s-full">هر چند دقیقه همه‌ی کالاها کامل خوانده شود؟</label>
          <div class="input-suffix"><input id="s-full" name="full_sync_minutes" inputmode="numeric" value="${fa(s.full_sync_minutes)}"><span>دقیقه</span></div>
          <span class="hint">بین ${fa(limits.full_sync_minutes[0])} تا ${fa(limits.full_sync_minutes[1])}. خواندن کامل کالاهای حذف‌شده و تغییر موجودی را هم پیدا می‌کند.</span></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('check')}ذخیره</button></div>
      </form>
    </section>`;
  const f = $('#f-set', view);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(f);
    const btn = $('button[type=submit]', f);
    busy(btn, true);
    try {
      await put('/settings', { incremental_sync_minutes: latin(v.incremental_sync_minutes), full_sync_minutes: latin(v.full_sync_minutes) });
      toast('تنظیمات ذخیره شد.');
    } catch (err) { showError(f, err); } finally { busy(btn, false); }
  });
}
