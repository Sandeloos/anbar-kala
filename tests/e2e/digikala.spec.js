const { test, expect } = require('@playwright/test');

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
  expect(body.rows).toEqual([{ variant_id: 1, product_id: 10, units: 2, multiplier: 1.5 }]);
  await expect(second.locator('[data-units]')).toHaveValue('۳');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
