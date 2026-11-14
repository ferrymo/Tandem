import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  InstalledSkill,
  McpServer,
  WorkSnapshot,
} from '../packages/core/src/index.js';
import * as data from './seed-work-management-data.js';

// This command writes business data only through the normal authenticated HTTP API.
// It never fabricates an identity/session, edits an existing upstream user, or executes Agents.
type Row = { key: string; id: string; [field: string]: unknown };
type Collection =
  | 'groups'
  | 'projects'
  | 'modules'
  | 'projectMembers'
  | 'teams'
  | 'agents'
  | 'roles'
  | 'tasks'
  | 'documents'
  | 'menus'
  | 'modelChannels'
  | 'sandboxes'
  | 'connectors'
  | 'plugins';
type Person = {
  key: data.ActorKey;
  id: string;
  name: string;
  account: string;
  credentialEnv?: { account: string; password: string };
};
type Manifest = Record<Collection, Row[]> & {
  schemaVersion: 1;
  fixtureKey: string;
  asOfDate: string;
  identityProviderId: string;
  baseUrl: string;
  identityBaseUrl: string;
  workspace: { id: string; name: string; requestId: string };
  owner: { id: string; name: string; accountEnv: string; passwordEnv: string };
  members: Person[];
  skills: Row[];
  mcpServers: Row[];
  attachments: Row[];
  efforts: Row[];
  createdAt: string;
  completedAt?: string;
  expectations?: Record<string, unknown>;
  progress: {
    inputs: Record<string, string>;
    comments: Record<string, string>;
    effortBatches: Record<string, string>;
  };
};
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'data/work-fixture/manifest.json');
const credentialPath = resolve(root, '.env.work-fixture.local');
const mode = process.argv[2] ?? '--plan';
assert(['--plan', '--apply'].includes(mode), '使用 --plan 或 --apply');
const base = new URL(process.env.TANDEM_PUBLIC_URL ?? 'http://127.0.0.1:3000');
const upstream = new URL(process.env.TANDEM_IDENTITY_URL ?? '');
assert(
  base.origin === 'http://127.0.0.1:3000' && base.pathname === '/',
  '仅允许明确的本机 Tandem :3000',
);
assert(
  upstream.origin === 'http://127.0.0.1:8088' && upstream.pathname === '/',
  '仅允许明确的本机禅道 :8088；拒绝其他环境',
);
assert(
  !base.username &&
    !base.password &&
    !base.search &&
    !base.hash &&
    !upstream.username &&
    !upstream.password &&
    !upstream.search &&
    !upstream.hash,
);
const prefix = `${data.fixtureKey}:`;
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const identityProviderId = `${process.env.TANDEM_IDENTITY_ID}:${digest(upstream.href).slice(0, 32)}`;
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(
      value
        .map((item) => JSON.parse(canonical(item)))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, JSON.parse(canonical(item))]),
      ),
    );
  return JSON.stringify(value);
}
function uuid(key: string) {
  const bytes = Buffer.from(digest(prefix + key).slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const collections: Collection[] = [
  'groups',
  'projects',
  'modules',
  'projectMembers',
  'teams',
  'agents',
  'roles',
  'tasks',
  'documents',
  'menus',
  'modelChannels',
  'sandboxes',
  'connectors',
  'plugins',
];
function checkPlan() {
  assert.equal(data.tasks.length, 36);
  assert.equal(data.documents.length, 12);
  assert.equal(data.efforts.length, 34);
  assert.equal(
    data.efforts.reduce((sum, entry) => sum + entry.hours, 0),
    188,
  );
  const daily = new Map<string, number>();
  for (const effort of data.efforts) {
    const task = data.tasks.find((item) => item.key === effort.task)!;
    assert(
      task && effort.date <= '2026-11-13' && effort.date >= task.actualStart!,
    );
    if (task.actualEnd) assert(effort.date <= task.actualEnd);
    const key = `${effort.actor}:${effort.date}`;
    daily.set(key, (daily.get(key) ?? 0) + effort.hours);
    assert(daily.get(key)! <= 24, '任何人同日合计不得超过24小时');
  }
  assert.deepEqual(
    Object.fromEntries(
      [
        'not_started',
        'in_progress',
        'completed',
        'closed',
        'paused',
        'cancelled',
      ].map((status) => [
        status,
        data.tasks.filter((task) => task.status === status).length,
      ]),
    ),
    {
      not_started: 10,
      in_progress: 9,
      completed: 6,
      closed: 5,
      paused: 3,
      cancelled: 3,
    },
  );
}
checkPlan();
if (mode === '--plan') {
  console.log(
    JSON.stringify(
      {
        fixture: data.fixtureKey,
        workspace: data.workspaceName,
        groups: data.groups.length,
        projects: data.projects.length,
        modules: data.projects.length * 2,
        people: data.people.length,
        tasks: data.tasks.length,
        documents: data.documents.length,
        attachments: data.attachments.length,
        effortEntries: data.efforts.length,
        effortHours: 188,
        window: data.window,
        note: '仅检查静态场景，未登录或写入；使用 --apply 才创建本机专属测试账号与工作空间。',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

async function optional(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function atomic(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.pending';
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}
const lockPath = output + '.lock';
await mkdir(dirname(output), { recursive: true });
const priorLock = await optional(lockPath);
if (priorLock) {
  const pid = Number(priorLock);
  assert(Number.isInteger(pid) && pid > 0, 'seed锁无效，请人工检查');
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    else throw error;
  }
  assert(!alive, '另一个seed仍在执行');
  await unlink(lockPath);
}
const lock = await open(lockPath, 'wx', 0o600);
await lock.writeFile(String(process.pid));
await lock.close();
let manifest: Manifest;
const clients = new Map<data.ActorKey, Client>();
class Client {
  cookie = '';
  constructor(readonly key: data.ActorKey) {}
  async request(
    path: string,
    payload?: unknown,
    method = payload === undefined ? 'GET' : 'POST',
  ) {
    const form = payload instanceof FormData;
    const response = await fetch(new URL(path, base.origin), {
      method,
      redirect: 'error',
      headers: {
        Origin: base.origin,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(payload === undefined || form
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(payload === undefined
        ? {}
        : { body: form ? payload : JSON.stringify(payload) }),
      signal: AbortSignal.timeout(30000),
    });
    const cookies = response.headers
      .getSetCookie()
      .filter((item) => /^(?:__Host-)?tandem_session=/.test(item));
    if (cookies.length)
      this.cookie = cookies.map((item) => item.split(';')[0]).join('; ');
    return response;
  }
  async json<T>(path: string, payload?: unknown): Promise<T> {
    const response = await this.request(path, payload);
    // Do not print provider errors, request bodies, passwords, tokens or cookies.
    assert(response.ok, `${this.key}: HTTP ${response.status} ${path}`);
    return response.json() as Promise<T>;
  }
  async login(account: string, password: string) {
    return this.json<{
      user: { id: string; displayName: string; canCreateWorkspace: boolean };
    }>('/api/session', { account, password });
  }
  snapshot() {
    return this.json<WorkSnapshot>(
      `/api/workspaces/${manifest.workspace.id}/manage`,
    );
  }
  command(command: string, value: Record<string, unknown>) {
    return this.json<{ id: string; version?: number }>(
      `/api/workspaces/${manifest.workspace.id}/manage`,
      { command, ...value },
    );
  }
}
const saveManifest = () =>
  atomic(output, JSON.stringify(manifest, null, 2) + '\n');
const id = (collection: Collection, key: string) => {
  const item = manifest[collection].find((row) => row.key === key);
  assert(item, `缺少关联: ${collection}/${key}`);
  return item.id;
};
const person = (key: data.ActorKey) =>
  key === 'owner'
    ? manifest.owner.id
    : manifest.members.find((item) => item.key === key)!.id;
function same(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  return Object.entries(expected).every(
    ([key, value]) => canonical(actual[key]) === canonical(value),
  );
}
async function ensure(
  collection: Collection,
  key: string,
  command: string,
  expected: Record<string, unknown>,
  actor: data.ActorKey = 'owner',
) {
  expected = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.trim() : value,
    ]),
  );
  const client = clients.get(actor)!;
  const snapshot = await client.snapshot();
  const records = snapshot[collection] as unknown as Record<string, unknown>[];
  const tracked = manifest[collection].find((item) => item.key === key);
  const inputHash = digest(canonical(expected));
  assert(
    !manifest.progress.inputs[`${collection}:${key}`] ||
      manifest.progress.inputs[`${collection}:${key}`] === inputHash,
    `场景输入已改变，拒绝覆盖 ${collection}/${key}`,
  );
  let actual = tracked
    ? records.find((row) => row.id === tracked.id)
    : records.find((row) => same(row, expected));
  if (tracked) {
    assert(actual, `记录已被删除/撤权，停止续跑: ${collection}/${key}`);
    assert(
      same(actual, expected),
      `检测到人工修改，停止覆盖: ${collection}/${key}`,
    );
  }
  if (!actual) {
    const result = await client.command(command, expected);
    actual = (await client.snapshot())[collection].find(
      (row) => row.id === result.id,
    ) as unknown as Record<string, unknown>;
    assert(
      actual && same(actual, expected),
      `保存回读不一致: ${collection}/${key}`,
    );
  }
  if (!tracked)
    manifest[collection].push({ key, ...actual, id: String(actual.id) });
  manifest.progress.inputs[`${collection}:${key}`] = inputHash;
  await saveManifest();
  return String(actual.id);
}
async function upstreamRequest(path: string, token: string, payload?: unknown) {
  const form = payload instanceof URLSearchParams;
  return fetch(new URL('/api.php/v1' + path, upstream), {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      Token: token,
      ...(payload === undefined
        ? {}
        : {
            'Content-Type': form
              ? 'application/x-www-form-urlencoded'
              : 'application/json',
          }),
    },
    ...(payload === undefined
      ? {}
      : { body: form ? payload : JSON.stringify(payload) }),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
}
async function preparePeople(ownerAccount: string, ownerPassword: string) {
  const response = await fetch(new URL('/api.php/v1/tokens', upstream), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: ownerAccount, password: ownerPassword }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 201, '本机禅道admin真实登录失败');
  const auth = (await response.json()) as { token: string };
  assert(typeof auth.token === 'string');
  const saved = await optional(credentialPath);
  const vars: Record<string, string> = {};
  if (saved) {
    for (const line of saved.split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index > 0) vars[line.slice(0, index)] = line.slice(index + 1);
    }
    assert.equal(
      vars.TANDEM_FIXTURE_KEY,
      data.fixtureKey,
      '凭据文件属于其他fixture，拒绝覆盖',
    );
  } else {
    vars.TANDEM_FIXTURE_KEY = data.fixtureKey;
    for (const item of data.people) {
      const env = `TANDEM_FIXTURE_${item.key.toUpperCase()}`;
      vars[env + '_ACCOUNT'] =
        `td261114_${digest(data.fixtureKey).slice(0, 4)}_${item.key}`;
      vars[env + '_PASSWORD'] = randomBytes(24).toString('base64url') + '!aA7';
    }
    await atomic(
      credentialPath,
      '# Local fixture credentials. Ignored by Git. Never copy into reports.\n' +
        Object.entries(vars)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n') +
        '\n',
    );
  }
  for (const item of data.people) {
    const env = `TANDEM_FIXTURE_${item.key.toUpperCase()}`,
      account = vars[env + '_ACCOUNT']!,
      password = vars[env + '_PASSWORD']!;
    assert(
      account && password && /^td261114_[a-f0-9]{4}_[a-z]+$/.test(account),
    );
    const existing = await upstreamRequest(
      '/users/' + encodeURIComponent(account),
      auth.token,
    );
    if (existing.status === 404) {
      // The installed local patch recomputes password strength from passwordPlain.
      // Form POST preserves it in $_POST; the v1 JSON whitelist omits that field.
      const created = await upstreamRequest(
        '/users',
        auth.token,
        new URLSearchParams({
          account,
          password,
          passwordPlain: password,
          realname: item.name,
          gender: 'm',
          type: 'inside',
          dept: '0',
          role: 'dev',
        }),
      );
      assert.equal(
        created.status,
        201,
        `创建本机专属测试账号失败: ${item.key}`,
      );
    } else {
      assert(existing.ok, `查询本机测试账号失败: ${item.key}`);
      const profile = (await existing.json()) as {
        account: string;
        realname: string;
      };
      assert(
        profile.account === account && profile.realname === item.name,
        `账号已被其他人占用，拒绝修改: ${item.key}`,
      );
      assert(saved, `首次运行发现已有同名账号，拒绝接管: ${item.key}`);
    }
    const client = new Client(item.key);
    const login = await client.login(account, password);
    clients.set(item.key, client);
    const old = manifest.members.find((row) => row.key === item.key);
    assert(!old || old.id === login.user.id, `成员身份发生变化: ${item.key}`);
    if (!old)
      manifest.members.push({
        key: item.key,
        name: item.name,
        id: login.user.id,
        account,
        credentialEnv: {
          account: env + '_ACCOUNT',
          password: env + '_PASSWORD',
        },
      });
    await saveManifest();
  }
}

try {
  const account = process.env.ZT_ACC,
    password = process.env.ZT_PWD;
  assert(
    account === 'admin' && password,
    '必须加载ignored .env.zentao.local 的真实本机admin凭据',
  );
  const owner = new Client('owner');
  const login = await owner.login(account, password);
  clients.set('owner', owner);
  assert(login.user.canCreateWorkspace, 'owner无创建工作空间权限');
  const saved = await optional(output);
  const emptyCollections = Object.fromEntries(
    collections.map((key) => [key, []]),
  ) as unknown as Record<Collection, Row[]>;
  manifest = saved
    ? (JSON.parse(saved) as Manifest)
    : {
        schemaVersion: 1,
        fixtureKey: data.fixtureKey,
        asOfDate: '2026-11-14',
        baseUrl: base.origin,
        identityBaseUrl: upstream.href,
        identityProviderId,
        workspace: {
          id: '',
          name: data.workspaceName,
          requestId: uuid('workspace:' + login.user.id + ':' + upstream.href),
        },
        owner: {
          id: login.user.id,
          name: login.user.displayName,
          accountEnv: 'ZT_ACC',
          passwordEnv: 'ZT_PWD',
        },
        members: [],
        ...emptyCollections,
        skills: [],
        mcpServers: [],
        attachments: [],
        efforts: [],
        createdAt: new Date().toISOString(),
        progress: { inputs: {}, comments: {}, effortBatches: {} },
      };
  assert(
    manifest.schemaVersion === 1 &&
      manifest.fixtureKey === data.fixtureKey &&
      manifest.baseUrl === base.origin &&
      manifest.identityBaseUrl === upstream.href &&
      manifest.identityProviderId === identityProviderId &&
      manifest.owner.id === login.user.id,
    'manifest环境/owner不匹配',
  );
  if (!manifest.workspace.id) {
    const result = await owner.json<{
      workspace: { id: string; name: string };
    }>('/api/workspaces', {
      name: manifest.workspace.name,
      requestId: manifest.workspace.requestId,
    });
    assert.equal(result.workspace.name, manifest.workspace.name);
    manifest.workspace.id = result.workspace.id;
    await saveManifest();
  } else {
    const result = await owner.json<{
      workspace: { id: string; name: string; role: string };
    }>(`/api/workspaces/${manifest.workspace.id}`);
    assert(
      result.workspace.id === manifest.workspace.id &&
        result.workspace.name === data.workspaceName &&
        result.workspace.role === 'owner',
      '测试空间标识或所有者不符',
    );
  }
  await preparePeople(account, password);
  const members = await owner.json<{
    members: { identityId: string; role: string }[];
  }>(`/api/workspaces/${manifest.workspace.id}/members`);
  for (const member of manifest.members) {
    const existing = members.members.find(
      (row) => row.identityId === member.id,
    );
    assert(
      !existing || existing.role === 'member',
      `检测到人工修改成员角色: ${member.key}`,
    );
    if (!existing)
      await owner.json(`/api/workspaces/${manifest.workspace.id}/members`, {
        identityId: member.id,
        role: 'member',
      });
  }
  for (const [index, group] of data.groups.entries())
    await ensure('groups', group.key, 'save-project-group', {
      name: group.name,
      parentId: group.parent ? id('groups', group.parent) : null,
      sortOrder: index * 10,
    });
  for (const item of data.projects) {
    const projectId = await ensure('projects', item.key, 'save-project', {
      name: item.name,
      description:
        item.description +
        '\n\n测试空间专属虚构业务；无真实客户、费用、部署或模型调用。',
      groupId: id('groups', item.group),
      stage: item.stage,
      ownerId: person('owner'),
      initiatedOn: item.initiatedOn,
      launchOn: item.launchOn,
      acceptanceOn: item.acceptanceOn,
      maintenanceUntil: item.maintenanceUntil,
      plannedDays: item.plannedDays,
      plannedAmount: item.plannedAmount,
      repositoryUrl: 'https://example.com/tandem-fixture/' + item.key,
      deploymentTarget: '本机测试配置（未部署）',
      deploymentBranch: 'fixture/main',
      deploymentCommand: 'pnpm build',
    });
    for (const [index, name] of item.modules.entries())
      await ensure('modules', `${item.key}:${index}`, 'save-module', {
        projectId,
        name,
        description: `${item.name}的${name}；仅用于产品业务验收。`,
      });
    for (const [actor, role] of [
      ['zhangsan', '研发'],
      ['lisi', '研发'],
      ['wangwu', '策划'],
      ['zhaoliu', '学术'],
      ['owner', '项目经理'],
      ['owner', '销售'],
      ['zhangsan', '测试负责人'],
      ['wangwu', '运营'],
    ] as const)
      if (!(
        actor === 'zhaoliu' &&
        ['launched', 'closed', 'cancelled'].includes(item.key)
      ))
        await ensure(
          'projectMembers',
          `${item.key}:${actor}:${role}`,
          'save-project-member',
          { projectId, participantId: person(actor), role, canWrite: true },
        );
  }
  await ensure('teams', 'delivery-team', 'save-team', {
    name: '产品交付组',
    description: '负责需求、研发、体验与交付；Agent通过所属团队配置关联。',
    memberIds: ['owner', 'zhangsan', 'lisi', 'wangwu'].map((key) =>
      person(key as data.ActorKey),
    ),
  });
  await ensure('teams', 'research-team', 'save-team', {
    name: '学术研究组',
    description: '负责学术术语、资料规范与研究；赵六本周尚未排期。',
    memberIds: [person('owner'), person('zhaoliu')],
  });
  await ensure('modelChannels', 'local-model', 'save-model-channel', {
    name: '本机模型渠道（未连接）',
    baseUrl: 'http://127.0.0.1:11434',
    protocol: 'ollama',
    models: ['fixture-model-not-installed'],
    credentialRef: '',
    enabled: false,
  });
  await ensure('sandboxes', 'node-sandbox', 'save-sandbox', {
    name: 'Node 隔离模板（未启动）',
    image: 'node:24-alpine',
    workdir: '/workspace',
    networkPolicy: 'none',
    cpu: 1,
    memoryMb: 1024,
    enabled: false,
  });
  await ensure('connectors', 'zentao-local', 'save-connector', {
    name: '本机禅道只读配置（待授权）',
    kind: 'zentao',
    baseUrl: upstream.href.replace(/\/$/, ''),
    databaseHost: '127.0.0.1',
    databasePort: 3306,
    databaseName: 'zentao',
    databaseUser: 'fixture_readonly_not_created',
    credentialRef: '',
    enabled: false,
  });
  await ensure('plugins', 'report-export', 'save-plugin', {
    name: '周报导出插件（未加载）',
    description: '固定版本注册示例，尚未安装第三方执行代码。',
    source: 'https://example.com/tandem-fixture/report-export',
    pinnedVersion: '1.0.0',
    enabled: false,
  });
  const product = `/api/workspaces/${manifest.workspace.id}/product`;
  const capabilities = await owner.json<{
    skills: InstalledSkill[];
    servers: McpServer[];
  }>(product + '?resource=capabilities');
  const skillBundle = {
    name: 'fixture-delivery-checklist',
    version: '1.0.0',
    description: '本地固定版本交付核对规范；仅提供指引，未执行脚本。',
    source: { kind: 'upload', label: 'Tandem本机验收固定包 v1.0.0' },
    permissions: [],
    dependencies: [],
    files: {
      'SKILL.md':
        '---\nname: fixture-delivery-checklist\ndescription: Review project delivery evidence without executing external actions.\n---\n\n核对任务模块、负责人、版本、测试证据和待决策事项。任何部署必须走已批准草案。\n',
      'checklist.md':
        '# 交付核对\n\n- 范围与模块\n- 版本与证据\n- 待决策事项\n- 发布与回滚记录\n',
    },
  };
  let skill = capabilities.skills.find(
    (item) => item.name === skillBundle.name,
  );
  if (!skill)
    skill = await owner.json<InstalledSkill>(product, {
      command: 'install-skill',
      bundle: skillBundle,
    });
  assert(
    skill.versions.some(
      (version) =>
        version.version === skillBundle.version &&
        canonical(version.files) === canonical(skillBundle.files),
    ),
    '技能包被修改，拒绝覆盖',
  );
  if (!manifest.skills.length) {
    manifest.skills.push({ key: 'delivery-checklist', ...skill });
    await saveManifest();
  }
  const serverName = '本机知识工具（未连接）';
  let server = capabilities.servers.find((item) => item.name === serverName);
  if (!server)
    server = await owner.json<McpServer>(product, {
      command: 'save-server',
      name: serverName,
      connection: { type: 'http', url: 'http://127.0.0.1:3999/mcp' },
    });
  assert(
    server.status === 'untested' &&
      server.tools.length === 0 &&
      server.connection.type === 'http' &&
      server.connection.url === 'http://127.0.0.1:3999/mcp',
    'MCP配置已被人工测试/修改，拒绝覆盖',
  );
  if (!manifest.mcpServers.length) {
    manifest.mcpServers.push({ key: 'local-mcp', ...server });
    await saveManifest();
  }
  for (const [key, name, team] of [
    ['agent-design', '方案助手', 'delivery-team'],
    ['agent-code', '代码助手', 'delivery-team'],
    ['agent-research', '资料助手', 'research-team'],
  ] as const) {
    await ensure('agents', key, 'save-agent', {
      name,
      description:
        '虚构协作Agent配置已启用供项目选人；模型/沙箱禁用，关联固定版本技能与未连接工具，未实际执行。',
      avatar: '',
      teamId: id('teams', team),
      modelChannelId: id('modelChannels', 'local-model'),
      model: 'fixture-model-not-installed',
      protocol: 'ollama',
      sandboxId: id('sandboxes', 'node-sandbox'),
      skillIds: [skill.id],
      mcpServerIds: [server.id],
      enabled: true,
    });
    await ensure('projectMembers', `executing:${key}`, 'save-project-member', {
      projectId: id('projects', 'executing'),
      participantId: id('agents', key),
      role:
        key === 'agent-design'
          ? '策划'
          : key === 'agent-code'
            ? '研发'
            : '学术',
      canWrite: false,
    });
  }
  for (const item of data.tasks)
    await ensure('tasks', item.key, 'save-task', {
      projectId: id('projects', item.project),
      moduleId: id('modules', `${item.project}:${item.module}`),
      name: item.name,
      description:
        '虚构业务验收任务。历史计划、日期与工时按测试场景导入；创建与操作审计保留真实导入时间。' +
        (item.key === 'desk-urgent'
          ? ' 临时任务无计划；王五作为协助人实际填报5小时，不能归给执行人李四。'
          : ''),
      assigneeId:
        item.assignee === 'agent-code'
          ? id('agents', 'agent-code')
          : item.assignee
            ? person(item.assignee)
            : null,
      collaboratorIds: item.collaborators.map(person),
      plannedStart: item.plannedStart,
      plannedEnd: item.plannedEnd,
      plannedHours: item.plannedHours,
      actualStart: item.actualStart,
      actualEnd: item.actualEnd,
      status: item.status,
      cancellationReason: item.cancellationReason,
    });
  for (const item of data.documents)
    await ensure(
      'documents',
      item.key,
      'save-document',
      {
        title: item.title,
        body:
          item.body + '\n\n---\n本文件属于独立测试空间，内容为虚构验收资料。\n',
        scope: item.scope,
        projectId: item.project ? id('projects', item.project) : null,
        teamId: item.team ? id('teams', item.team) : null,
        visibility: item.visibility,
      },
      item.actor,
    );
  for (const item of data.attachments) {
    const client = clients.get(item.actor)!,
      content = Buffer.from(
        '虚构验收材料，仅用于 Tandem 本机测试。\n\n' + item.content,
        'utf8',
      );
    const target = item.task
      ? { taskId: id('tasks', item.task) }
      : { documentId: id('documents', item.document!) };
    const tracked = manifest.attachments.find((row) => row.key === item.key);
    let attachment = (await client.snapshot()).attachments.find((row) =>
      tracked
        ? row.id === tracked.id
        : row.name === item.name &&
          row.taskId === (item.task ? target.taskId : null) &&
          row.documentId === (item.document ? target.documentId : null),
    );
    if (tracked) assert(attachment, `附件被删除/撤权: ${item.key}`);
    if (!attachment) {
      const form = new FormData();
      form.set(
        'file',
        new Blob([content], { type: 'application/octet-stream' }),
        item.name,
      );
      for (const [key, value] of Object.entries(target)) form.set(key, value!);
      attachment = await client.json(
        `/api/workspaces/${manifest.workspace.id}/attachments`,
        form,
      );
    }
    const downloaded = await client.request(
      `/api/workspaces/${manifest.workspace.id}/attachments/${attachment!.id}`,
    );
    assert(downloaded.ok);
    assert.equal(
      digest(Buffer.from(await downloaded.arrayBuffer()).toString('base64')),
      digest(content.toString('base64')),
      `附件内容被修改: ${item.key}`,
    );
    if (!tracked) {
      manifest.attachments.push({
        key: item.key,
        ...attachment!,
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.byteLength,
        target,
      });
      await saveManifest();
    }
  }
  const commentTask = id('tasks', 'desk-api'),
    comment =
      '验收导入说明：当前显示的是虚构项目的业务计划与历史填报，操作审计时间为实际导入时间；没有执行模型、部署或外部任务写入。';
  const previousComment = (await owner.snapshot()).taskEvents.find(
    (event) =>
      event.taskId === commentTask &&
      event.kind === 'comment' &&
      event.body === comment,
  );
  if (!previousComment) {
    assert(!manifest.progress.comments.import, '导入备注被删除，停止续跑');
    const result = await owner.command('add-task-comment', {
      taskId: commentTask,
      body: comment,
    });
    manifest.progress.comments.import = result.id;
    await saveManifest();
  }
  for (const actor of data.people) {
    const entries = data.efforts
      .filter((item) => item.actor === actor.key)
      .map((item) => ({
        taskId: id('tasks', item.task),
        date: item.date,
        hours: item.hours,
        note: item.note,
      }));
    if (!entries.length) continue;
    const requestId = uuid('efforts:' + actor.key),
      hash = digest(canonical(entries));
    assert(
      !manifest.progress.effortBatches[actor.key] ||
        manifest.progress.effortBatches[actor.key] === hash,
      '工时输入变化，拒绝覆盖旧批次',
    );
    await clients
      .get(actor.key)!
      .command('log-efforts', { requestId, entries });
    manifest.progress.effortBatches[actor.key] = hash;
    await saveManifest();
  }
  for (const [key, label, index] of [
    ['projects', '项目', 0],
    ['documents', '文档', 1],
    ['tasks', '任务', 2],
    ['analysis', '分析', 3],
    ['agents', 'Agents', 4],
    ['connectors', '连接器', 5],
    ['admin', '后台管理', 6],
  ] as const)
    await ensure('menus', key, 'save-menu', {
      key,
      label,
      visible: true,
      sortOrder: index * 10,
    });
  await ensure('roles', 'delivery-members', 'save-role', {
    name: '交付成员',
    description: '可管理已获授权项目、文档；不能越过项目ACL或管理空间角色。',
    permissions: ['project.create', 'project.manage', 'document.manage'],
    memberIds: ['zhangsan', 'lisi', 'wangwu'].map((key) =>
      person(key as data.ActorKey),
    ),
    enabled: true,
  });
  await ensure('roles', 'research-members', 'save-role', {
    name: '研究成员',
    description: '可维护授权项目和资料；没有团队或后台配置管理权限。',
    permissions: ['project.manage', 'document.manage'],
    memberIds: [person('zhaoliu')],
    enabled: true,
  });
  const snapshots = new Map<data.ActorKey, WorkSnapshot>();
  for (const [actor, client] of clients)
    snapshots.set(actor, await client.snapshot());
  const final = snapshots.get('owner')!;
  for (const collection of collections) {
    if (collection === 'documents') {
      for (const record of manifest.documents) {
        const actual = [...snapshots.values()]
          .flatMap((snapshot) => snapshot.documents)
          .find((row) => row.id === record.id);
        assert(actual, '文档不可见或已被删除');
        Object.assign(record, actual);
      }
    } else {
      const records = final[collection] as unknown as { id: string }[];
      assert.equal(
        records.length,
        manifest[collection].length,
        `检测到测试空间额外/缺失记录: ${collection}`,
      );
      for (const record of manifest[collection])
        Object.assign(
          record,
          records.find((row) => row.id === record.id),
        );
    }
  }
  manifest.efforts = final.efforts.map((entry) => ({
    key: `${entry.actorId}:${entry.taskId}:${entry.date}`,
    ...entry,
  }));
  assert.equal(manifest.efforts.length, 34);
  assert.equal(
    final.efforts.reduce((sum, entry) => sum + entry.hours, 0),
    188,
  );
  for (const task of final.tasks)
    assert.equal(
      task.actualHours,
      final.efforts
        .filter((effort) => effort.taskId === task.id)
        .reduce((sum, effort) => sum + effort.hours, 0),
      `任务工时余额不一致: ${task.id}`,
    );
  const planned = (actorId: string) =>
    data.tasks
      .filter(
        (task) =>
          task.assignee !== null &&
          task.status !== 'cancelled' &&
          task.plannedStart === data.window.from &&
          task.plannedEnd === data.window.to &&
          task.assignee !== 'agent-code' &&
          person(task.assignee as data.ActorKey) === actorId,
      )
      .reduce((sum, task) => sum + (task.plannedHours ?? 0), 0);
  const actual = (actorId: string) =>
    final.efforts
      .filter(
        (entry) =>
          entry.actorId === actorId &&
          entry.date >= data.window.from &&
          entry.date <= data.window.to,
      )
      .reduce((sum, entry) => sum + entry.hours, 0);
  const actorKeys: data.ActorKey[] = [
    'owner',
    ...data.people.map((item) => item.key),
  ];
  const permissions = {
    owner: [
      'project.create',
      'project.manage',
      'document.manage',
      'team.manage',
      'agent.manage',
      'config.manage',
    ],
    zhangsan: ['project.create', 'project.manage', 'document.manage'],
    lisi: ['project.create', 'project.manage', 'document.manage'],
    wangwu: ['project.create', 'project.manage', 'document.manage'],
    zhaoliu: ['project.manage', 'document.manage'],
  };
  const visibleDocuments: Record<string, string[]> = {};
  for (const actor of actorKeys) {
    const actorId = person(actor);
    visibleDocuments[actor] = manifest.documents
      .filter((document) => {
        if (document.visibility === 'private' || document.scope === 'personal')
          return document.ownerId === actorId;
        if (document.scope === 'project')
          return (
            actor === 'owner' ||
            manifest.projectMembers.some(
              (member) =>
                member.projectId === document.projectId &&
                member.participantId === actorId,
            )
          );
        return (
          actor === 'owner' ||
          (
            manifest.teams.find((team) => team.id === document.teamId)!
              .memberIds as string[]
          ).includes(actorId)
        );
      })
      .map((document) => document.id);
    assert.deepEqual(
      snapshots
        .get(actor)!
        .documents.map((document) => document.id)
        .sort(),
      [...visibleDocuments[actor]!].sort(),
      `文档ACL不符合场景: ${actor}`,
    );
  }
  for (const attachment of manifest.attachments)
    attachment.visibleTo = actorKeys.filter((actor) => {
      const target = attachment.target as {
        taskId?: string;
        documentId?: string;
      };
      return target.taskId
        ? true
        : visibleDocuments[actor]!.includes(target.documentId!);
    });
  const dailyEfforts = [
    ...new Set(final.efforts.map((entry) => `${entry.actorId}:${entry.date}`)),
  ].map((key) => {
    const [actorId, date] = key.split(':');
    const hours = final.efforts
      .filter((entry) => entry.actorId === actorId && entry.date === date)
      .reduce((sum, entry) => sum + entry.hours, 0);
    assert(hours <= 24);
    return {
      actorId,
      actor: actorKeys.find((actor) => person(actor) === actorId),
      date,
      hours,
    };
  });
  manifest.expectations = {
    counts: Object.fromEntries(
      [...collections, 'efforts', 'attachments'].map((collection) => [
        collection,
        (final[collection as keyof WorkSnapshot] as unknown[]).length,
      ]),
    ),
    visibleProjectIdsByActor: Object.fromEntries(
      actorKeys.map((actor) => [
        actor,
        final.projects
          .filter(
            (project) =>
              actor === 'owner' ||
              manifest.projectMembers.some(
                (member) =>
                  member.projectId === project.id &&
                  member.participantId === person(actor),
              ),
          )
          .map((project) => project.id),
      ]),
    ),
    visibleDocumentIdsByActor: visibleDocuments,
    permissionsByActor: permissions,
    totals: {
      effortHours: 188,
      plannedHours: data.tasks.reduce(
        (sum, task) => sum + (task.plannedHours ?? 0),
        0,
      ),
    },
    resourceWindow: {
      ...data.window,
      plannedHoursByActor: Object.fromEntries([
        ...actorKeys.map((actor) => [actor, planned(person(actor))]),
        ['agent-code', 8],
      ]),
      actualHoursByActor: Object.fromEntries(
        actorKeys.map((actor) => [actor, actual(person(actor))]),
      ),
      agentPlannedHours: 8,
      totalPlannedHours: 208,
      totalActualHours: 90,
    },
    dailyEfforts,
    scopeNotes: [
      '真实审计从导入时间开始，未伪造历史燃尽快照。',
      '模型/沙箱/连接器/MCP为未连接配置；没有假执行、假工具目录或假成功记录。',
      '私密文档包括管理员在内均不能越过所有者权限。',
    ],
  };
  assert.equal(final.documents.length, 9);
  assert.equal(actual(person('zhangsan')), 45);
  assert.equal(actual(person('lisi')), 30);
  assert.equal(actual(person('wangwu')), 15);
  assert.equal(planned(person('zhangsan')), 100);
  assert.equal(planned(person('lisi')), 80);
  assert.equal(planned(person('wangwu')), 20);
  manifest.completedAt ??= new Date().toISOString();
  await saveManifest();
  console.log(
    JSON.stringify(
      {
        workspaceId: manifest.workspace.id,
        workspace: manifest.workspace.name,
        projects: final.projects.length,
        tasks: final.tasks.length,
        documentsVisibleToOwner: final.documents.length,
        documentsTotal: manifest.documents.length,
        attachments: manifest.attachments.length,
        effortEntries: manifest.efforts.length,
        effortHours: 188,
        windowPlannedHours: 208,
        windowActualHours: 90,
        manifest: 'data/work-fixture/manifest.json',
        credentialFile: '.env.work-fixture.local',
        note: '全部通过真实登录与应用HTTP服务导入；未执行Agent、模型调用、部署或连接测试。',
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of clients.values()) {
    if (client.cookie)
      await client
        .request('/api/session', undefined, 'DELETE')
        .catch(() => undefined);
  }
  await unlink(lockPath);
}
