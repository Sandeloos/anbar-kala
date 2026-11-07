// End-to-end checks in a real browser (laptop and phone), against tests/e2e-server.js.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

async function signIn(page, username = 'boss', password = 'boss-password-1') {
  await page.goto('/');
  await page.fill('#login-username', username);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#shell')).toBeVisible();
}
const laptopOnly = (testInfo) => test.skip(testInfo.project.name !== 'laptop', 'changes shared data; runs once');

test('wrong password is explained next to the field', async ({ page }) => {
  await page.goto('/');
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'not-the-password');
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#login-form .error')).toContainText('رمز عبور درست نیست');
  await expect(page.locator('#login-password')).toHaveAttribute('aria-invalid', 'true');
});

test('dashboard after sign-in, accessible, no horizontal scroll', async ({ page }) => {
  await signIn(page);
  await expect(page.locator('.metrics .metric').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'اتصال شرکت‌ها' })).toBeVisible();
  const axe = await new AxeBuilder({ page }).include('#shell').analyze();
  const serious = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);
  for (const route of ['products', 'changes', 'companies', 'companies/1', 'warehouses', 'activity', 'profile', 'users', 'settings']) {
    await page.goto(`/#/${route}`);
    await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal scroll on #/${route}`).toBeLessThanOrEqual(1);
  }
});

test('every glyph is drawn with the app font (no system fallback)', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/products');
  await expect(page.locator('.table tbody tr').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const ok = await page.evaluate(() => {
    const text = document.body.innerText;
    return document.fonts.check('16px Rubik', text.slice(0, 2000));
  });
  expect(ok).toBe(true);
  const family = await page.locator('body').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).toContain('Rubik');
});

test('search products and set units per pack inline (Enter moves on)', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/products');
  const rows = page.locator('.table tbody tr');
  await expect(rows.first()).toBeVisible();
  await page.fill('#p-q', 'لیوان');
  await expect(page.locator('.table tbody tr .cell-title a').first()).toContainText('لیوان');
  const first = rows.first();
  const input = first.locator('[data-pack]');
  await input.fill('۲۵');
  await input.press('Enter');
  await expect(rows.nth(1).locator('[data-pack]')).toBeFocused();
  await page.reload();
  await expect(page.locator('.table tbody tr').first().locator('[data-pack]')).toHaveValue('۲۵');
});

test('a price changed on the site shows up live on the product page', async ({ page, request }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await page.goto('/#/products?q=' + encodeURIComponent('قاشق'));
  await page.locator('.table tbody tr .cell-title a').first().click();
  await expect(page.locator('.price-hero .big')).toBeVisible();
  const wooId = await page.locator('.cell-meta .ltr').last().textContent();
  const id = Number(wooId.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  await request.post('http://127.0.0.1:4181/__mock/price', { data: { id, regular: 123400 } });
  await expect(page.locator('.price-hero .big')).toContainText('۱۲۳٬۴۰۰', { timeout: 10000 });
  await expect(page.locator('.table tbody tr').first()).toContainText('افزونه');
});

test('add a company in two steps; its products are read right away', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await page.goto('/#/companies/new');
  await page.fill('#c-site', 'http://127.0.0.1:4182');
  await page.fill('#c-key', 'ck_e2e_two_000000000002');
  await page.fill('#c-secret', 'wrong-secret-000000');
  await page.getByRole('button', { name: 'بررسی اتصال' }).click();
  await expect(page.locator('#c-result .callout-err')).toContainText('کلید یا رمز');
  await page.fill('#c-secret', 'cs_e2e_two_000000000002');
  await page.getByRole('button', { name: 'بررسی اتصال' }).click();
  await expect(page.locator('#c-result .callout-ok')).toContainText('کالا در سایت پیدا شد');
  await expect(page.locator('#c-unit')).toHaveValue('rial');
  await page.fill('#c-name', 'شرکت دوم');
  await page.getByRole('button', { name: 'ثبت شرکت و خواندن کالاها' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'شرکت دوم' })).toBeVisible();
  await expect(page.locator('.state-ok').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.metric').first()).not.toContainText(/^۰/);
});

test('a new admin signs in with a one-time password and must choose their own', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await page.goto('/#/users');
  await page.getByRole('button', { name: 'کاربر جدید' }).click();
  await page.fill('#u-name', 'سارا محمدی');
  await page.fill('#u-username', 'sara');
  await page.getByRole('button', { name: 'ساخت کاربر و رمز موقت' }).click();
  const temp = (await page.locator('.secret code').textContent()).trim();
  expect(temp).toHaveLength(10);
  await page.getByRole('button', { name: 'بستم' }).click();
  await page.locator('.side-foot [data-logout]').click();
  await page.locator('#confirm-yes').click();
  await signInRaw(page, 'sara', temp);
  await expect(page.locator('#first-password')).toBeVisible();
  await page.fill('#fp-current', temp);
  await page.fill('#fp-next', 'Tehran-Blue-77');
  await page.fill('#fp-repeat', 'Tehran-Blue-78');
  await page.click('#first-password-form button[type=submit]');
  await expect(page.locator('#first-password-form .error')).toContainText('یکی نیست');
  await page.fill('#fp-repeat', 'Tehran-Blue-77');
  await page.click('#first-password-form button[type=submit]');
  await expect(page.locator('.metrics')).toBeVisible();
  await expect(page.locator('#side-nav')).not.toContainText('کاربران');

  await page.goto('/#/activity');
  await expect(page.locator('.timeline')).toContainText('تغییر رمز عبور');
});

async function signInRaw(page, username, password) {
  await page.fill('#login-username', username);
  await page.fill('#login-password', password);
  await page.click('#login-form button[type=submit]');
}

test('quick search (Ctrl+K) jumps to a product', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await page.keyboard.press('Control+k');
  await expect(page.locator('#palette')).toBeVisible();
  await page.keyboard.type('دستکش');
  await expect(page.locator('#palette-list [role="option"]').first()).toContainText('دستکش');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/products\/\d+/);
  await expect(page.locator('h1').filter({ hasText: 'دستکش' })).toBeVisible();
});
