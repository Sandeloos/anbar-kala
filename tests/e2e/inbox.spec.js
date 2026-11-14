// Phase 4 in a real browser: the inbox fills live when a company site changes a price; backups;
// a stale edit is refused.
const { test, expect } = require('@playwright/test');

async function signIn(page) {
  await page.goto('/');
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#shell')).toBeVisible();
}
const laptopOnly = (testInfo) => test.skip(testInfo.project.name !== 'laptop', 'changes shared data; runs once');
const H = { 'x-anbar': '1' };

test('a price change on the company site shows up in the inbox live; done records our new Digikala price', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  const pick = await (await page.request.get(`/api/pick?q=${encodeURIComponent('جعبه')}&products_only=1`)).json();
  const it = pick.items.find((x) => x.company_name === 'شرکت آزمایشی');
  const product = await (await page.request.get(`/api/products/${it.product_id}`)).json();
  const li = await page.request.post('/api/listings', { headers: H, data: { platform_id: 1, product_id: it.product_id, code: 'DK-INBOX', units: it.units_per_pack, platform_price: '900000' } });
  expect(li.status(), await li.text()).toBe(200);

  await page.goto('/#/inbox');
  await expect(page.locator('#ib-list')).toBeVisible();
  // The fake shop changes the price and pushes it like the WordPress plugin
  const newPrice = Math.round(product.product.regular_price / 10 * 1.2 / 100) * 100;
  await page.request.post('http://127.0.0.1:4181/__mock/price', { data: { id: product.product.woo_id, regular: newPrice } });
  const card = page.locator('.task', { hasText: 'DK-INBOX' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card).toContainText('پیشنهاد');
  await card.getByRole('button', { name: 'انجام شد' }).click();
  await expect(page.locator('#dn-price')).not.toHaveValue('');
  await page.fill('#dn-price', '۱٬۰۸۰٬۰۰۰');
  await page.click('#f-done button[type=submit]');
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'بسته‌شده' }).click();
  await expect(page.locator('.task', { hasText: 'DK-INBOX' })).toContainText('۱٬۰۸۰٬۰۰۰');
});

test('settings: take a backup now and see it in the list', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'پشتیبان‌گیری همین الان' }).click();
  await page.click('#confirm-yes');
  await expect(page.locator('#backups .list-item').first()).toContainText('anbar-');
});

test('two people edit the same record: the later save is refused and nothing is overwritten', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await page.goto('/#/warehouses');
  const w = (await (await page.request.get('/api/warehouses')).json()).items[0];
  await page.locator(`[data-edit="${w.id}"]`).click();
  await page.fill('#w-notes', 'یادداشت من');
  // Meanwhile someone else saves the same warehouse
  const other = await page.request.put(`/api/warehouses/${w.id}`, { headers: H, data: { name: w.name, notes: 'یادداشت همکار', active: true } });
  expect(other.status()).toBe(200);
  await page.click('#f-wh button[type=submit]');
  await expect(page.locator('#f-wh')).toContainText('در این فاصله');
  const now = (await (await page.request.get('/api/warehouses')).json()).items.find((x) => x.id === w.id);
  expect(now.notes).toBe('یادداشت همکار');
});

test('phase 4 pages: no serious accessibility problems, no sideways scroll', async ({ page }) => {
  const AxeBuilder = require('@axe-core/playwright').default;
  await signIn(page);
  for (const route of ['inbox', 'inbox?status=closed', 'settings', 'dashboard', 'digikala', 'digikala/import']) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal scroll on #/${route}`).toBeLessThanOrEqual(1);
    const axe = await new AxeBuilder({ page }).include('#view').analyze();
    const serious = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    expect(serious.map((v) => `${route} ${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);
  }
});
