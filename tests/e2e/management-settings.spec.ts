import { expect, test, type Page } from '@playwright/test';
import type {
  WorkCredentialState,
  WorkSnapshot,
} from '../../packages/core/src/index';

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  displayName: '张三',
  canCreateWorkspace: true,
};
const workspace = {
  id: '00000000-0000-4000-8000-000000000002',
  name: '设置验证空间',
  role: 'owner',
};
const entityId = '00000000-0000-4000-8000-000000000003';

type Input = Record<string, unknown> & { command: string };
type SettingsSnapshot = WorkSnapshot & { secretStates: WorkCredentialState[] };
async function fixtures(
  page: Page,
  options: {
    credentialFailsOnce?: boolean;
    configurationFailsOnce?: boolean;
    canAdmin?: boolean;
    permissions?: string[];
    seed?: Partial<SettingsSnapshot>;
    connectorReadFailsOnce?: boolean;
    connectorExpiryMs?: number;
  } = {},
) {
  const snapshot: SettingsSnapshot = {
    groups: [],
    projects: [],
    participants: [{ id: user.id, name: user.displayName, kind: 'human' }],
    teams: [],
    projectMembers: [],
    modules: [],
    documents: [],
    tasks: [],
    taskEvents: [],
    efforts: [],
    agents: [],
    sandboxes: [],
    modelChannels: [],
    roles: [],
    menus: [],
    plugins: [],
    connectors: [],
    attachments: [],
    canAdmin: options.canAdmin !== false,
    actorId: user.id,
    permissions: options.permissions || [],
    secretStates: [],
  };
  Object.assign(snapshot, options.seed || {});
  const commands: Input[] = [];
  let failedCredential = false;
  let failedConfiguration = false;
  let failedConnectorRead = false;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: { user, login: { configured: true, label: '协作账号' } },
    }),
  );
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ json: { workspaces: [workspace] } }),
  );
  await page.route(`**/api/workspaces/${workspace.id}`, (route) =>
    route.fulfill({
      json: {
        workspace,
        team: {
          id: '00000000-0000-4000-8000-000000000004',
          name: 'T 组',
          templateVersion: 1,
          ownerId: user.id,
          ownerDisplayName: user.displayName,
          agents: [],
        },
      },
    }),
  );
  await page.route(`**/api/workspaces/${workspace.id}/members`, (route) =>
    route.fulfill({
      json: {
        members: [
          { identityId: user.id, displayName: user.displayName, role: 'owner' },
        ],
      },
    }),
  );
  await page.route(`**/api/workspaces/${workspace.id}/product?*`, (route) => {
    const resource = new URL(route.request().url()).searchParams.get(
      'resource',
    );
    return route.fulfill({
      json:
        resource === 'capabilities'
          ? { skills: [], servers: [] }
          : { projects: [] },
    });
  });
  await page.route(
    `**/api/workspaces/${workspace.id}/manage`,
    async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: snapshot });
      const input = route.request().postDataJSON() as Input;
      commands.push(input);
      if (input.command === 'test-connector')
        return route.fulfill({
          json: {
            ok: true,
            checkedAt: new Date().toISOString(),
            database: {
              readOnly: true,
              serverVersion: 'fixture',
              accessibleTables: ['zt_project', 'zt_task'],
            },
            authorization: { account: 'zhangsan', visibleProjects: 2 },
          },
        });
      if (input.command === 'read-connector') {
        if (options.connectorReadFailsOnce && !failedConnectorRead) {
          failedConnectorRead = true;
          return route.fulfill({
            status: 503,
            json: { error: { message: '数据库暂不可达，请重试。' } },
          });
        }
        return route.fulfill({
          json: {
            kind: 'external-read',
            connectorId: input.id,
            checkedAt: new Date().toISOString(),
            expiresAt: new Date(
              Date.now() + (options.connectorExpiryMs || 60000),
            ).toISOString(),
            projects: [
              { id: '11', name: '授权项目甲', status: 'doing' },
              { id: '12', name: '授权项目乙', status: 'doing' },
            ],
            tasks: [
              {
                id: '51',
                projectId: input.projectId || '11',
                name: '禅道只读任务',
                status: 'doing',
                assignee: 'zhangsan',
                moduleId: null,
                estimatedHours: null,
                consumedHours: 2,
                remainingHours: null,
                deadline: null,
              },
            ],
            truncated: !input.projectId,
            tasksLoaded: true,
            source: 'zentao',
          },
        });
      }
      if (input.command === 'set-credential') {
        if (options.credentialFailsOnce && !failedCredential) {
          failedCredential = true;
          return route.fulfill({
            status: 503,
            json: { error: { message: '凭据存储暂不可用，请重试。' } },
          });
        }
        snapshot.secretStates = [
          {
            kind: input.kind as WorkCredentialState['kind'],
            id: String(input.id),
            configured: true,
            fields: Object.keys(input.values as object),
            updatedAt: new Date().toISOString(),
          },
        ];
        return route.fulfill({ json: { configured: true } });
      }
      if (input.command === 'test-model-channel')
        return route.fulfill({ json: { verified: true } });
      if (options.configurationFailsOnce && !failedConfiguration) {
        failedConfiguration = true;
        return route.fulfill({
          status: 503,
          json: { error: { message: '配置保存失败，请重试。' } },
        });
      }
      const values = Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== 'command'),
      );
      const collection =
        input.command === 'save-agent' || input.kind === 'agent'
          ? snapshot.agents
          : input.command === 'save-model-channel' ||
              input.kind === 'model-channel'
            ? snapshot.modelChannels
            : input.command === 'save-connector' || input.kind === 'connector'
              ? snapshot.connectors
              : input.command === 'save-role' || input.kind === 'role'
                ? snapshot.roles
                : snapshot.menus;
      const id = String(input.id || entityId);
      if (input.command === 'remove-configuration') {
        collection.splice(
          collection.findIndex((item) => item.id === id),
          1,
        );
        return route.fulfill({ json: {} });
      }
      const version = Number(input.version || 0) + 1;
      const index = collection.findIndex((item) => item.id === id);
      const record = { ...values, id, version };
      if (index < 0) collection.push(record as never);
      else collection[index] = record as never;
      return route.fulfill({ json: { id, version } });
    },
  );
  return { snapshot, commands };
}

test('Agent 配置失败保留输入，编辑携带版本，删除实际移除记录', async ({
  page,
}) => {
  const { commands } = await fixtures(page, { configurationFailsOnce: true });
  await page.goto(`/?view=agents&workspace=${workspace.id}`);
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click();
  const editor = page.getByRole('dialog', {
    name: '添加Agent Bot',
    exact: true,
  });
  await editor.getByLabel('名称', { exact: false }).fill('张三助手');
  await editor.getByLabel('说明', { exact: true }).fill('负责技术资料整理');
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor.getByRole('alert')).toContainText('配置保存失败');
  await expect(editor.getByLabel('名称', { exact: false })).toHaveValue(
    '张三助手',
  );
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor).toBeHidden();
  const card = page.locator('article').filter({ hasText: '张三助手' });
  await expect(card).toContainText('负责技术资料整理');
  await card.getByRole('button', { name: '配置', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑Agent Bot', exact: true });
  await edit.getByLabel('启用此配置').uncheck();
  await edit.getByRole('button', { name: '保存配置' }).click();
  await expect(card).toContainText('配置已停用');
  expect(
    commands.filter((input) => input.command === 'save-agent').at(-1),
  ).toMatchObject({ id: entityId, version: 1, enabled: false });
  await card.getByRole('button', { name: '配置', exact: true }).click();
  await page
    .getByRole('dialog', { name: '编辑Agent Bot' })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '删除Agent Bot？' })
    .getByRole('button', { name: '删除配置' })
    .click();
  await expect(card).toHaveCount(0);
  expect(commands.at(-1)).toMatchObject({
    command: 'remove-configuration',
    id: entityId,
    version: 2,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('模型密钥独立保存、失败重试不重复创建，重新编辑不回显密钥', async ({
  page,
}, testInfo) => {
  const { commands, snapshot } = await fixtures(page, {
    credentialFailsOnce: true,
  });
  await page.goto(`/?view=admin&workspace=${workspace.id}`);
  await page.getByRole('tab', { name: '大模型', exact: true }).click();
  await page.getByRole('button', { name: '添加模型渠道', exact: true }).click();
  const editor = page.getByRole('dialog', {
    name: '添加模型渠道',
    exact: true,
  });
  await editor.getByLabel('名称', { exact: false }).fill('测试模型渠道');
  await editor
    .getByLabel('渠道地址', { exact: false })
    .fill('https://model.example.test/v1');
  await editor.getByLabel('支持的模型', { exact: false }).fill('test-model');
  const password = editor.getByLabel('API Key', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await password.fill('test-only-secret');
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor.getByRole('alert')).toContainText(
    '基本配置已保存，凭据尚未保存',
  );
  await expect(password).toHaveValue('test-only-secret');
  expect(
    commands.filter((input) => input.command === 'save-model-channel'),
  ).toHaveLength(1);
  expect(commands[0]).not.toHaveProperty('apiKey');
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor).toBeHidden();
  expect(
    commands.filter((input) => input.command === 'save-model-channel'),
  ).toHaveLength(1);
  expect(
    commands.filter((input) => input.command === 'set-credential'),
  ).toHaveLength(2);
  expect(JSON.stringify(snapshot)).not.toContain('test-only-secret');
  await expect(page.getByText('已加密保存', { exact: false })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('model-channel-settings.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '测试调用', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('真实模型调用验证');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '编辑模型渠道' })
      .getByLabel('API Key', { exact: true }),
  ).toHaveValue('');
  await page
    .getByRole('dialog', { name: '编辑模型渠道' })
    .getByLabel('API Key', { exact: true })
    .fill('replacement-test-key');
  await page
    .getByRole('dialog', { name: '编辑模型渠道' })
    .getByRole('button', { name: '保存配置' })
    .click();
  await expect(page.getByRole('dialog', { name: '编辑模型渠道' })).toBeHidden();
  expect(
    commands.filter((input) => input.command === 'save-model-channel'),
  ).toHaveLength(1);
  expect(commands.at(-1)).toMatchObject({
    command: 'set-credential',
    values: { apiKey: 'replacement-test-key' },
  });
});

test('配置维护授权开放元数据表单，安全凭据与调用测试保留管理员边界', async ({
  page,
}) => {
  await fixtures(page, { canAdmin: false, permissions: ['config.manage'] });
  await page.goto(`/?view=admin&workspace=${workspace.id}`);
  await expect(
    page.getByRole('tab', { name: '人员', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('tab', { name: '角色', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '添加模型渠道', exact: true }).click();
  const editor = page.getByRole('dialog', {
    name: '添加模型渠道',
    exact: true,
  });
  await expect(editor.getByText('安全凭据', { exact: true })).toHaveCount(0);
  await editor.getByLabel('名称', { exact: false }).fill('研发渠道');
  await editor
    .getByLabel('渠道地址', { exact: false })
    .fill('https://model.example.test/v1');
  await editor.getByLabel('支持的模型', { exact: false }).fill('test-model');
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByText('研发渠道', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '测试调用', exact: true }),
  ).toHaveCount(0);
});

test('禅道账号与两类密码分别通过加密凭据命令提交', async ({ page }) => {
  const { commands, snapshot } = await fixtures(page);
  await page.goto(`/?view=connectors&workspace=${workspace.id}`);
  await page
    .getByRole('button', { name: '添加禅道连接器', exact: true })
    .click();
  const editor = page.getByRole('dialog', {
    name: '添加禅道连接器',
    exact: true,
  });
  await editor
    .getByRole('textbox', { name: '名称 *', exact: true })
    .fill('团队禅道');
  await editor
    .getByLabel('禅道地址', { exact: false })
    .fill('https://zentao.example.test');
  await editor.getByLabel('禅道账号', { exact: true }).fill('zhangsan');
  await editor
    .getByLabel('禅道密码', { exact: true })
    .fill('test-api-password');
  await editor
    .getByLabel('只读数据库密码', { exact: true })
    .fill('test-db-password');
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor).toBeHidden();
  expect(commands[0]).toMatchObject({ command: 'save-connector' });
  expect(commands[0]).not.toHaveProperty('apiPassword');
  expect(commands[0]).not.toHaveProperty('databasePassword');
  expect(commands[1]).toMatchObject({
    command: 'set-credential',
    kind: 'connector',
    id: entityId,
    values: {
      account: 'zhangsan',
      apiPassword: 'test-api-password',
      databasePassword: 'test-db-password',
    },
  });
  expect(JSON.stringify(snapshot)).not.toContain('test-db-password');
});

test('T 组三角色选择渠道模型时保存固定版本引用，界面显示模型名称', async ({
  page,
}) => {
  await fixtures(page);
  const configured: Input[] = [];
  const profiles = {
    designer: { model: '', instructions: '' },
    architect: { model: '', instructions: '' },
    engineer: { model: '', instructions: '' },
  };
  await page.route(`**/api/workspaces/${workspace.id}/product?*`, (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as Input;
      configured.push(input);
      Object.assign(profiles, input.profiles);
      return route.fulfill({ json: { saved: true } });
    }
    const resource = new URL(route.request().url()).searchParams.get(
      'resource',
    );
    const replies: Record<string, unknown> = {
      projects: {
        projects: [
          {
            id: entityId,
            externalId: '1',
            name: '授权项目',
            status: 'doing',
            canWrite: true,
          },
        ],
      },
      capabilities: { skills: [], servers: [] },
      profiles: {
        profiles,
        model: { configured: true, name: '' },
        execution: { configured: true },
        modelChannels: [
          {
            id: entityId,
            version: 4,
            name: '测试渠道',
            protocol: 'openai',
            models: ['model-a'],
            configured: true,
            enabled: true,
          },
        ],
      },
      runs: { runs: [] },
      drafts: { drafts: [] },
    };
    return route.fulfill({ json: replies[resource || ''] || {} });
  });
  await page.goto(`/?view=agents&workspace=${workspace.id}`);
  await page.getByRole('tab', { name: '运行与执行记录', exact: true }).click();
  await page.getByRole('button', { name: '配置 T 组', exact: true }).click();
  const editor = page.getByRole('dialog', {
    name: 'T 组模型与职责',
    exact: true,
  });
  for (const role of ['产品设计师', '技术架构师', '研发工程师']) {
    await editor
      .getByRole('group', { name: role, exact: true })
      .getByRole('combobox')
      .click();
    await page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
      .getByText('model-a', { exact: true })
      .click();
  }
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor).toBeHidden();
  expect(configured).toHaveLength(1);
  expect(configured[0]).toMatchObject({
    command: 'configure-team',
    profiles: {
      designer: { model: `channel:${entityId}:4:model-a` },
      architect: { model: `channel:${entityId}:4:model-a` },
      engineer: { model: `channel:${entityId}:4:model-a` },
    },
  });
  await page.getByRole('button', { name: '配置 T 组', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'T 组模型与职责' })
      .getByText('model-a', { exact: true }),
  ).toHaveCount(3);
  await expect(
    page.getByText(`channel:${entityId}:4:model-a`, { exact: true }),
  ).toHaveCount(0);
});

test('未保存的设置可继续编辑，空间成员不可访问后台配置', async ({ page }) => {
  await fixtures(page);
  await page.goto(`/?view=agents&workspace=${workspace.id}`);
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click();
  const editor = page.getByRole('dialog', {
    name: '添加Agent Bot',
    exact: true,
  });
  await editor.getByLabel('名称', { exact: false }).fill('未保存内容');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '放弃未保存的内容？' });
  await confirmation
    .getByRole('button', { name: '继续编辑', exact: true })
    .click();
  await expect(editor.getByLabel('名称', { exact: false })).toHaveValue(
    '未保存内容',
  );
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await page
    .getByRole('dialog', { name: '放弃未保存的内容？' })
    .getByRole('button', { name: '放弃更改', exact: true })
    .click();
  await expect(editor).toBeHidden();
  await fixtures(page, { canAdmin: false });
  await page.goto(`/?view=admin&workspace=${workspace.id}`);
  await expect(
    page.getByRole('heading', { name: '后台管理仅对空间管理员开放' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '添加模型渠道' })).toHaveCount(
    0,
  );
});

test('连接器按需读取保留来源、失败与过期状态，项目筛选不导入本地记录', async ({
  page,
}) => {
  const connector = {
    id: entityId,
    version: 1,
    name: '只读禅道',
    kind: 'zentao' as const,
    baseUrl: 'https://zentao.example.test',
    databaseHost: 'db.example.test',
    databasePort: 3306,
    databaseName: 'zentao',
    databaseUser: 'reader',
    credentialRef: '',
    enabled: true,
  };
  const { commands, snapshot } = await fixtures(page, {
    connectorReadFailsOnce: true,
    connectorExpiryMs: 5000,
    seed: { connectors: [connector] },
  });
  await page.clock.install();
  await page.goto(`/?view=connectors&workspace=${workspace.id}`);
  await page.getByRole('button', { name: '测试只读连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('只读数据库连接已验证');
  await page.getByRole('button', { name: '读取禅道数据', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '数据库暂不可达' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '禅道读取结果' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: '读取禅道数据', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '禅道读取结果' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: '禅道只读任务', exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: '未提供', exact: true }),
  ).toHaveCount(3);
  await expect(
    page.getByText('本次结果已达到数量上限', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: '读取项目', exact: true })
    .selectOption('12');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: '授权项目乙', exact: true }),
  ).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    command: 'read-connector',
    id: entityId,
    projectId: '12',
    limit: 100,
  });
  expect(snapshot.projects).toEqual([]);
  expect(snapshot.tasks).toEqual([]);
  await page.clock.fastForward(6000);
  await expect(page.getByRole('heading', { name: '禅道读取结果' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('status')).toContainText('上次读取已过期');
});

test('连接器凭据单独更新不改配置版本，配置变更须重新授权且清除旧证据', async ({
  page,
}) => {
  const { commands, snapshot } = await fixtures(page, {
    seed: {
      connectors: [
        {
          id: entityId,
          version: 1,
          name: '只读禅道',
          kind: 'zentao',
          baseUrl: 'https://zentao.example.test',
          databaseHost: 'db.example.test',
          databasePort: 3306,
          databaseName: 'zentao',
          databaseUser: 'reader',
          credentialRef: '',
          enabled: true,
        },
      ],
      secretStates: [
        {
          kind: 'connector',
          id: entityId,
          configured: true,
          fields: ['account', 'apiPassword', 'databasePassword'],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  });
  await page.goto(`/?view=connectors&workspace=${workspace.id}`);
  await page.getByRole('button', { name: '测试只读连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('只读数据库连接已验证');
  await page.getByRole('button', { name: '读取禅道数据', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '禅道读取结果' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑禅道连接器' });
  await editor
    .getByLabel('禅道密码', { exact: true })
    .fill('updated-api-password');
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor).toBeHidden();
  expect(
    commands.filter((input) => input.command === 'save-connector'),
  ).toHaveLength(0);
  expect(commands.at(-1)).toMatchObject({
    command: 'set-credential',
    kind: 'connector',
    id: entityId,
    values: { apiPassword: 'updated-api-password' },
  });
  expect(snapshot.connectors[0]?.version).toBe(1);
  await expect(page.getByRole('heading', { name: '禅道读取结果' })).toHaveCount(
    0,
  );
  await expect(
    page.getByText('只读连接待验证', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor
    .getByRole('textbox', { name: '名称 *', exact: true })
    .fill('新站点禅道');
  await editor
    .getByLabel('禅道密码', { exact: true })
    .fill('another-api-password');
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor.getByRole('alert')).toContainText('请同时填写禅道账号');
  expect(
    commands.filter((input) => input.command === 'save-connector'),
  ).toHaveLength(0);
  await editor.getByLabel('禅道账号', { exact: true }).fill('lisi');
  await editor
    .getByLabel('只读数据库密码', { exact: true })
    .fill('another-db-password');
  await editor.getByRole('button', { name: '保存配置' }).click();
  await expect(editor).toBeHidden();
  expect(
    commands.filter((input) => input.command === 'save-connector'),
  ).toHaveLength(1);
  expect(snapshot.connectors[0]?.version).toBe(2);
  expect(commands.at(-1)).toMatchObject({
    command: 'set-credential',
    values: {
      account: 'lisi',
      apiPassword: 'another-api-password',
      databasePassword: 'another-db-password',
    },
  });
});

test('禅道项目授权从实际空间成员选择并支持撤权', async ({ page }) => {
  const memberId = '00000000-0000-4000-8000-000000000009';
  await fixtures(page, {
    seed: {
      participants: [
        { id: user.id, name: '张三', kind: 'human' },
        { id: memberId, name: '李四', kind: 'human' },
      ],
    },
  });
  let grants: { identityId: string; displayName: string; canWrite: boolean }[] =
    [];
  const commands: Input[] = [];
  await page.route(`**/api/workspaces/${workspace.id}/product?*`, (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as Input;
      commands.push(input);
      grants =
        input.command === 'grant-project'
          ? [
              {
                identityId: String(input.identityId),
                displayName: '李四',
                canWrite: input.canWrite === true,
              },
            ]
          : [];
      return route.fulfill({ json: { saved: true } });
    }
    const resource = new URL(route.request().url()).searchParams.get(
      'resource',
    );
    const replies: Record<string, unknown> = {
      projects: {
        projects: [
          {
            id: entityId,
            externalId: '11',
            name: '授权项目',
            status: 'doing',
            canWrite: true,
          },
        ],
      },
      'available-projects': { projects: [] },
      'project-grants': { grants },
      connection: {
        connection: { label: '测试禅道', kind: 'zentao' },
        authorization: { displayName: '张三', status: 'authorized' },
      },
    };
    return route.fulfill({ json: replies[resource || ''] || {} });
  });
  await page.goto(`/?view=connectors&workspace=${workspace.id}`);
  await page.getByRole('tab', { name: '禅道项目连接', exact: true }).click();
  await page
    .getByRole('combobox', { name: '空间成员', exact: true })
    .selectOption(memberId);
  await page.getByLabel('允许提交写入草案', { exact: true }).check();
  await page.getByRole('button', { name: '保存项目授权', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '撤销 李四', exact: true }),
  ).toBeVisible();
  expect(commands[0]).toMatchObject({
    command: 'grant-project',
    projectId: entityId,
    identityId: memberId,
    canWrite: true,
  });
  await page.getByRole('button', { name: '撤销 李四', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '尚无成员授权记录', exact: true }),
  ).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    command: 'revoke-project',
    projectId: entityId,
    identityId: memberId,
  });
});

test('Agent 筛选与模型渠道选择保持协议和模型一致', async ({ page }) => {
  const channelId = '00000000-0000-4000-8000-000000000007';
  const { commands } = await fixtures(page, {
    seed: {
      agents: [
        {
          id: '00000000-0000-4000-8000-000000000008',
          version: 1,
          name: '资料助手',
          description: '技术文档',
          avatar: '资',
          teamId: null,
          modelChannelId: null,
          model: '',
          protocol: 'openai',
          sandboxId: null,
          skillIds: [],
          mcpServerIds: [],
          enabled: true,
        },
      ],
      modelChannels: [
        {
          id: channelId,
          version: 1,
          name: '团队 Anthropic',
          baseUrl: 'https://model.example.test',
          protocol: 'anthropic',
          models: ['claude-fixture'],
          credentialRef: '',
          enabled: true,
        },
      ],
    },
  });
  await page.goto(`/?view=agents&workspace=${workspace.id}`);
  await page
    .getByRole('textbox', { name: '搜索 Agent', exact: true })
    .fill('不存在');
  await expect(
    page.getByRole('heading', { name: '没有匹配的 Agent', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: '搜索 Agent', exact: true })
    .fill('技术');
  await expect(
    page.getByRole('heading', { name: '资料助手', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click();
  const editor = page.getByRole('dialog', {
    name: '添加Agent Bot',
    exact: true,
  });
  await editor
    .getByRole('textbox', { name: '名称 *', exact: true })
    .fill('研发助手');
  await editor
    .getByRole('combobox', { name: '模型渠道', exact: true })
    .selectOption(channelId);
  await expect(editor.getByRole('combobox', { name: /^协议/ })).toHaveValue(
    'anthropic',
  );
  await expect(editor.getByRole('combobox', { name: /^协议/ })).toBeDisabled();
  await expect(
    editor.getByRole('combobox', { name: '模型标识 *', exact: true }),
  ).toHaveValue('claude-fixture');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor).toBeHidden();
  expect(commands.at(-1)).toMatchObject({
    command: 'save-agent',
    modelChannelId: channelId,
    protocol: 'anthropic',
    model: 'claude-fixture',
  });
});
