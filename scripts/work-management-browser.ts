import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';

// Exercises the production build against the isolated HTTP regression database.
// Identity is the test collaboration server; all Tandem business requests are real.
export async function workManagementBrowser(
  base: string,
  account: string,
  password: string,
) {
  const browser = await chromium.launch({ channel: 'chromium' });
  const root = resolve('.impeccable/review');
  await mkdir(root, { recursive: true });
  const checks: string[] = [];
  const errors: string[] = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  async function nav(label: string) {
    const toggle = page.getByRole('button', { name: '展开导航' });
    if (await toggle.isVisible()) await toggle.click();
    await page
      .getByRole('navigation', { name: '主要导航' })
      .getByRole('link', { name: label, exact: true })
      .click();
  }
  async function save(page: Page, title: string) {
    const panel = page.getByRole('dialog', { name: title, exact: true });
    await panel.getByRole('button', { name: '保存', exact: true }).click();
    await expect(panel).not.toBeVisible();
  }
  try {
    await page.goto(base);
    await page.getByLabel('协作账号', { exact: true }).fill(account);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '项目', level: 1, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '新建空间', exact: true }).click();
    const workspace = page.getByRole('dialog', {
      name: '创建工作空间',
      exact: true,
    });
    await workspace
      .getByLabel('工作空间名称', { exact: true })
      .fill('产品业务验收空间');
    await workspace
      .getByRole('button', { name: '创建工作空间', exact: true })
      .click();
    await expect(workspace).not.toBeVisible();
    await expect(
      page.getByText('创建你的第一个项目', { exact: true }),
    ).toBeVisible();
    checks.push('真实账号登录与独立空间初始化');
    await page.getByRole('button', { name: '新建分组', exact: true }).click();
    let panel = page.getByRole('dialog', { name: '新建项目分组', exact: true });
    await panel
      .getByRole('textbox', { name: '分组名称', exact: true })
      .fill('企业应用');
    await save(page, '新建项目分组');
    await page.getByRole('button', { name: '新建分组', exact: true }).click();
    panel = page.getByRole('dialog', { name: '新建项目分组', exact: true });
    await panel
      .getByRole('textbox', { name: '分组名称', exact: true })
      .fill('临时分组');
    await save(page, '新建项目分组');
    await page
      .getByRole('button', { name: '编辑分组 临时分组', exact: true })
      .click();
    panel = page.getByRole('dialog', { name: '编辑项目分组', exact: true });
    await panel.getByRole('button', { name: '删除', exact: true }).click();
    await page
      .locator('.ant-modal-confirm')
      .getByRole('button', { name: '删除', exact: true })
      .click();
    await expect(panel).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: '临时分组', exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: '企业应用', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '企业应用', exact: true }).click();
    await page.getByRole('button', { name: '新建分组', exact: true }).click();
    panel = page.getByRole('dialog', { name: '新建项目分组', exact: true });
    await panel
      .getByRole('textbox', { name: '分组名称', exact: true })
      .fill('交付项目');
    await save(page, '新建项目分组');
    await page
      .getByRole('button', { name: '收起分组 企业应用', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '交付项目', exact: true }),
    ).not.toBeVisible();
    await page
      .getByRole('button', { name: '展开分组 企业应用', exact: true })
      .click();
    await page.getByRole('button', { name: '交付项目', exact: true }).click();
    await page
      .getByRole('button', { name: '新建项目', exact: true })
      .first()
      .click();
    panel = page.getByRole('dialog', { name: '新建项目', exact: true });
    await panel
      .getByRole('textbox', { name: '项目名称', exact: true })
      .fill('客户服务平台');
    await panel
      .getByLabel('项目简介', { exact: true })
      .fill('用于隔离数据库验收的项目。');
    await panel.getByLabel('立项日期', { exact: true }).fill('2026-11-09');
    await panel.getByLabel('上线日期', { exact: true }).fill('2026-12-01');
    await panel.getByLabel('计划人天', { exact: true }).fill('60');
    await panel.getByLabel('计划完工额', { exact: true }).fill('120000');
    await save(page, '新建项目');
    await expect(
      page.getByRole('button', { name: /客户服务平台/ }),
    ).toBeVisible();
    checks.push('项目分组、完整立项信息持久化');
    await page.getByRole('button', { name: /客户服务平台/ }).click();
    panel = page.getByRole('dialog', { name: '客户服务平台', exact: true });
    await panel.getByRole('tab', { name: '项目模块', exact: true }).click();
    await panel.getByRole('button', { name: '新建模块', exact: true }).click();
    await page
      .getByRole('dialog', { name: '维护项目模块', exact: true })
      .getByRole('textbox', { name: '模块名称', exact: true })
      .fill('账号与权限');
    await save(page, '维护项目模块');
    await expect(
      panel.getByRole('cell', { name: '账号与权限', exact: true }),
    ).toBeVisible();
    await panel.getByRole('tab', { name: '项目概要', exact: true }).click();
    await page.screenshot({
      path: resolve(root, 'work-project-detail-desktop.png'),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    checks.push('项目详情与模块维护');
    await nav('任务');
    await page
      .getByRole('button', { name: '新建任务', exact: true })
      .first()
      .click();
    panel = page.getByRole('dialog', { name: '新建任务', exact: true });
    await panel
      .getByRole('textbox', { name: '任务名称', exact: true })
      .fill('完成登录流程');
    await panel
      .getByLabel('任务描述', { exact: true })
      .fill('包含输入校验与失败恢复。');
    await panel.getByLabel('执行人', { exact: true }).click();
    await page
      .locator('.ant-select-dropdown:visible')
      .getByText('张三', { exact: true })
      .click();
    await panel.getByLabel('所属模块', { exact: true }).click();
    await page
      .locator('.ant-select-dropdown:visible')
      .getByText('账号与权限', { exact: true })
      .click();
    await panel.getByLabel('计划开始日期', { exact: true }).fill('2026-11-09');
    await panel.getByLabel('计划结束日期', { exact: true }).fill('2026-11-13');
    await panel.getByLabel('计划工时', { exact: true }).fill('20');
    await save(page, '新建任务');
    await expect(
      page.getByRole('button', { name: '完成登录流程', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.work-table-caption')).toHaveCSS(
      'display',
      'block',
    );
    await page
      .getByRole('button', { name: '完成登录流程', exact: true })
      .click();
    panel = page.getByRole('dialog', { name: '完成登录流程', exact: true });
    await panel
      .getByRole('textbox', { name: '任务备注', exact: true })
      .fill('已明确验收范围。');
    await panel.getByRole('button', { name: '添加备注', exact: true }).click();
    await expect(
      panel.getByText('已明确验收范围。', { exact: true }),
    ).toBeVisible();
    await panel.locator('input[type=file]').setInputFiles({
      name: '验收说明.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Tandem attachment acceptance', 'utf8'),
    });
    const download = panel.getByRole('link', {
      name: '验收说明.txt',
      exact: true,
    });
    await expect(download).toBeVisible();
    const response = await context.request.get(
      new URL((await download.getAttribute('href')) ?? '', base).href,
    );
    assert.equal(response.status(), 200);
    assert.equal(await response.text(), 'Tandem attachment acceptance');
    await expect(
      panel.getByText('添加了附件「验收说明.txt」', { exact: true }),
    ).toBeVisible();
    await panel.getByRole('button', { name: '移除', exact: true }).click();
    await expect(download).not.toBeVisible();
    await expect(
      panel.getByText('移除了附件「验收说明.txt」', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(root, 'work-task-detail-desktop.png'),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    checks.push('任务创建、时间轴备注、真实附件上传下载移除与不可变历史');
    await page
      .getByRole('button', { name: '批量填报工时', exact: true })
      .click();
    panel = page.getByRole('dialog', { name: '批量填报工时', exact: true });
    await panel.getByLabel('项目 / 任务', { exact: true }).click();
    await page
      .locator('.ant-select-dropdown:visible')
      .getByText('客户服务平台 / 完成登录流程', { exact: true })
      .click();
    await panel.getByLabel('工作日期', { exact: true }).fill('2026-11-09');
    await panel.getByLabel('工时 h', { exact: true }).fill('3');
    await panel.getByLabel('工作说明', { exact: true }).fill('完成输入校验');
    await panel.getByRole('button', { name: '保存工时', exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect(
      page.getByRole('cell', { name: '20 h / 3 h', exact: true }),
    ).toBeVisible();
    checks.push('工时填报和实际工时汇总');
    await nav('文档');
    await page.getByRole('button', { name: /新建文档$/ }).click();
    panel = page.getByRole('dialog', { name: '新建文档', exact: true });
    await panel
      .getByRole('textbox', { name: '文档标题', exact: true })
      .fill('项目实施方案');
    await panel
      .getByRole('textbox', { name: '文档正文', exact: true })
      .fill(
        '# 实施方案\n\n- 确认目标\n- 完成开发\n\n<script>window.tandemXss=true</script>',
      );
    await save(page, '新建文档');
    await expect(
      page.getByRole('heading', { name: '项目实施方案', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.markdown-content h1')).toHaveText('实施方案');
    assert.equal(
      await page.evaluate(() => Reflect.get(window, 'tandemXss')),
      undefined,
    );
    await page.screenshot({
      path: resolve(root, 'work-document-desktop.png'),
      fullPage: true,
    });
    checks.push('Markdown编辑、保存与安全渲染');
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '项目实施方案', exact: true }),
    ).toBeVisible();
    checks.push('浏览器刷新后业务数据保持');
    await nav('分析');
    await page.getByLabel('分析开始日期', { exact: true }).fill('2026-11-09');
    await page.getByLabel('分析结束日期', { exact: true }).fill('2026-11-15');
    await expect(page.getByLabel('计划4小时').first()).toBeVisible();
    await expect(page.getByLabel('实际3小时').first()).toBeVisible();
    await page.screenshot({
      path: resolve(root, 'work-analysis-desktop.png'),
      fullPage: true,
    });
    checks.push('资源时间轴计划分摊与实际登记');
    await nav('项目');
    await page.screenshot({
      path: resolve(root, 'work-projects-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: '展开导航' })).toBeVisible();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: resolve(root, 'work-projects-mobile.png'),
      fullPage: true,
    });
    await nav('分析');
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: resolve(root, 'work-analysis-mobile.png'),
      fullPage: true,
    });
    checks.push('桌面与390px窄屏导航和局部滚动');
    assert.deepEqual(errors, [], '浏览器不能出现运行错误');
    await writeFile(
      resolve(root, 'work-management-browser.json'),
      JSON.stringify(
        {
          source:
            'Production HTTP + isolated PostgreSQL; external identity fixture only',
          checks,
          errors,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `产品浏览器回归通过：${checks.length}项真实业务检查，桌面与390px。`,
    );
  } catch (error) {
    await page.screenshot({
      path: resolve(root, 'work-management-failure.png'),
      fullPage: true,
    });
    throw error;
  } finally {
    await browser.close();
  }
}
