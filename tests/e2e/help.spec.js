// In-app training: the first-visit card, the guide sheet and the training page.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

async function signIn(page) {
  await page.goto('/');
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#shell')).toBeVisible();
}

test('the first visit shows a card; after "understood" a small button stays', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/receiving');
  const card = page.locator('.help-tip');
  await expect(card).toContainText('دریافت روزانه');
  await card.getByRole('button', { name: 'فهمیدم' }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#shell')).toBeVisible();
  await expect(page.locator('.help-tip')).toHaveCount(0);
  await page.getByRole('button', { name: 'آموزش این بخش' }).click();
  await expect(page.locator('#sheet-title')).toHaveText('آموزش: دریافت روزانه');
  await expect(page.locator('#sheet-body .howto li').first()).toBeVisible();
});

test('every section in the menu and its sub-pages have a guide', async ({ page }) => {
  await signIn(page);
  const links = await page.locator('#side-nav .nav-item').evaluateAll((els) => els.map((a) => a.getAttribute('href')));
  expect(links).toContain('#/guide');
  const routes = [...links.filter((h) => h !== '#/guide'), '#/orders/new', '#/orders/import', '#/companies/new', '#/companies/1', '#/count', '#/profile'];
  for (const href of routes) {
    await page.goto(`/${href}`);
    await expect(page.locator('#view')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#view > .help-tip, #view > .help-link'), href).toHaveCount(1);
  }
});

test('the training page opens guides, restores cards, is accessible and fits', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/guide');
  await expect(page.getByRole('heading', { name: 'آموزش', exact: true })).toBeVisible();
  await page.locator('[data-guide="statements/*"]').click();
  await expect(page.locator('#sheet-title')).toHaveText('آموزش: صورت‌حساب یک ماه');
  const sheet = await new AxeBuilder({ page }).include('#sheet').analyze();
  expect(sheet.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([]);
  await page.locator('[data-close-sheet]').click();

  const axe = await new AxeBuilder({ page }).include('#shell').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.goto('/#/stock');
  await page.locator('.help-tip').getByRole('button', { name: 'فهمیدم' }).click();
  await page.goto('/#/guide');
  await page.getByRole('button', { name: 'نمایش دوباره‌ی کارت‌های آموزش' }).click();
  await page.goto('/#/stock');
  await expect(page.locator('.help-tip')).toBeVisible();
});
