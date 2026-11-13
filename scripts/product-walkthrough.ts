import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect, type Locator } from '@playwright/test';
import {
  ZentaoIdentityProvider,
  ZentaoProjectSystem,
} from '../adapters/zentao/src/index.js';
import { startLocalMcpFixture } from './local-mcp-fixture.js';

// Real product UI only. No route mocks, synthetic sessions, or direct product commands.
// Local external-system reads below independently verify the worker's actual writes.
const base = 'http://127.0.0.1:3000';
const navigationMode = process.argv.includes('--forms-navigation-only');
const formsMode = process.argv.includes('--forms-only') || navigationMode;
const upstreamUrl = new URL(process.env.TANDEM_IDENTITY_URL ?? '');
assert(
  ['localhost', '127.0.0.1'].includes(upstreamUrl.hostname),
  'Local acceptance only',
);
assert(
  process.env.ZT_ACC && process.env.ZT_PWD,
  'Use ignored .env.zentao.local',
);
const account = process.env.ZT_ACC;
const password = process.env.ZT_PWD;
const runKey =
  'walkthrough-' + new Date().toISOString().replace(/\D/g, '').slice(0, 17);
const workspaceId =
  process.env.TANDEM_ACCEPTANCE_WORKSPACE_ID ??
  '55250568-2570-44cf-8cfd-81eef409f249';
const seed = JSON.parse(
  await readFile('data/acceptance/project.json', 'utf8'),
) as { projectId: string };
const directory = resolve('data/acceptance');
const screenshotDirectory = resolve('.impeccable/review');
await mkdir(directory, { recursive: true });
await mkdir(screenshotDirectory, { recursive: true });
const report = {
  runKey,
  startedAt: new Date().toISOString(),
  completedAt: '',
  source: 'Actual local Tandem pages, HTTP, PostgreSQL worker and local ZenTao',
  workspaceId,
  externalProjectId: seed.projectId,
  taskId: '',
  checks: [] as {
    name: string;
    status: 'passed' | 'failed' | 'pending';
    detail: unknown;
  }[],
  screenshots: [] as string[],
  browserErrors: [] as string[],
  networkFailures: [] as { resource: string; status: number }[],
  independentTaskEvidence: null as unknown,
  navigationEvidence: [] as unknown[],
};
if (formsMode && process.argv.includes('--forms-mobile-only')) {
  const firstAttempt = JSON.parse(
    await readFile(resolve(directory, 'forms-report.json'), 'utf8'),
  ) as typeof report;
  await writeFile(
    resolve(directory, 'forms-first-attempt.json'),
    JSON.stringify(firstAttempt, null, 2) + '\n',
  );
  report.checks.push(
    ...firstAttempt.checks.filter(
      (item) => item.name.startsWith('desktop/') && item.status === 'passed',
    ),
  );
  report.screenshots.push(
    ...firstAttempt.screenshots.filter((path) =>
      path.includes('forms-desktop-'),
    ),
  );
}
const fixture = await startLocalMcpFixture();
const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  locale: 'zh-CN',
});
const page = await context.newPage();
let boundProjectId = '';
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => report.browserErrors.push(error.message));
page.on('response', (response) => {
  if (response.status() >= 500 && response.url().startsWith(base))
    report.networkFailures.push({
      resource:
        new URL(response.url()).searchParams.get('resource') ??
        new URL(response.url()).pathname,
      status: response.status(),
    });
});

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(password!, '[redacted]')
    .replaceAll(account!, '[account]');
}
async function saveReport() {
  await writeFile(
    resolve(
      directory,
      navigationMode
        ? 'forms-navigation-report.json'
        : formsMode
          ? 'forms-report.json'
          : 'walkthrough-report.json',
    ),
    JSON.stringify(report, null, 2) + '\n',
  );
}
async function check(name: string, action: () => Promise<unknown>) {
  try {
    const detail = await action();
    report.checks.push({
      name,
      status: 'passed',
      detail: detail ?? 'Actual UI operation and assertions passed',
    });
    console.log(JSON.stringify({ check: name, status: 'passed' }));
    return true;
  } catch (error) {
    const detail = safeError(error);
    report.checks.push({ name, status: 'failed', detail });
    console.log(JSON.stringify({ check: name, status: 'failed', detail }));
    return false;
  } finally {
    await saveReport();
  }
}
async function command(
  name: string,
  action: () => Promise<unknown>,
  expectedStatus = 200,
) {
  const responsePromise = page.waitForResponse((r) => {
    if (
      !r.url().startsWith(base) ||
      r.request().method() !== 'POST' ||
      !r.url().includes('/product?')
    )
      return false;
    try {
      return r.request().postDataJSON().command === name;
    } catch {
      return false;
    }
  });
  const [response] = await Promise.all([responsePromise, action()]);
  const value = await response.json();
  assert.equal(
    response.status(),
    expectedStatus,
    `${name}: ${JSON.stringify(value)}`,
  );
  return value;
}
async function navigate(view: string) {
  await page.goto(`${base}/?view=${view}&workspace=${workspaceId}`);
  await expect(page.locator('#project-scope')).toBeVisible();
  await page.waitForLoadState('networkidle');
  if (
    boundProjectId &&
    (await page.locator('#project-scope').inputValue()) !== boundProjectId
  ) {
    await page.locator('#project-scope').selectOption(boundProjectId);
    await page.waitForLoadState('networkidle');
  }
  await expect(page.locator('.loading-rows')).toHaveCount(0, {
    timeout: 30000,
  });
}
function section(title: string) {
  return page
    .locator('section.content-panel')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}
function draft(title: string) {
  return page
    .locator('.draft-list > li')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    .filter({ hasText: runKey });
}
async function approve(title: string, version = 1) {
  const row = draft(title);
  await expect(row).toContainText('待审阅');
  await command('review-draft', () =>
    row
      .getByRole('button', { name: `批准版本 ${version}`, exact: true })
      .click(),
  );
  await expect(row).toContainText('执行成功', { timeout: 75000 });
  return (await row.innerText()).slice(-1000);
}
async function screenshot(name: string) {
  if (name.endsWith('-modal') || name.endsWith('-drawer'))
    await expect(page.getByRole('dialog').last()).toBeVisible();
  const file = resolve(screenshotDirectory, `product-${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  report.screenshots.push(file);
}
async function closeDrawer() {
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: /^(Close|关闭)$/ }).click();
  await expect(drawer).toHaveCount(0);
}
async function openTask() {
  await navigate('tasks');
  const button = page.getByRole('button', {
    name: new RegExp(`^#${report.taskId} `),
  });
  await expect(button).toBeVisible({ timeout: 20000 });
  await button.click();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: '编辑任务草案', exact: true }),
  ).toBeVisible();
}

async function runFormsFix() {
  const previous = JSON.parse(
    await readFile(resolve(directory, 'walkthrough-report.json'), 'utf8'),
  ) as { taskId: string };
  report.taskId = previous.taskId;
  assert(report.taskId, 'The existing real acceptance task is required');
  const confirmation = () =>
    page.getByRole('dialog', { name: '放弃未保存的内容？', exact: true });
  let serverName = `${runKey}-forms-server`;
  const taskTitle = new RegExp(`^#${report.taskId} `);
  type Surface = {
    name: string;
    title: string | RegExp;
    open: () => Promise<void>;
    fill: (layer: Locator, device: string, save: boolean) => Promise<void>;
    saveName: string;
    command: string;
    drawer?: boolean;
    nested?: boolean;
    long?: boolean;
  };
  async function capture(name: string) {
    const file = resolve(screenshotDirectory, `forms-${name}.png`);
    await page.screenshot({
      path: file,
      fullPage: false,
      animations: 'disabled',
    });
    report.screenshots.push(file);
  }
  async function values(layer: Locator) {
    return layer.locator('input, textarea, select').evaluateAll((elements) =>
      elements.map((element) => {
        const field = element as
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        return {
          tag: field.tagName,
          type: field.type,
          value: field.value,
          checked: field instanceof HTMLInputElement ? field.checked : null,
        };
      }),
    );
  }
  async function closeAttempt(
    layer: Locator,
    surface: Surface,
    method: string,
  ) {
    if (method === 'escape') await page.keyboard.press('Escape');
    else if (method === 'x')
      await layer.getByRole('button', { name: /^(关闭|Close)$/ }).click();
    else if (method === 'cancel')
      await layer.getByRole('button', { name: '取消', exact: true }).click();
    else if (surface.drawer)
      await page
        .locator('.ant-drawer-mask')
        .click({ position: { x: 1, y: 1 } });
    else
      await page
        .locator('.ant-modal-wrap')
        .last()
        .click({ position: { x: 1, y: 1 } });
  }
  async function noConfirmation() {
    await expect(confirmation()).toHaveCount(0);
  }
  async function protectedRefresh(
    layer: Locator,
    snapshot: Awaited<ReturnType<typeof values>>,
  ) {
    const dialogPromise = page.waitForEvent('dialog', {
      predicate: (dialog) => dialog.type() === 'beforeunload',
      timeout: 10000,
    });
    const refresh = page
      .reload({ waitUntil: 'domcontentloaded', timeout: 10000 })
      .catch((error: unknown) => {
        const message = String(error);
        if (!/ERR_ABORTED|cancelled|Timeout/.test(message)) throw error;
      });
    const native = await dialogPromise;
    assert.equal(native.type(), 'beforeunload');
    await native.dismiss();
    await refresh;
    await expect(layer).toBeVisible();
    assert.deepEqual(
      await values(layer),
      snapshot,
      'Dismissed browser refresh must preserve every field',
    );
  }
  async function openAction(mode: 'status' | 'effort') {
    await openTask();
    await page
      .getByRole('dialog', { name: taskTitle })
      .getByRole('button', {
        name: mode === 'status' ? '状态流转草案' : '登记工时草案',
        exact: true,
      })
      .click();
  }
  const surfaces: Surface[] = [
    {
      name: 'thread',
      title: taskTitle,
      drawer: true,
      command: 'add-message',
      saveName: '发送记录',
      open: openTask,
      fill: async (layer, device) => {
        await layer
          .getByLabel('添加协作记录')
          .fill(`${runKey}-${device} 未保存线程记录，继续编辑应保留。`);
      },
    },
    {
      name: 'task-draft',
      title: '新建任务草案',
      command: 'create-draft',
      saveName: '保存草案',
      open: async () => {
        await navigate('tasks');
        await page
          .getByRole('button', { name: '新建任务草案', exact: true })
          .click();
      },
      fill: async (layer, device) => {
        await layer
          .getByLabel('任务名称')
          .fill(`${runKey}-${device}-unsaved-task`);
        await layer
          .getByLabel('任务说明')
          .fill('多行说明\n确认继续编辑后完整保留。');
        await layer.getByLabel('负责人账号').fill(account);
        await layer.getByLabel('预计工时（小时）').fill('2');
        await layer.getByLabel('优先级').selectOption('2');
      },
    },
    {
      name: 'status-draft',
      title: `状态流转草案 · #${report.taskId}`,
      nested: true,
      command: 'create-draft',
      saveName: '保存待审阅草案',
      open: () => openAction('status'),
      fill: async (layer) => {
        await layer.getByLabel('目标状态').selectOption('finish');
        await layer.getByLabel('本次新增耗时（小时）').fill('0.1');
        const now = new Date();
        const dateTime = (date: Date) =>
          `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        await layer
          .getByLabel('实际开始时间')
          .fill(dateTime(new Date(now.getTime() - 3600000)));
        await layer.getByLabel('实际完成时间').fill(dateTime(now));
        await layer
          .getByLabel('流转说明')
          .fill('验收未保存状态草案；不会批准或执行。');
      },
    },
    {
      name: 'effort-draft',
      title: `登记工时草案 · #${report.taskId}`,
      nested: true,
      command: 'create-draft',
      saveName: '保存待审阅草案',
      open: () => openAction('effort'),
      fill: async (layer) => {
        await layer.getByLabel('本次新增耗时（小时）').fill('0.1');
        await layer.getByLabel('登记后剩余工时（小时）').fill('0.65');
        await layer
          .getByLabel('工作内容')
          .fill('验收未保存工时草案；不会批准或执行。');
      },
    },
    {
      name: 'skill',
      title: '安装技能 / 新版本',
      long: true,
      command: 'install-skill',
      saveName: '验证并安装',
      open: async () => {
        await navigate('capabilities');
        await page
          .getByRole('button', { name: '安装技能 / 新版本', exact: true })
          .click();
      },
      fill: async (layer, device) => {
        const name = `${runKey}-${device}-guard`;
        await layer.getByLabel('技能名称').fill(name);
        await layer.getByLabel('用途说明').fill('定向验收未保存内容保护');
        await layer.getByLabel('来源说明').fill('本机表单保护验收');
        await layer
          .getByLabel('SKILL.md')
          .fill(
            `---\nname: ${name}\ndescription: Verify unsaved form protection\n---\nKeep all edited fields until explicitly discarded.\n`,
          );
      },
    },
    {
      name: 'mcp',
      title: '编辑 MCP Server',
      command: 'save-server',
      saveName: '保存服务',
      open: async () => {
        await navigate('capabilities');
        await page.getByRole('tab', { name: /^MCP Server/ }).click();
        const row = page
          .locator('.capability-list > li')
          .filter({ has: page.getByText(serverName, { exact: true }) });
        await row.locator('summary').first().click();
        await row
          .getByRole('button', { name: '编辑连接', exact: true })
          .click();
      },
      fill: async (layer, device, save) => {
        await layer
          .getByLabel('服务名称')
          .fill(`${runKey}-${device}-edited-server`);
        await layer.getByLabel('服务地址').fill('http://127.0.0.1:4399/mcp');
        if (save) serverName = `${runKey}-${device}-edited-server`;
      },
    },
    {
      name: 'team',
      title: 'T 组模型与职责',
      long: true,
      command: 'configure-team',
      saveName: '保存配置',
      open: async () => {
        await navigate('agents');
        await page
          .getByRole('button', { name: '配置 T 组', exact: true })
          .click();
      },
      fill: async (layer, device, save) => {
        for (let index = 0; index < 3; index++) {
          if (!save)
            await layer
              .getByLabel('模型名称')
              .nth(index)
              .fill(`form-check-${index}`);
          await layer
            .getByLabel('补充要求')
            .nth(index)
            .fill(
              `${runKey}-${device} 角色${index}表单保护验收\n保留所有字段。`,
            );
        }
      },
    },
  ];
  await navigate('capabilities');
  await page.getByRole('tab', { name: /^MCP Server/ }).click();
  await page
    .getByRole('button', { name: '添加 MCP Server', exact: true })
    .click();
  const initialServer = page.getByRole('dialog', {
    name: '添加 MCP Server',
    exact: true,
  });
  await initialServer.getByLabel('服务名称').fill(serverName);
  await initialServer.getByLabel('服务地址').fill('http://127.0.0.1:4399/mcp');
  await command('save-server', () =>
    initialServer
      .getByRole('button', { name: '保存服务', exact: true })
      .click(),
  );
  await expect(initialServer).toHaveCount(0);
  for (const [device, viewport] of [
    ['desktop', { width: 1366, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    if (process.argv.includes('--forms-mobile-only') && device !== 'mobile')
      continue;
    await page.setViewportSize(viewport);
    for (const surface of surfaces) {
      const passed = await check(
        `${device}/${surface.name}: clean, preserve, discard, refresh and successful save`,
        async () => {
          await surface.open();
          let layer = page.getByRole('dialog', {
            name: surface.title,
            exact: typeof surface.title === 'string',
          });
          await expect(layer).toBeVisible();
          await closeAttempt(layer, surface, surface.drawer ? 'x' : 'cancel');
          await expect(layer).toHaveCount(0);
          await noConfirmation();
          await surface.open();
          layer = page.getByRole('dialog', {
            name: surface.title,
            exact: typeof surface.title === 'string',
          });
          await surface.fill(layer, device, false);
          const snapshot = await values(layer);
          const maskExposed =
            !surface.drawer ||
            (await page.locator('.ant-drawer-mask').evaluate((mask) => {
              const bounds = mask.getBoundingClientRect();
              return (
                document.elementFromPoint(bounds.left + 1, bounds.top + 1) ===
                mask
              );
            }));
          const methods = surface.drawer
            ? ['escape', 'x', ...(maskExposed ? ['mask'] : [])]
            : ['escape', 'x', 'mask', 'cancel'];
          for (const method of methods) {
            await closeAttempt(layer, surface, method);
            const guard = confirmation();
            await expect(guard).toBeVisible();
            await expect(
              guard.getByRole('button', { name: '继续编辑', exact: true }),
            ).toBeFocused();
            if (surface.name === 'task-draft' && method === 'escape')
              await capture(`${device}-unsaved-confirmation`);
            await guard
              .getByRole('button', { name: '继续编辑', exact: true })
              .click();
            await expect(guard).toHaveCount(0);
            assert.deepEqual(
              await values(layer),
              snapshot,
              `${surface.name}/${method}: all values must be retained`,
            );
          }
          await protectedRefresh(layer, snapshot);
          await closeAttempt(layer, surface, surface.drawer ? 'x' : 'cancel');
          await confirmation()
            .getByRole('button', { name: '放弃更改', exact: true })
            .click();
          await expect(layer).toHaveCount(0);
          await noConfirmation();
          if (surface.nested)
            await expect(
              page.getByRole('dialog', { name: taskTitle }),
            ).toBeVisible();
          await surface.open();
          layer = page.getByRole('dialog', {
            name: surface.title,
            exact: typeof surface.title === 'string',
          });
          await surface.fill(layer, device, true);
          const save = layer.getByRole('button', {
            name: surface.saveName,
            exact: true,
          });
          await save.scrollIntoViewIfNeeded();
          await expect(save).toBeInViewport({ ratio: 1 });
          if (surface.long) await capture(`${device}-${surface.name}-bottom`);
          await command(surface.command, () => save.click());
          if (surface.drawer) {
            await expect(layer.getByLabel('添加协作记录')).toHaveValue('');
            await closeAttempt(layer, surface, 'x');
          }
          await expect(layer).toHaveCount(0);
          await noConfirmation();
          return {
            cleanClose: true,
            closeMethods: methods,
            defaultContinuesEditing: true,
            allFieldsPreserved: true,
            discardedExplicitly: true,
            beforeUnloadDismissed: true,
            savedWithoutPrompt: true,
            bottomSaveVisible: true,
            maskClose: maskExposed
              ? 'verified'
              : 'not exposed by the full-width mobile drawer',
          };
        },
      );
      assert(
        passed,
        `Fix acceptance failed at ${device}/${surface.name}; stop and report rather than bypassing the form`,
      );
    }
  }
  const screenshots = [];
  for (const path of report.screenshots) {
    const png = await readFile(path);
    screenshots.push({
      path,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    });
  }
  await writeFile(
    resolve(directory, 'forms-screenshot-manifest.json'),
    JSON.stringify(
      { runKey, scope: 'Reviewer P2 unsaved-content fix only', screenshots },
      null,
      2,
    ) + '\n',
  );
}

async function runNavigationFix() {
  const overviewReads: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      request.url() === `${base}/api/workspaces/${workspaceId}`
    )
      overviewReads.push(request.url());
  });
  async function historyState(stage: string) {
    report.navigationEvidence.push({
      stage,
      overviewReads: overviewReads.length,
      state: await page.evaluate(() => ({
        url: window.location.href,
        view: new URL(window.location.href).searchParams.get('view'),
        tandemIndex: window.history.state?.tandemIndex ?? null,
        nativeIndex:
          (
            window as Window & {
              navigation?: { currentEntry?: { index?: number } };
            }
          ).navigation?.currentEntry?.index ?? null,
        headings: Array.from(document.querySelectorAll('h1,h2')).map(
          (heading) => heading.textContent,
        ),
        dispatchers: document.querySelectorAll('textarea').length,
        loadingRows: document.querySelectorAll('.loading-rows').length,
        projectSelect: !!document.querySelector('#project-scope'),
      })),
    });
  }
  const guard = () =>
    page.getByRole('dialog', { name: '放弃未保存的内容？', exact: true });
  const text = {
    goal: `${runKey} 保留交付目标`,
    acceptance: `${runKey} 保留全部验收条件\n包含多行文本。`,
  };
  async function fill() {
    await page.getByLabel('交付目标').fill(text.goal);
    await page.getByLabel('验收条件').fill(text.acceptance);
  }
  async function preserved() {
    await expect(page.getByLabel('交付目标')).toHaveValue(text.goal);
    await expect(page.getByLabel('验收条件')).toHaveValue(text.acceptance);
  }
  async function closeMenu() {
    const close = page.getByRole('button', { name: '收起导航', exact: true });
    if (await close.isVisible()) await close.click();
  }
  async function nav(label: string) {
    const link = page
      .getByRole('navigation', { name: '主要导航' })
      .getByRole('link', { name: label, exact: true });
    if (!(await link.isVisible()))
      await page.getByRole('button', { name: '展开导航', exact: true }).click();
    await link.click();
  }
  async function continueEditing() {
    await expect(guard()).toBeVisible();
    await expect(
      guard().getByRole('button', { name: '继续编辑', exact: true }),
    ).toBeFocused();
    await guard()
      .getByRole('button', { name: '继续编辑', exact: true })
      .click();
    await expect(guard()).toHaveCount(0);
    await closeMenu();
    await preserved();
  }
  async function discard() {
    await expect(guard()).toBeVisible();
    await guard()
      .getByRole('button', { name: '放弃更改', exact: true })
      .click();
    await expect(guard()).toHaveCount(0);
    await page.waitForLoadState('networkidle');
  }
  async function capture(name: string) {
    const path = resolve(screenshotDirectory, `forms-${name}.png`);
    await page.screenshot({ path, fullPage: false, animations: 'disabled' });
    report.screenshots.push(path);
  }
  for (const [device, viewport] of [
    ['desktop', { width: 1366, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    if (process.argv.includes('--forms-history-only') && device !== 'desktop')
      continue;
    await page.setViewportSize(viewport);
    let passed: boolean;
    if (!process.argv.includes('--forms-history-only')) {
      passed = await check(
        `${device}/dispatch-navigation: continue preserves and discard navigates`,
        async () => {
          await navigate('focus');
          await fill();
          const url = page.url();
          await nav('Agents');
          await expect(guard()).toBeVisible();
          await capture(`${device}-navigation-confirmation`);
          await continueEditing();
          assert.equal(page.url(), url);
          await nav('Agents');
          await discard();
          assert.equal(new URL(page.url()).searchParams.get('view'), 'agents');
          await expect(page.getByLabel('交付目标')).toHaveValue('');
          return {
            safeDefault: true,
            bothLongTextsPreserved: true,
            discardedBeforeNavigation: true,
          };
        },
      );
      assert(passed);
      passed = await check(
        `${device}/dispatch-project: continue preserves and discard switches project`,
        async () => {
          await navigate('focus');
          const other = await page
            .locator('#project-scope option')
            .evaluateAll(
              (options, current) =>
                options
                  .map((option) => (option as HTMLOptionElement).value)
                  .find((value) => value && value !== current) ?? '',
              boundProjectId,
            );
          assert(other, 'A second existing authorized project is required');
          await fill();
          await page.locator('#project-scope').selectOption(other);
          await continueEditing();
          await expect(page.locator('#project-scope')).toHaveValue(
            boundProjectId,
          );
          await page.locator('#project-scope').selectOption(other);
          await discard();
          await expect(page.locator('#project-scope')).toHaveValue(other);
          await expect(page.getByLabel('交付目标')).toHaveValue('');
          await page.locator('#project-scope').selectOption(boundProjectId);
          return {
            bothLongTextsPreserved: true,
            discardedBeforeProjectSwitch: true,
          };
        },
      );
      assert(passed);
    }
    passed = await check(
      `${device}/dispatch-history: actual browser back and forward preserve until discarded`,
      async () => {
        await navigate('agents');
        await nav('关注');
        await page.waitForLoadState('networkidle');
        await fill();
        const url = page.url();
        await historyState('before-back');
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await expect(guard()).toBeVisible();
        await capture(`${device}-history-confirmation`);
        await continueEditing();
        await historyState('cancelled-back');
        assert.equal(page.url(), url);
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await discard();
        await historyState('accepted-back');
        if (!(await page.getByLabel('交付目标').count()))
          await capture(`${device}-history-accepted-back-state`);
        assert.equal(new URL(page.url()).searchParams.get('view'), 'agents');
        await expect(page.getByLabel('交付目标')).toHaveValue('');
        await fill();
        const agentsUrl = page.url();
        await historyState('before-forward');
        await page.goForward({ waitUntil: 'domcontentloaded' });
        await continueEditing();
        await historyState('cancelled-forward');
        assert.equal(page.url(), agentsUrl);
        await page.goForward({ waitUntil: 'domcontentloaded' });
        await discard();
        await historyState('accepted-forward');
        assert.equal(new URL(page.url()).searchParams.get('view'), 'focus');
        await expect(page.getByLabel('交付目标')).toHaveValue('');
        return {
          actualBack: true,
          actualForward: true,
          bothLongTextsPreserved: true,
          discardedBeforeTraversal: true,
        };
      },
    );
    assert(passed);
    if (process.argv.includes('--forms-history-only')) return;
    const nativeHistory = await page.evaluate(
      () =>
        typeof (
          window as Window & {
            navigation?: { currentEntry?: { index?: number } };
          }
        ).navigation?.currentEntry?.index === 'number',
    );
    if (nativeHistory) {
      passed = await check(
        `${device}/dispatch-legacy-history: null state still preserves and traverses`,
        async () => {
          await navigate('agents');
          await nav('关注');
          // Explicit legacy history fixture, without mocking any product API or session.
          await page.evaluate(() =>
            window.history.replaceState(null, '', window.location.href),
          );
          // Next.js preserves its router metadata when null is requested; the
          // legacy boundary here is the absence of Tandem's traversal metadata.
          assert.equal(
            await page.evaluate(
              () => window.history.state?.tandemIndex ?? null,
            ),
            null,
          );
          assert.equal(
            await page.evaluate(
              () => window.history.state?.tandemHistoryId ?? null,
            ),
            null,
          );
          await nav('Agents');
          await page.waitForLoadState('networkidle');
          await fill();
          const current = page.url();
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await continueEditing();
          assert.equal(page.url(), current);
          await page.goBack({ waitUntil: 'domcontentloaded' });
          await discard();
          assert.equal(new URL(page.url()).searchParams.get('view'), 'focus');
          await expect(page.getByLabel('交付目标')).toHaveValue('');
          return {
            legacyNullState: true,
            nextRouterMetadataPreserved: true,
            nativeHistoryIndex: true,
            bothLongTextsPreserved: true,
            discardedBeforeTraversal: true,
          };
        },
      );
      assert(passed);
    } else
      report.checks.push({
        name: `${device}/dispatch-legacy-history`,
        status: 'pending',
        detail: 'Browser Navigation API indices are unavailable.',
      });
    const alternatives = await page
      .locator('#workspace-selector option')
      .evaluateAll(
        (options, current) =>
          options
            .map((option) => (option as HTMLOptionElement).value)
            .filter((value) => value && value !== current),
        workspaceId,
      );
    if (!alternatives.length)
      report.checks.push({
        name: `${device}/dispatch-workspace`,
        status: 'pending',
        detail:
          'Only one authorized workspace exists; no extra workspace was created for this fix acceptance.',
      });
    else {
      passed = await check(
        `${device}/dispatch-workspace: continue preserves and discard switches workspace`,
        async () => {
          await navigate('focus');
          await fill();
          await page
            .locator('#workspace-selector')
            .selectOption(alternatives[0]!);
          await continueEditing();
          await expect(page.locator('#workspace-selector')).toHaveValue(
            workspaceId,
          );
          await page
            .locator('#workspace-selector')
            .selectOption(alternatives[0]!);
          await discard();
          await expect(page.locator('#workspace-selector')).toHaveValue(
            alternatives[0]!,
          );
          await page.locator('#workspace-selector').selectOption(workspaceId);
          return {
            bothLongTextsPreserved: true,
            discardedBeforeWorkspaceSwitch: true,
          };
        },
      );
      assert(passed);
    }
  }
  const screenshots = [];
  for (const path of report.screenshots) {
    const png = await readFile(path);
    screenshots.push({
      path,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    });
  }
  await writeFile(
    resolve(directory, 'forms-navigation-screenshot-manifest.json'),
    JSON.stringify(
      {
        runKey,
        scope: 'Reviewer P2 navigation continuation only',
        screenshots,
      },
      null,
      2,
    ) + '\n',
  );
}

try {
  const loginOk = await check(
    'Login with actual inherited collaboration account',
    async () => {
      await page.goto(base);
      await page.getByLabel('协作账号', { exact: true }).fill(account);
      await page.getByLabel('密码', { exact: true }).fill(password);
      const response = page.waitForResponse(
        (r) =>
          r.url() === base + '/api/session' && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '登录', exact: true }).click();
      assert.equal((await response).status(), 200);
      await expect(page.locator('#workspace-selector')).toBeVisible();
      await page.locator('#workspace-selector').selectOption(workspaceId);
    },
  );
  assert(loginOk, 'Cannot continue without real login');

  const projectOk = await check(
    'Bind dedicated real project through Connections page',
    async () => {
      await navigate('connect');
      await section('已连接项目')
        .getByLabel('连接项目')
        .selectOption(seed.projectId);
      const project = await command('bind-project', () =>
        page.getByRole('button', { name: '连接到空间', exact: true }).click(),
      );
      boundProjectId = (project as { id: string }).id;
      assert(boundProjectId);
      await expect(
        page.locator(`#project-scope option[value="${boundProjectId}"]`),
      ).toHaveCount(1);
      await page.locator('#project-scope').selectOption(boundProjectId);
      await expect(section('已连接项目')).toContainText('可读取和提交草案');
    },
  );

  if (formsMode) {
    assert(projectOk);
    if (navigationMode) await runNavigationFix();
    else await runFormsFix();
  } else {
    let createOk = false;
    if (projectOk && !process.argv.includes('--capabilities-only'))
      createOk = await check(
        'Create task draft, revise version, approve, worker writes real ZenTao',
        async () => {
          await navigate('tasks');
          await expect(
            page.getByRole('button', { name: '新建任务草案', exact: true }),
          ).toBeEnabled();
          await page
            .getByRole('button', { name: '新建任务草案', exact: true })
            .click();
          let dialog = page.getByRole('dialog');
          await dialog.getByLabel('任务名称', { exact: true }).fill(runKey);
          await dialog
            .getByLabel('任务说明')
            .fill('本地真实产品验收专用任务；所有外部写入均经草案审批。');
          await dialog.getByLabel('负责人账号', { exact: true }).fill(account);
          await command('create-draft', () =>
            dialog
              .getByRole('button', { name: '保存草案', exact: true })
              .click(),
          );
          await expect(dialog).toHaveCount(0);
          await draft(`新建任务：${runKey}`)
            .getByRole('button', { name: '修改草案', exact: true })
            .click();
          dialog = page.getByRole('dialog');
          await dialog
            .getByLabel('任务说明')
            .fill('第二版：验收草案版本与审批绑定，之后核对真实禅道任务。');
          await command('revise-draft', () =>
            dialog
              .getByRole('button', { name: '保存草案', exact: true })
              .click(),
          );
          const receipt = await approve(`新建任务：${runKey}`, 2);
          const match = receipt.match(/任务 #(\d+)/);
          assert(match, 'Missing actual task receipt');
          report.taskId = match[1]!;
          return { versionApproved: 2, taskId: report.taskId };
        },
      );

    if (createOk) {
      await check(
        'Task thread persists and task update requires approval',
        async () => {
          await page.getByRole('button', { name: '刷新', exact: true }).click();
          await openTask();
          const drawer = page.getByRole('dialog');
          await drawer
            .getByLabel('添加协作记录', { exact: true })
            .fill(`${runKey} 协作记录：张三已检查任务说明。`);
          await command('add-message', () =>
            drawer
              .getByRole('button', { name: '发送记录', exact: true })
              .click(),
          );
          await expect(drawer).toContainText(`${runKey} 协作记录`);
          await drawer
            .getByRole('button', { name: '编辑任务草案', exact: true })
            .click();
          const modal = page.getByRole('dialog').last();
          await modal
            .getByLabel('任务说明')
            .fill('已审批修改：保留真实线程，核对状态和工时。');
          await command('create-draft', () =>
            modal
              .getByRole('button', { name: '保存草案', exact: true })
              .click(),
          );
          await closeDrawer();
          await approve(`修改任务：${runKey}`);
          await openTask();
          await expect(page.getByRole('dialog')).toContainText(
            '已审批修改：保留真实线程',
          );
          await closeDrawer();
        },
      );
      await check(
        'Status transition draft approval and actual worker execution',
        async () => {
          await openTask();
          await page
            .getByRole('dialog')
            .getByRole('button', { name: '状态流转草案', exact: true })
            .click();
          const modal = page.getByRole('dialog').last();
          await modal.getByLabel('目标状态').selectOption('start');
          await modal
            .getByLabel('开始后的累计耗时（小时）', { exact: true })
            .fill('0');
          await modal
            .getByLabel('登记后剩余工时（小时）', { exact: true })
            .fill('1');
          await modal
            .getByLabel('流转说明', { exact: true })
            .fill('真实验收开始任务');
          await command('create-draft', () =>
            modal
              .getByRole('button', { name: '保存待审阅草案', exact: true })
              .click(),
          );
          await closeDrawer();
          await approve(`开始 · 进行中：${runKey}`);
          await openTask();
          await expect(page.getByRole('dialog')).toContainText('进行中');
          await closeDrawer();
        },
      );
      await check(
        'Effort draft approval and actual worker execution',
        async () => {
          await openTask();
          await page
            .getByRole('dialog')
            .getByRole('button', { name: '登记工时草案', exact: true })
            .click();
          const modal = page.getByRole('dialog').last();
          await modal
            .getByLabel('本次新增耗时（小时）', { exact: true })
            .fill('0.25');
          await modal
            .getByLabel('登记后剩余工时（小时）', { exact: true })
            .fill('0.75');
          await modal
            .getByLabel('工作内容', { exact: true })
            .fill(`${runKey} 验证真实工时写回`);
          await command('create-draft', () =>
            modal
              .getByRole('button', { name: '保存待审阅草案', exact: true })
              .click(),
          );
          await closeDrawer();
          await approve(`登记工时：${runKey}`);
          const provider = new ZentaoIdentityProvider({
            id: 'acceptance-readback',
            label: 'local',
            baseUrl: upstreamUrl.href,
            allowInsecureHttp: true,
            commanderAccounts: [],
          });
          const login = await provider.authenticate(account, password);
          const upstream = new ZentaoProjectSystem({
            connectionId: login.providerId,
            baseUrl: upstreamUrl.href,
            allowInsecureHttp: true,
            accessToken: login.accessToken,
            subject: login.subject,
          });
          const actual = await upstream.task(seed.projectId, report.taskId);
          assert.equal(actual.name, runKey);
          assert.equal(actual.status, 'doing');
          assert.equal(actual.consumed, 0.25);
          assert.equal(actual.left, 0.75);
          assert(actual.description.includes('已审批修改'));
          report.independentTaskEvidence = {
            id: actual.id,
            status: actual.status,
            consumed: actual.consumed,
            left: actual.left,
            version: actual.version,
          };
          return report.independentTaskEvidence;
        },
      );
    }

    await check(
      'Real skill template download/import, version, enable, bind and revoke',
      async () => {
        await navigate('capabilities');
        await page
          .getByRole('button', { name: '安装技能 / 新版本', exact: true })
          .click();
        let modal = page.getByRole('dialog');
        const downloaded = page.waitForEvent('download');
        await modal
          .getByRole('link', { name: '下载技能包模板', exact: true })
          .click();
        const file = resolve(directory, 'downloaded-quality-review.skill.json');
        await (await downloaded).saveAs(file);
        const template = JSON.parse(await readFile(file, 'utf8'));
        const name = runKey + '-review';
        template.name = name;
        template.files['SKILL.md'] = template.files['SKILL.md'].replace(
          'name: quality-review',
          `name: ${name}`,
        );
        const bundle = resolve(directory, 'walkthrough.skill.json');
        await writeFile(bundle, JSON.stringify(template));
        await modal
          .getByLabel('导入完整技能包', { exact: true })
          .setInputFiles(bundle);
        await expect(modal.getByLabel('技能名称', { exact: true })).toHaveValue(
          name,
        );
        await command('install-skill', () =>
          modal
            .getByRole('button', { name: '验证并安装', exact: true })
            .click(),
        );
        await page
          .locator('.capability-list > li')
          .filter({ has: page.getByText(name, { exact: true }) })
          .locator('summary')
          .first()
          .click();
        const row = page
          .locator('.capability-list > li')
          .filter({ has: page.getByText(name, { exact: true }) });
        if (
          await row
            .getByRole('button', { name: '启用技能', exact: true })
            .count()
        )
          await command('toggle-skill', () =>
            row.getByRole('button', { name: '启用技能', exact: true }).click(),
          );
        await command('activate-skill', () =>
          row
            .getByRole('button', { name: '切换生效版本', exact: true })
            .click(),
        );
        await command('bind-skill', () =>
          row
            .getByRole('button', { name: '绑定到当前项目', exact: true })
            .click(),
        );
        await expect(row).toContainText('绑定有效');
        await command('bind-skill', () =>
          row.getByRole('button', { name: '撤销绑定', exact: true }).click(),
        );
        await expect(row).toContainText('绑定已撤销');
        await command('toggle-skill', () =>
          row.getByRole('button', { name: '停用技能', exact: true }).click(),
        );
        await expect(
          row.getByRole('button', { name: '绑定到当前项目', exact: true }),
        ).toBeDisabled();
        // Import a second immutable version and explicitly select/activate it.
        template.version = '1.1.0';
        template.files['references/checklist.md'] += '\n- 实际本地系统验证\n';
        await writeFile(bundle, JSON.stringify(template));
        await page
          .getByRole('button', { name: '安装技能 / 新版本', exact: true })
          .click();
        modal = page.getByRole('dialog');
        await modal
          .getByLabel('导入完整技能包', { exact: true })
          .setInputFiles(bundle);
        await expect(modal.getByLabel('版本', { exact: true })).toHaveValue(
          '1.1.0',
        );
        await command('install-skill', () =>
          modal
            .getByRole('button', { name: '验证并安装', exact: true })
            .click(),
        );
        const previousVersionOption = row
          .getByLabel('查看版本')
          .locator('option')
          .filter({ hasText: '1.0.0' });
        await expect(previousVersionOption).toHaveCount(1);
        await row
          .getByLabel('查看版本')
          .selectOption((await previousVersionOption.getAttribute('value'))!);
        await command('activate-skill', () =>
          row
            .getByRole('button', { name: '切换生效版本', exact: true })
            .click(),
        );
        await expect(row.locator('summary').first()).toContainText('1.0.0');
        const versionOption = row
          .getByLabel('查看版本')
          .locator('option')
          .filter({ hasText: '1.1.0' });
        await expect(versionOption).toHaveCount(1);
        await row
          .getByLabel('查看版本')
          .selectOption((await versionOption.getAttribute('value'))!);
        await command('activate-skill', () =>
          row
            .getByRole('button', { name: '切换生效版本', exact: true })
            .click(),
        );
        await expect(row.locator('summary').first()).toContainText('1.1.0');
        await command('toggle-skill', () =>
          row.getByRole('button', { name: '停用技能', exact: true }).click(),
        );
        return {
          name,
          importedTemplate: true,
          versions: ['1.0.0', '1.1.0'],
          rolledBackAndRestored: true,
          revoked: true,
          enabled: false,
          execution:
            'No real model configured; skill runtime use remains pending',
        };
      },
    );

    let mcpTitle = '';
    await check(
      'MCP registration, discovery without invocation, read/write authorization and calls',
      async () => {
        await navigate('capabilities');
        await page.getByRole('tab', { name: /^MCP Server/ }).click();
        await page
          .getByRole('button', { name: '添加 MCP Server', exact: true })
          .click();
        const modal = page.getByRole('dialog');
        await modal.getByLabel('服务名称', { exact: true }).fill(runKey);
        await modal
          .getByLabel('服务地址', { exact: true })
          .fill('http://127.0.0.1:4399/mcp');
        await command('save-server', () =>
          modal.getByRole('button', { name: '保存服务', exact: true }).click(),
        );
        const row = page
          .locator('.capability-list > li')
          .filter({ has: page.getByText(runKey, { exact: true }) });
        await row.locator('summary').first().click();
        const before = fixture.calls.filter((v) => v === 'tools/call').length;
        await command('test-server', () =>
          row.getByRole('button', { name: '测试连接', exact: true }).click(),
        );
        assert.equal(
          fixture.calls.filter((v) => v === 'tools/call').length,
          before,
        );
        assert.equal(fixture.notes.length, 0);
        await expect(row).toContainText('连接正常');
        await expect(
          row.getByLabel('echo 副作用分类', { exact: true }),
        ).toHaveValue('unknown');
        await expect(row).toContainText('当前项目未授权');
        for (const [tool, effect] of [
          ['echo', 'read'],
          ['write_note', 'write'],
        ]) {
          const toolRow = row
            .locator('.tool-list > li')
            .filter({ has: page.getByText(tool!, { exact: true }) });
          await toolRow
            .getByLabel(`${tool} 副作用分类`, { exact: true })
            .selectOption(effect!);
          await command('grant-tool', () =>
            toolRow
              .getByRole('button', { name: '保存工具授权', exact: true })
              .click(),
          );
        }
        await row
          .locator('label.field')
          .filter({ hasText: /^工具\s*选择工具/ })
          .locator('select')
          .selectOption('echo');
        await row
          .getByLabel('工具参数（JSON 对象）')
          .fill(JSON.stringify({ text: runKey }));
        await command('call-tool', () =>
          row.getByRole('button', { name: '提交调用', exact: true }).click(),
        );
        await expect(row.locator('.tool-result')).toContainText(
          'echo: ' + runKey,
        );
        await row
          .locator('label.field')
          .filter({ hasText: /^工具\s*选择工具/ })
          .locator('select')
          .selectOption('write_note');
        await row.getByLabel('工具参数（JSON 对象）').fill(
          JSON.stringify({
            key: runKey,
            note: 'Approved actual local MCP acceptance write.',
          }),
        );
        const write = await command('call-tool', () =>
          row.getByRole('button', { name: '提交调用', exact: true }).click(),
        );
        assert.equal(fixture.notes.length, 0, 'Write must await approval');
        assert(write);
        await navigate('focus');
        const mcpRow = page
          .locator('.draft-list > li')
          .filter({ hasText: 'write_note' })
          .filter({ hasText: runKey })
          .first();
        mcpTitle = await mcpRow.getByRole('heading').innerText();
        await approve(mcpTitle);
        assert.equal(fixture.notes.length, 1);
        assert.equal(fixture.notes[0]?.key, runKey);
        return {
          readCalled: true,
          discoveryCallsTools: false,
          writeAwaitedApproval: true,
          actualNotesWritten: fixture.notes.length,
        };
      },
    );

    await check('Disabled MCP service rejects a later invocation', async () => {
      assert(mcpTitle, 'MCP lifecycle prerequisite failed');
      await navigate('capabilities');
      await page.getByRole('tab', { name: /^MCP Server/ }).click();
      const row = page
        .locator('.capability-list > li')
        .filter({ has: page.getByText(runKey, { exact: true }) });
      await row.locator('summary').first().click();
      await command('toggle-server', () =>
        row.getByRole('button', { name: '停用服务', exact: true }).click(),
      );
      await row
        .locator('label.field')
        .filter({ hasText: /^工具\s*选择工具/ })
        .locator('select')
        .selectOption('echo');
      await row
        .getByLabel('工具参数（JSON 对象）')
        .fill(JSON.stringify({ text: 'must not execute' }));
      const before = fixture.calls.filter((v) => v === 'tools/call').length;
      await command(
        'call-tool',
        () =>
          row.getByRole('button', { name: '提交调用', exact: true }).click(),
        403,
      );
      await expect(row.getByRole('alert')).toBeVisible();
      assert.equal(
        fixture.calls.filter((v) => v === 'tools/call').length,
        before,
      );
    });

    await check(
      'Team configuration and honest missing-model runtime state',
      async () => {
        await navigate('agents');
        await page
          .getByRole('button', { name: '配置 T 组', exact: true })
          .click();
        const modal = page.getByRole('dialog');
        await expect(modal.getByLabel('模型名称', { exact: true })).toHaveCount(
          3,
        );
        await expect(modal).toContainText('模型服务与密钥由部署环境配置');
        await command('configure-team', () =>
          modal.getByRole('button', { name: '保存配置', exact: true }).click(),
        );
        await expect(page.locator('.agent-list .state-label')).toHaveCount(3);
        const states = await page
          .locator('.agent-list .state-label')
          .allTextContents();
        if (states.every((state) => state.includes('待配置'))) {
          await page.getByLabel('交付目标').fill(`${runKey} 可运行验收 Demo`);
          await page
            .getByLabel('验收条件')
            .fill('完整本地演示路径、测试记录与实际可预览入口。');
          await expect(
            page.getByRole('button', { name: '交给 T 组', exact: true }),
          ).toBeDisabled();
          report.checks.push({
            name: 'Real model loop, skill runtime use, Demo and deployment',
            status: 'pending',
            detail:
              'No real model service configured. The product displays 待配置 and disables dispatch; no successful runtime or delivery is claimed.',
          });
          await page.getByLabel('交付目标').fill('');
          await page.getByLabel('验收条件').fill('');
        } else {
          report.checks.push({
            name: 'Real model loop and delivery',
            status: 'pending',
            detail:
              'Model is configured. This external-system walkthrough does not certify a completed model run or delivery; run the actual target separately.',
          });
        }
      },
    );

    // One combined desktop/mobile screenshot pass. No open-ended visual polish loop.
    if (!process.argv.includes('--no-screenshots'))
      await check(
        'Desktop/mobile six-entry and modal/drawer evidence',
        async () => {
          for (const [device, viewport] of [
            ['desktop', { width: 1366, height: 900 }],
            ['mobile', { width: 390, height: 844 }],
          ] as const) {
            await page.setViewportSize(viewport);
            for (const view of [
              'focus',
              'agents',
              'tasks',
              'observe',
              'connect',
              'capabilities',
            ]) {
              await navigate(view);
              await screenshot(`${device}-${view}`);
              const overflow = await page.evaluate(
                () =>
                  document.documentElement.scrollWidth > window.innerWidth + 2,
              );
              assert.equal(overflow, false, `${device}/${view}: page overflow`);
            }
            await navigate('tasks');
            if (report.taskId) {
              await openTask();
              await screenshot(`${device}-task-drawer`);
              await page
                .getByRole('dialog')
                .getByRole('button', { name: '登记工时草案', exact: true })
                .click();
              await screenshot(`${device}-effort-modal`);
              await page
                .getByRole('dialog')
                .last()
                .getByRole('button', { name: '取消', exact: true })
                .click();
              await closeDrawer();
            }
            await navigate('capabilities');
            const inspectedSkill = page
              .locator('.capability-list > li')
              .filter({
                has: page.getByText(runKey + '-review', { exact: true }),
              });
            await inspectedSkill.locator('summary').first().click();
            const rollbackOption = inspectedSkill
              .getByLabel('查看版本')
              .locator('option')
              .filter({ hasText: '1.0.0' });
            await inspectedSkill
              .getByLabel('查看版本')
              .selectOption((await rollbackOption.getAttribute('value'))!);
            await command('activate-skill', () =>
              inspectedSkill
                .getByRole('button', { name: '切换生效版本', exact: true })
                .click(),
            );
            await expect(
              inspectedSkill.locator('summary').first(),
            ).toContainText('1.0.0');
            await screenshot(`${device}-skill-rollback`);
            const restoreOption = inspectedSkill
              .getByLabel('查看版本')
              .locator('option')
              .filter({ hasText: '1.1.0' });
            await inspectedSkill
              .getByLabel('查看版本')
              .selectOption((await restoreOption.getAttribute('value'))!);
            await command('activate-skill', () =>
              inspectedSkill
                .getByRole('button', { name: '切换生效版本', exact: true })
                .click(),
            );
            await expect(
              inspectedSkill.locator('summary').first(),
            ).toContainText('1.1.0');
            await page
              .getByRole('button', { name: '安装技能 / 新版本', exact: true })
              .click();
            await screenshot(`${device}-skill-modal`);
            await page
              .getByRole('dialog')
              .getByRole('button', { name: '取消', exact: true })
              .click();
            await page.getByRole('tab', { name: /^MCP Server/ }).click();
            const inspectedServer = page
              .locator('.capability-list > li')
              .filter({ has: page.getByText(runKey, { exact: true }) });
            await inspectedServer.locator('summary').first().click();
            await expect(inspectedServer.locator('.tool-list')).toBeVisible();
            await screenshot(`${device}-mcp`);
            await page
              .getByRole('button', { name: '添加 MCP Server', exact: true })
              .click();
            await screenshot(`${device}-mcp-modal`);
            await page
              .getByRole('dialog')
              .getByRole('button', { name: '取消', exact: true })
              .click();
            await navigate('agents');
            await page
              .getByRole('button', { name: '配置 T 组', exact: true })
              .click();
            await screenshot(`${device}-team-modal`);
            await page
              .getByRole('dialog')
              .getByRole('button', { name: '取消', exact: true })
              .click();
          }
          return {
            screenshots: report.screenshots.length,
            passes: 1,
            browserErrors: report.browserErrors.length,
          };
        },
      );
  }
} finally {
  report.completedAt = new Date().toISOString();
  await saveReport();
  await context.close();
  await browser.close();
  await fixture.close();
}
if (report.checks.some((item) => item.status === 'failed'))
  process.exitCode = 1;
console.log(
  JSON.stringify({
    report: navigationMode
      ? 'data/acceptance/forms-navigation-report.json'
      : formsMode
        ? 'data/acceptance/forms-report.json'
        : 'data/acceptance/walkthrough-report.json',
    passed: report.checks.filter((c) => c.status === 'passed').length,
    failed: report.checks.filter((c) => c.status === 'failed').length,
    pending: report.checks.filter((c) => c.status === 'pending').length,
    screenshots: report.screenshots.length,
  }),
);
