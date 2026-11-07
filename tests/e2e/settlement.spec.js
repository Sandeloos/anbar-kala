// Phase 3 in a real browser: returns, monthly statement (issue, Excel, paid) and stocktake.
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

/** An order placed through the API and received as "all right"; returns the order detail. */
async function receivedOrder(page, number, orderedAt, query = 'کیسه') {
  const pick = await (await page.request.get(`/api/pick?q=${encodeURIComponent(query)}&products_only=1`)).json();
  const it = pick.items.find((x) => x.company_name === 'شرکت آزمایشی');
  const r = await page.request.post('/api/orders', { headers: H, data: { platform_id: 1, order_number: number, ordered_at: orderedAt, lines: [{ product_id: it.product_id, qty: 1 }] } });
  expect(r.status(), await r.text()).toBe(200);
  const order = await r.json();
  const ok = await page.request.post(`/api/order-lines/${order.lines[0].id}/receive`, { headers: H, data: { outcome: 'ok' } });
  expect(ok.status()).toBe(200);
  return order;
}

test('a customer return: record it from the order number, then send it back to the company', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await receivedOrder(page, '660001', new Date().toISOString());
  await page.goto('/#/returns');
  await page.getByRole('button', { name: 'ثبت مرجوعی' }).click();
  await page.fill('#ret-order', '660001');
  await page.locator('#ret-lines input[name=line]').first().check();
  await expect(page.locator('#ret-hint')).toContainText('حداکثر');
  await page.fill('#ret-reason', 'مشتری منصرف شد');
  await page.click('#f-ret button[type=submit]');
  const row = page.locator('#rt-list tbody tr', { hasText: 'مشتری منصرف شد' });
  await expect(row).toBeVisible();
  await row.locator('[data-decide="to_company"]').click();
  await page.click('#confirm-yes');
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'تعیین تکلیف‌شده' }).click();
  await expect(page.locator('#rt-list')).toContainText('برگشت به شرکت');
  await expect(page.locator('#rt-list')).toContainText('کسر');
});

test('last month: issue the statement, download Excel, record the payment', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  // An order in the middle of last month (Jalali), received
  const overview = await (await page.request.get('/api/statements/overview')).json();
  const company = overview.companies.find((c) => c.name === 'شرکت آزمایشی');
  const lastMonthMid = new Date(Date.now() - 35 * 864e5).toISOString();
  await receivedOrder(page, '650001', lastMonthMid);
  const month = (await (await page.request.get(`/api/statements/month?company=${company.id}&month=${company.last_month}`)).json()).sections.sales.length ? company.last_month : null;
  test.skip(!month, 'the order fell in another month');
  await page.goto('/#/statements');
  await page.locator('.company-card', { hasText: 'شرکت آزمایشی' }).locator('.month-tile').first().click();
  await expect(page.locator('#view h1')).toContainText('صورت‌حساب');
  await expect(page.locator('.statement-section').first()).toContainText('650001'.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]));

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'دانلود اکسل' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);

  await page.getByRole('button', { name: 'صدور صورت‌حساب' }).click();
  await page.click('#confirm-yes');
  await expect(page.locator('.title-row .badge')).toContainText('صادرشده');
  await page.getByRole('button', { name: 'ثبت تسویه' }).click();
  await page.fill('#pd-ref', 'فیش ۴۴۵۵');
  await page.click('#f-paid button[type=submit]');
  await expect(page.locator('.title-row .badge')).toContainText('تسویه‌شده');
  await expect(page.locator('.page-head p')).toContainText('فیش ۴۴۵۵');
});

test('stocktake: count a row, the difference becomes a correction', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  const pick = await (await page.request.get(`/api/pick?q=${encodeURIComponent('نی')}&products_only=1`)).json();
  const it = pick.items[0];
  expect((await page.request.post('/api/stock/own-in', { headers: H, data: { product_id: it.product_id, warehouse_id: 2, units: 30 } })).status()).toBe(200);
  await page.goto('/#/count?warehouse=2');
  const row = page.locator('#ct-list tbody tr').first();
  await expect(row).toContainText('۳۰');
  await row.locator('[data-count]').fill('۲۷');
  await row.locator('[data-count]').press('Enter');
  await expect(page.locator('#ct-list tbody tr').first()).toContainText('−۳');
  await page.getByRole('button', { name: 'ثبت انبارگردانی' }).click();
  await page.click('#confirm-yes');
  await expect(page.locator('.toast', { hasText: '۱ ردیف اصلاح شد' })).toBeVisible();
  await expect(page.locator('#ct-list tbody tr').first()).toContainText('۲۷');
});

test('phase 3 pages: no serious accessibility problems, no sideways scroll', async ({ page }) => {
  const AxeBuilder = require('@axe-core/playwright').default;
  await signIn(page);
  const overview = await (await page.request.get('/api/statements/overview')).json();
  const c = overview.companies[0];
  for (const route of ['statements', `statements/${c.id}/${c.this_month}`, 'returns', 'count']) {
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
