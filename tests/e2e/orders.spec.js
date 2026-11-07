// Phase 2 in a real browser: order entry, daily receiving, stock and Excel import.
const { test, expect } = require('@playwright/test');

async function signIn(page) {
  await page.goto('/');
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'boss-password-1');
  await page.click('#login-form button[type=submit]');
  await expect(page.locator('#shell')).toBeVisible();
}
const laptopOnly = (testInfo) => test.skip(testInfo.project.name !== 'laptop', 'changes shared data; runs once');
const faDigits = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

test('enter an order with the keyboard; the live site price and the amount show up', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await page.goto('/#/orders/new');
  await expect(page.locator('#o-number')).toBeFocused();
  await page.fill('#o-number', '700100');
  await page.click('[data-now]');
  await page.fill('#o-pick', 'قاشق');
  await expect(page.locator('.picker-list [role="option"]').first()).toBeVisible();
  await page.keyboard.press('Enter');
  const line = page.locator('.order-line').first();
  await expect(line).toBeVisible();
  await expect(line.locator('.ol-price').first()).toContainText('تومان', { timeout: 10000 });
  await expect(line).toContainText('همین الان از سایت خوانده شد');
  await line.locator('[data-f="qty"]').fill('۲');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.toast', { hasText: 'ثبت شد' }).first()).toBeVisible();
  await expect(page.locator('#o-number')).toHaveValue('');

  // The same number again is refused with a link to the existing order
  await page.fill('#o-number', '700100');
  await page.click('[data-now]');
  await page.fill('#o-pick', 'قاشق');
  await expect(page.locator('.picker-list [role="option"]').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.order-line .ol-price').first()).toContainText('تومان', { timeout: 10000 });
  await page.click('#o-save');
  await expect(page.locator('#o-number').locator('xpath=..').locator('.error')).toContainText('تکراری');
  await page.locator('text=دیدن سفارش ثبت‌شده').click();
  await expect(page.locator('#view h1')).toContainText(faDigits('700100'));
  await expect(page.locator('.table tbody tr').first()).toContainText('منتظر دریافت');
});

test('daily receiving: one right, one too many into stock, then undo', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  // Two orders of today to receive (through the API, so this test stands alone)
  const pick = await (await page.request.get('/api/pick?q=' + encodeURIComponent('لیوان') + '&products_only=1')).json();
  for (const [i, it] of pick.items.slice(0, 2).entries()) {
    const r = await page.request.post('/api/orders', { headers: { 'x-anbar': '1' },
      data: { platform_id: 1, order_number: `RCV-${i}`, ordered_at: new Date().toISOString(), lines: [{ product_id: it.product_id, qty: 1 }] } });
    expect(r.status()).toBe(200);
  }
  await page.goto('/#/receiving?scope=all');
  const rows = page.locator('#r-list tbody tr[data-id]');
  await expect(rows.first()).toBeVisible();
  const receivingUrl = page.url(); // the page picked a company and put it in the address
  const first = rows.filter({ has: page.locator('[data-ok]') }).first();
  const name = await first.locator('.cell-title a').first().textContent();
  await first.locator('[data-ok]').click();
  await expect(page.locator('#r-list')).toContainText('دریافت‌شده‌های امروز');
  const done = page.locator('#r-list tbody tr[data-id]', { hasText: name }).filter({ has: page.locator('[data-undo]') }).first();
  await expect(done).toContainText('درست رسید');

  // Too many arrived: the rest goes into our warehouse, still the company's
  const next = rows.filter({ has: page.locator('[data-problem]') }).first();
  const need = Number((await next.locator('td[data-label="باید برسد"] b').textContent()).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  await next.locator('[data-problem]').click();
  await page.check('input[name=outcome][value=excess]');
  await page.fill('#x-units', String(need + 30));
  await expect(page.locator('#x-preview')).toContainText(`${faDigits(30)} عدد به انبار`);
  await page.click('#f-prob button[type=submit]');
  await expect(page.locator('.toast', { hasText: 'ثبت شد' }).first()).toBeVisible();
  await page.goto('/#/stock');
  await expect(page.locator('#s-list')).toContainText('مال شرکت آزمایشی');
  await expect(page.locator('#s-list')).toContainText(faDigits(30));

  // Undo puts the line back and takes the surplus out again
  await page.goto(receivingUrl);
  const excessRow = page.locator('#r-list tbody tr[data-id]').filter({ hasText: 'اضافه رسید' }).first();
  await expect(excessRow).toBeVisible();
  await excessRow.locator('[data-undo]').click();
  await page.click('#confirm-yes');
  await expect(page.locator('.toast', { hasText: 'به حالت انتظار برگشت' })).toBeVisible();
  await page.goto('/#/stock');
  await expect(page.locator('#s-list')).not.toContainText('مال شرکت آزمایشی');
});

test('stock: our own goods in, then a correction with a reason', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  await page.goto('/#/stock');
  await page.getByRole('button', { name: 'ورود کالای خودمان' }).click();
  await page.fill('#own-pick', 'دستکش');
  await expect(page.locator('.picker-list [role="option"]').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await page.fill('#own-units', '۴۰');
  await page.click('#f-own button[type=submit]');
  await expect(page.locator('#s-list')).toContainText('خودمان');
  const row = page.locator('#s-list tbody tr', { hasText: 'خودمان' }).first();
  await row.locator('[data-op="adjust"]').click();
  await page.fill('#op-count', '۳۸');
  await expect(page.locator('#op-diff')).toContainText('کم شدن ۲ عدد');
  await page.click('#f-op button[type=submit]');
  await expect(page.locator('#f-op .error')).toContainText('دلیل');
  await page.fill('#op-note', 'دو عدد پاره بود');
  await page.click('#f-op button[type=submit]');
  await expect(page.locator('#s-list tbody tr', { hasText: 'خودمان' }).first()).toContainText('۳۸');
});

test('import a Digikala CSV: map columns, link an unknown code, import', async ({ page }, testInfo) => {
  laptopOnly(testInfo);
  await signIn(page);
  const now = new Date(Date.now() + 60e3);
  const parts = new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const [y, m, d] = ['year', 'month', 'day'].map((t) => parts.find((p) => p.type === t).value);
  const time = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });
  const csv = ['کد سفارش,تاریخ ثبت سفارش,ساعت,کد تنوع,عنوان تنوع,تعداد,قیمت فروش',
    `880001,${y}/${m}/${d},${time},DKPC-E2E,دستکش آزمایشی,3,"450,000"`].join('\n');
  await page.goto('/#/orders/import');
  await page.setInputFiles('#im-file', { name: 'digikala.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('#im-file-status')).toContainText('۱ ردیف خوانده شد');
  await expect(page.locator('#m-code')).toHaveValue('3');
  await page.click('[data-preview]');
  await expect(page.locator('#s-preview')).toContainText('کدهای ناشناخته');
  await page.fill('[data-upick="0"]', 'دستکش');
  await expect(page.locator('.picker-list [role="option"]').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-units="0"]')).toBeFocused();
  await expect(page.locator('[data-commit]')).toContainText('ثبت ۱ ردیف');
  await page.click('[data-commit]');
  await expect(page.locator('#s-preview')).toContainText('۱ سفارش و ۱ قلم ثبت شد');
  await page.goto('/#/orders?q=880001');
  await expect(page.locator('#o-list tbody tr')).toHaveCount(1);
});

test('phase 2 pages have no serious accessibility problems and no sideways scroll', async ({ page }) => {
  const AxeBuilder = require('@axe-core/playwright').default;
  await signIn(page);
  for (const route of ['orders', 'orders/new', 'receiving?scope=all', 'stock', 'listings', 'orders/import']) {
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
