import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/workspaces/*/product?*', (route) => {
    const resource = new URL(route.request().url()).searchParams.get(
      'resource',
    );
    const replies: Record<string, unknown> = {
      projects: { projects: [] },
      'available-projects': { projects: [] },
      'project-grants': { grants: [] },
      connection: {
        connection: { label: '测试连接', kind: 'test' },
        authorization: { displayName: '张三' },
      },
      runs: { runs: [] },
      drafts: { drafts: [] },
      profiles: {
        profiles: {
          designer: { model: '', instructions: '' },
          architect: { model: '', instructions: '' },
          engineer: { model: '', instructions: '' },
        },
        model: { configured: false, name: '' },
        execution: { configured: false },
      },
    };
    return route.fulfill({ json: replies[resource ?? ''] ?? {} });
  });
});

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  displayName: '张三',
  canCreateWorkspace: true,
};
const a = {
  id: '00000000-0000-4000-8000-000000000002',
  name: '空间 A',
  role: 'owner',
};
const b = {
  id: '00000000-0000-4000-8000-000000000003',
  name: '空间 B',
  role: 'owner',
};
function overview(workspace = a) {
  return {
    workspace,
    team: {
      id: workspace.id + '-team',
      name: 'T 组',
      templateVersion: 1,
      ownerId: user.id,
      ownerDisplayName: user.displayName,
      agents: [
        {
          id: 'designer',
          role: 'designer',
          name: '产品设计师',
          description: '需求与验收标准、UI/UX 设计、体验与视觉验收。',
        },
        {
          id: 'architect',
          role: 'architect',
          name: '技术架构师',
          description: '系统与接口设计、部署与回滚方案、技术复核。',
        },
        {
          id: 'engineer',
          role: 'engineer',
          name: '研发工程师',
          description: '开发、测试、修复与获批部署验证。',
        },
      ],
    },
  };
}
async function authenticated(page: Page) {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: { user, login: { configured: true, label: '协作账号' } },
    }),
  );
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ json: { workspaces: [a, b] } }),
  );
  await page.route('**/api/workspaces/*', (route) =>
    route.fulfill({
      json: overview(route.request().url().endsWith(b.id) ? b : a),
    }),
  );
}
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '展开导航' });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('link', { name, exact: true })
    .click();
}

test('未配置身份时不提供免登录或假账号', async ({ page }) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: { user: null, login: { configured: false, label: '协作账号' } },
    }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '尚未配置身份连接' }),
  ).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '检查配置' }).click();
  await expect(
    page.getByRole('heading', { name: '尚未配置身份连接' }),
  ).toBeVisible();
});

test('登录、创建空间与 T 组初始状态', async ({ page }) => {
  let loggedIn = false;
  let created = false;
  let requestId = '';
  await page.route('**/api/session', (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        account: 'zhangsan',
        password: 'test-only-password',
      });
      loggedIn = true;
      return route.fulfill({ json: { user } });
    }
    return route.fulfill({
      json: {
        user: loggedIn ? user : null,
        login: { configured: true, label: '协作账号' },
      },
    });
  });
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      expect(input.name).toBe('空间 A');
      requestId = input.requestId;
      created = true;
      return route.fulfill({ json: { workspace: a } });
    }
    return route.fulfill({ json: { workspaces: created ? [a] : [] } });
  });
  await page.route(`**/api/workspaces/${a.id}`, (route) =>
    route.fulfill({ json: overview() }),
  );
  await page.goto('/');
  await page.getByLabel('协作账号', { exact: true }).fill('zhangsan');
  await page.getByLabel('密码', { exact: true }).fill('test-only-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '创建工作空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建工作空间' });
  await dialog.getByLabel('工作空间名称').fill('空间 A');
  await dialog.getByRole('button', { name: '创建工作空间' }).click();
  await expect(page.getByRole('heading', { name: '产品设计师' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '技术架构师' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '研发工程师' })).toBeVisible();
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page).toHaveURL(new RegExp('workspace=' + a.id));
  await expect(
    page.getByText('模型或执行环境尚未就绪。', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '交给 T 组', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('工作台导航、成员权限与键盘焦点', async ({ page }) => {
  await authenticated(page);
  await page.route(`**/api/workspaces/${a.id}/members`, (route) =>
    route.fulfill({
      json: {
        members: [{ identityId: user.id, displayName: '张三', role: 'owner' }],
      },
    }),
  );
  await page.goto('/');
  await navigate(page, 'Agents');
  await expect(
    page.getByRole('heading', { name: '运行与交付', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '空间成员' }).click();
  const dialog = page.getByRole('dialog', { name: '空间成员 · 空间 A' });
  await expect(dialog.getByText('张三', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '移除 张三' })).toHaveCount(
    0,
  );
  await expect(dialog.getByLabel('成员 ID', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: '空间成员' })).toBeFocused();
  await page.getByRole('button', { name: '我的账号，张三' }).click();
  await expect(
    page.getByRole('dialog', { name: '我的账号' }).getByText(user.id),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('切换空间后旧慢请求不能覆盖新范围', async ({ page }) => {
  await authenticated(page);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/workspaces/${a.id}`, async (route) => {
    await held;
    await route.fulfill({ json: overview() }).catch(() => undefined);
  });
  await page.goto('/');
  const picker = page.getByLabel('工作空间', { exact: true });
  await expect(picker).toHaveValue(a.id);
  await picker.selectOption(b.id);
  await expect(page.getByText('空间 B · 创建人')).toBeVisible();
  release?.();
  await expect(page.getByRole('heading', { name: '产品设计师' })).toBeVisible();
  await expect(page.getByText('空间 A · 创建人')).toHaveCount(0);
});

test('同空间前后退保留工作台，未保存目标须确认后离开', async ({ page }) => {
  await authenticated(page);
  await page.goto('/');
  await navigate(page, 'Agents');
  await expect(
    page.getByRole('textbox', { name: '交付目标', exact: true }),
  ).toBeVisible();
  await navigate(page, '连接');
  await page.evaluate(() => window.history.back());
  await expect(
    page.getByRole('heading', { level: 1, name: 'Agents', exact: true }),
  ).toBeVisible();
  const goal = page.getByRole('textbox', { name: '交付目标', exact: true });
  await expect(goal).toBeVisible();
  await goal.fill('尚未提交的目标');
  await page
    .getByRole('textbox', { name: '验收条件', exact: true })
    .fill('保留两个长文本');
  const currentUrl = page.url();
  await page.evaluate(() => window.history.back());
  const confirmation = page.getByRole('dialog', {
    name: '放弃未保存的内容？',
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByRole('button', { name: '继续编辑', exact: true }),
  ).toBeFocused();
  await confirmation
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  await expect(page).toHaveURL(currentUrl);
  await expect(goal).toHaveValue('尚未提交的目标');
  await expect(
    page.getByRole('textbox', { name: '验收条件', exact: true }),
  ).toHaveValue('保留两个长文本');
  await page.evaluate(() => window.history.back());
  await confirmation
    .getByRole('button', { name: '放弃更改', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: '关注', exact: true }),
  ).toBeVisible();
  await expect(goal).toHaveValue('');
  await page.evaluate(() => window.history.forward());
  await expect(
    page.getByRole('heading', { level: 1, name: 'Agents', exact: true }),
  ).toBeVisible();
  await expect(goal).toBeVisible();
});

test('重新可见时发现会话撤销会清除所有空间数据', async ({ page }) => {
  await authenticated(page);
  let revoked = false;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        user: revoked ? null : user,
        login: { configured: true, label: '协作账号' },
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '产品设计师' })).toBeVisible();
  revoked = true;
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByRole('heading', { name: '登录协作工作台' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '产品设计师' })).toHaveCount(
    0,
  );
  await expect(page.getByLabel('工作空间', { exact: true })).toHaveCount(0);
});

test('移出成员先确认具体空间影响，取消不发送撤权', async ({ page }) => {
  await authenticated(page);
  let removed = false;
  const memberId = '00000000-0000-4000-8000-000000000004';
  await page.route(`**/api/workspaces/${a.id}/members`, (route) =>
    route.fulfill({
      json: {
        members: [
          { identityId: user.id, displayName: '张三', role: 'owner' },
          ...(removed
            ? []
            : [{ identityId: memberId, displayName: '李四', role: 'member' }]),
        ],
      },
    }),
  );
  await page.route(`**/api/workspaces/${a.id}/members/${memberId}`, (route) => {
    expect(route.request().method()).toBe('DELETE');
    removed = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '空间成员' }).click();
  await page.getByRole('button', { name: '移除 李四' }).click();
  const confirmation = page.getByRole('group', { name: '确认移出成员' });
  await expect(confirmation).toContainText('“李四”移出“空间 A”');
  await expect(confirmation).toContainText('失去此空间的访问权限');
  await expect(
    confirmation.getByRole('button', { name: '保留成员' }),
  ).toBeFocused();
  expect(removed).toBe(false);
  await confirmation.getByRole('button', { name: '保留成员' }).click();
  expect(removed).toBe(false);
  await page.getByRole('button', { name: '移除 李四' }).click();
  await confirmation.getByRole('button', { name: '移出空间' }).click();
  await expect(page.getByRole('status')).toContainText(
    '成员已移出当前工作空间',
  );
  expect(removed).toBe(true);
});
