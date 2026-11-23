const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

test('catalog compares descriptions and saves a multiplier inline without losing another draft', async ({ page }) => {
  await page.goto('/');
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#shell')).toBeVisible();
  await page.route('**/api/digikala', (route) => route.fulfill({ json: { status: { connected: true, mode: 'live' } } }));
  const suggestion = { product_id: 10, name: 'کابل مسی', description: 'کابل مسی روکش دار', company_name: 'شرکت', currency: 'toman', units_per_pack: 4, regular_price: 4000000, score: 0.7, confident: false, why: 'name' };
  const items = [1, 2].map((id) => ({ variant_id: id, title: 'کابل مسی بسته 2 عددی', description: 'مناسب برق صنعتی', price_sale: 2000000, units_guess: 2, active: true, suggestions: [suggestion] }));
  await page.route('**/api/digikala/import/preview', (route) => route.fulfill({ json: { preview_id: 'test-preview', total: 2, already_linked: 0, items, opportunities: [], companies: [], complete: true } }));
  let body;
  await page.route('**/api/digikala/import', async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { created: 1, skipped: [] } });
  });
  await page.goto('/#/digikala/import');
  await page.locator('#di-read').click();
  const first = page.locator('[data-v="1"]');
  const second = page.locator('[data-v="2"]');
  await first.locator('summary').click();
  await expect(first).toContainText('مناسب برق صنعتی');
  await expect(first).toContainText('کابل مسی روکش دار');
  await second.locator('[data-units]').fill('۳');
  await first.locator('[data-formula-toggle]').click();
  await first.locator('[data-multiplier]').fill('۱٫۵');
  await expect(first.locator('[data-price]')).toContainText('۳۰۰٬۰۰۰');
  await first.locator('[data-save-one]').click();
  await expect(first).toHaveCount(0);
  expect(body.rows).toEqual([{ variant_id: 1, product_id: 10, units: 2, auto_price: true, multiplier: 1.5 }]);
  await expect(second.locator('[data-units]')).toHaveValue('۳');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test('bulk multiplier applies to selected matches across pages and is included in batch approval', async ({ page }) => {
  await page.goto('/');
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#shell')).toBeVisible();
  await page.route('**/api/digikala', (route) => route.fulfill({ json: { status: { connected: true, mode: 'dry_run' } } }));
  const suggestion = { product_id: 10, name: 'کابل مسی', company_name: 'شرکت', currency: 'toman', units_per_pack: 4, regular_price: 4000000, score: 0.7, confident: false, why: 'name' };
  const items = Array.from({ length: 21 }, (_, i) => ({ variant_id: i + 1, title: `کابل مسی بسته 2 عددی ${i + 1}`, price_sale: 2000000, units_guess: 2, active: true, suggestions: [suggestion] }));
  await page.route('**/api/digikala/import/preview', (route) => route.fulfill({ json: { preview_id: 'test-preview', total: 21, already_linked: 0, items, companies: [], complete: true } }));
  let body;
  await page.route('**/api/digikala/import', async (route) => { body = route.request().postDataJSON(); await route.fulfill({ json: { created: 2, skipped: [] } }); });
  await page.goto('/#/digikala/import');
  await page.locator('#di-read').click();
  await page.locator('[data-v="1"] [data-pick]').check();
  await page.locator('#di-next').click();
  await page.locator('[data-v="21"] [data-pick]').check();
  await page.locator('#di-bulk-multiplier').fill('۱٫۵');
  await page.locator('#di-bulk-apply').click();
  await expect(page.locator('[data-v="21"] [data-price]')).toContainText('۳۰۰٬۰۰۰');
  await page.locator('#di-save').click();
  await expect.poll(() => body?.rows?.length).toBe(2);
  expect(body.rows.every((r) => r.multiplier === 1.5)).toBe(true);
  expect(body.rows.map((r) => r.variant_id)).toEqual([1, 21]);
});

test('operations shows price reductions, reference tracking and order history on laptop and phone', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#shell')).toBeVisible();
  const now = new Date().toISOString();
  await page.route('**/api/digikala/operations**', (route) => route.fulfill({ json: {
    buybox: [{ listing_id: 1, code: '501', product_name: 'کابل مسی', current_price: 1200000, winning_price: 1150000, suggested_price: 1140000, formula_price: 1300000, is_winner: 0, checked_at: now }],
    reference: [{ id: 1, code: '502', product_name: 'انبر', target_price: 2000000, ticket_id: '9000', request_number: 'P-2627747', status: 'in_progress', updated_at: now }],
    orders: [{ remote_id: '1001', remote_status: 'جاری', order_id: 1, ordered_at: now, updated_at: now, history: [{ status: 'جاری', created_at: now }] }],
    sync: { checked_at: now }
  } }));
  let sent = false;
  await page.route('**/api/digikala/buybox/1/approve', async (route) => { sent = true; expect(route.request().postDataJSON().price).toBe(1140000); await route.fulfill({ json: { ok: true } }); });
  await page.goto('/#/digikala/operations');
  await expect(page.locator('#view h1')).toHaveText('پیگیری دیجی‌کالا');
  await expect(page.locator('#do-list')).toContainText('۱۰٬۰۰۰');
  const axe = await new AxeBuilder({ page }).include('#shell').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: `.local/operations-${testInfo.project.name}.png`, fullPage: true });
  await page.locator('[data-approve]').click();
  expect(sent).toBe(false);
  await page.locator('#confirm').getByRole('button', { name: 'تأیید و ارسال', exact: true }).click();
  await expect.poll(() => sent).toBe(true);
  await page.locator('[data-tab="reference"]').click();
  await expect(page.locator('#do-list')).toContainText('در حال بررسی');
  await expect(page.locator('#do-list')).toContainText('P-2627747');
  await page.locator('[data-tab="orders"]').click();
  await expect(page.locator('#do-list')).toContainText('ابتدا تاریخ');
  await page.locator('#do-range [data-days="0"]').click();
  await expect(page.locator('#do-list')).toContainText('1001');
  await page.locator('#do-list summary').click();
  await expect(page.locator('#do-list details[open]')).toContainText('جاری');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test('reference activity uses Persian labels and renders an error as an error', async ({ page }) => {
  await page.goto('/');
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#shell')).toBeVisible();
  await page.route('**/api/activity?*', (route) => route.fulfill({ json: { total: 1, page: 1, pages: 1, items: [{
    id: 1, entity: 'listing', action: 'digikala', entity_id: '1', user_name: 'مدیر', created_at: new Date().toISOString(),
    summary: 'پیگیری درخواست قیمت مرجع دیجی‌کالا: pending ← pending',
    changes: [{ field: 'error', label: 'خطا', from: null, to: 'درخواست ارسال نشده؛ زیردستهٔ تیکت را تنظیم کنید.' }]
  }] } }));
  await page.goto('/#/activity');
  await expect(page.locator('#a-list')).toContainText('در انتظار ارسال (بدون تغییر وضعیت)');
  await expect(page.locator('#a-list')).toContainText('آگهی · دیجی‌کالا');
  await expect(page.locator('#a-list')).not.toContainText('pending');
  await expect(page.locator('.change-error .to')).toHaveText('درخواست ارسال نشده؛ زیردستهٔ تیکت را تنظیم کنید.');
  await expect(page.locator('.change-error .to')).toHaveCSS('color', 'rgb(196, 50, 10)');
});

test('order list waits for an explicit date range and includes the entire final Tehran day', async ({ page }) => {
  await page.goto('/');
  await page.fill('#login-username', 'boss'); await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]'); await expect(page.locator('#shell')).toBeVisible();
  const requests = [];
  await page.route('**/api/orders?*', async (route) => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({ json: { items: [], total: 0, page: 1, pages: 1 } });
  });
  await page.goto('/#/orders?view=internal');
  await expect(page.locator('#o-range')).toContainText('انتخاب تاریخ');
  await expect(page.locator('#o-list')).toContainText('ابتدا تاریخ');
  expect(requests.length).toBe(0);
  await page.fill('#order-range-from', '۱۴۰۵/۰۸/۰۱');
  await page.fill('#order-range-to', '۱۴۰۵/۰۸/۰۲');
  await page.locator('#o-range button[type=submit]').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(Date.parse(requests[0].searchParams.get('to')) - Date.parse(requests[0].searchParams.get('from'))).toBe(2 * 86400000);
  expect(requests[0].searchParams.get('from')).toContain('20:30:00.000Z');
});

test('packaging review separates a unit price from a hundred-piece sale and confirms all listings', async ({ page }) => {
  await page.goto('/'); await page.fill('#login-username', 'boss'); await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]'); await expect(page.locator('#shell')).toBeVisible();
  await page.route('**/api/packaging/reviews', (route) => route.fulfill({ json: { items: [{
    id: 1, product_id: 10, name: 'بست کابل قیمت هر عدد', reason: 'مبنای قیمت تغییر کرده', version: 3,
    units_per_pack: 100, sale_pack_units: 100, regular_price: 10000,
    before: { name: 'بست کابل بسته ۱۰۰ عددی', regular_price: 1000000, price_units: 100 },
    after: { verified_pack: { price_units: 1, sale_units: 100, sizes: [100] } },
    listings: [{ id: 20, version: 5, units: 1, declared_units: 100, code: '501', platform_name: 'دیجی‌کالا' }]
  }] } }));
  let saved;
  await page.route('**/api/products/10/packaging', async (route) => { saved = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); });
  await page.goto('/#/digikala/packaging');
  await expect(page.locator('#view h1')).toHaveText('بررسی بسته‌بندی');
  await expect(page.locator('[data-price-units]')).toHaveValue('۱');
  await expect(page.locator('[data-sale-units]')).toHaveValue('۱۰۰');
  await expect(page.locator('[data-listing]')).toHaveValue('۱۰۰');
  await page.locator('[data-review] button[type=submit]').click();
  await expect.poll(() => saved?.price_units).toBe(1);
  expect(saved.sale_units).toBe(100);
  expect(saved.listings).toEqual([{ id: 20, version: 5, units: 100 }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
