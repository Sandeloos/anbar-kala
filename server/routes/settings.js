'use strict';
/** Software settings (manager only). */
const { z, intIn } = require('./validate');

const LABELS = {
  full_sync_minutes: 'فاصله‌ی همگام‌سازی کامل (دقیقه)', incremental_sync_minutes: 'فاصله‌ی همگام‌سازی تغییرات (دقیقه)',
  low_stock_units: 'حد موجودی کم برای کارتابل', backup_keep: 'تعداد نسخه‌های پشتیبان'
};

module.exports = async function settingsRoutes(app) {
  const { settings, audit } = app.ctx;

  app.get('/settings', async () => ({ settings: settings.all(), limits: settings.LIMITS }));

  app.put('/settings', { config: { manager: true } }, async (req) => {
    const L = settings.LIMITS;
    const body = z.object({
      full_sync_minutes: intIn('فاصله‌ی همگام‌سازی کامل', ...L.full_sync_minutes),
      incremental_sync_minutes: intIn('فاصله‌ی همگام‌سازی تغییرات', ...L.incremental_sync_minutes),
      low_stock_units: intIn('حد موجودی کم', ...L.low_stock_units).optional(),
      backup_keep: intIn('تعداد نسخه‌های پشتیبان', ...L.backup_keep).optional()
    }).parse(req.body || {});
    const before = settings.all();
    const after = settings.set(body);
    const changes = audit.diff(before, after, LABELS);
    if (changes.length) audit(req, { action: 'update', entity: 'settings', id: null, summary: 'تغییر تنظیمات', changes });
    return { settings: after, limits: L };
  });
};
