import { test, expect } from '@playwright/test';
test('启动页、键盘操作与布局', async ({ page }, testInfo) => {
  await page.route('**/api/health/ready', (r) =>
    r.fulfill({ json: { status: 'ready' } }),
  );
  await page.goto('/health');
  await expect(page.getByRole('heading', { name: '开发基线' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('基础服务已就绪');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '重新检查' })).toBeFocused();
  await expect(page.getByRole('button', { name: '重新检查' })).toHaveCSS(
    'outline-color',
    'rgb(57, 100, 254)',
  );
  await expect(page.getByRole('button', { name: '重新检查' })).toHaveCSS(
    'outline-width',
    '2px',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('foundation.png'),
    fullPage: true,
  });
});
test('依赖失败可重试，404 可返回', async ({ page }) => {
  await page.route('**/api/health/ready', (r) =>
    r.fulfill({ status: 503, json: { status: 'unavailable' } }),
  );
  await page.goto('/health');
  await expect(page.getByRole('status')).toContainText('暂不可用');
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByRole('status')).toContainText('暂不可用');
  await page.goto('/missing');
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
  await page.getByRole('link', { name: '返回工作台' }).click();
  await expect(page).toHaveURL('/');
});
