import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

// This fixture is confined to an isolated regression database and process.
// The product has no alternate login route or development identity bypass.
const root = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(root, 'apps/web/.next/standalone/apps/web/server.js')))
  throw new Error('请先执行 pnpm build，再运行协作 HTTP 回归');
const databaseKeys = [
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_URL',
  'WORKER_DATABASE_URL',
] as const;
for (const key of databaseKeys)
  if (!process.env[key]) throw new Error('请先初始化 .env');
const databaseName = 'tandem_http_' + randomUUID().replaceAll('-', '');
const attachmentTestParent = resolve(root, 'data/http-tests');
const attachmentTestRoot = resolve(attachmentTestParent, databaseName);
const env = { ...process.env };
for (const key of databaseKeys) {
  const url = new URL(process.env[key]!);
  url.pathname = '/' + databaseName;
  env[key] = url.toString();
}
const users = new Map([
  [
    'zhangsan',
    { id: 7, name: '张三', password: randomBytes(24).toString('hex') },
  ],
  ['lisi', { id: 8, name: '李四', password: randomBytes(24).toString('hex') }],
]);
const issuedTokens = new Map<string, string>();
const revokedTokens = new Set<string>();
let unavailable = false;
let child: ChildProcess | undefined;
let childFailed = false;
let databaseCreated = false;
let fixtureListening = false;
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL!,
});
const fixture = createServer((request, response) => {
  void fixtureRequest(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

function fixtureJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
async function fixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (request.url === '/api.php/v1/tokens' && request.method === 'POST') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 8192) return fixtureJson(response, 413, {});
      chunks.push(bytes);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      account?: string;
      password?: string;
    };
    const user = users.get(input.account ?? '');
    if (!user || input.password !== user.password)
      return fixtureJson(response, 400, { error: 'fixture login rejected' });
    const token = randomBytes(24).toString('hex');
    issuedTokens.set(token, input.account!);
    return fixtureJson(response, 201, { token });
  }
  if (request.url === '/api.php/v1/user' && request.method === 'GET') {
    if (unavailable)
      return fixtureJson(response, 503, {
        error: 'fixture upstream unavailable',
      });
    const token = request.headers.token;
    const account =
      typeof token === 'string' ? issuedTokens.get(token) : undefined;
    const user = account ? users.get(account) : undefined;
    if (!user || typeof token !== 'string' || revokedTokens.has(token))
      return fixtureJson(response, 401, {
        error: 'fixture authorization revoked',
      });
    return fixtureJson(response, 200, {
      profile: { id: user.id, account, realname: user.name },
    });
  }
  fixtureJson(response, 404, {});
}

async function runScript(path: string) {
  await new Promise<void>((done, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      ['--import', 'tsx', path],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    process.stdout?.on('data', () => {});
    process.stderr?.on('data', () => {});
    process.once('error', () =>
      reject(new Error('测试数据库初始化进程无法启动')),
    );
    process.once('exit', (code) =>
      code === 0 ? done() : reject(new Error('测试数据库初始化失败：' + path)),
    );
  });
}
async function sparePort() {
  const probe = createPortProbe();
  await new Promise<void>((done, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', done);
  });
  const address = probe.address();
  assert(address && typeof address === 'object', '未能分配测试端口');
  const port = address.port;
  await new Promise<void>((done, reject) =>
    probe.close((error) => (error ? reject(error) : done())),
  );
  return port;
}
async function stopWeb() {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      execFile(
        'taskkill',
        ['/PID', String(child!.pid), '/T', '/F'],
        { windowsHide: true },
        () => done(),
      );
    });
  } else {
    child.kill('SIGTERM');
    for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

type Payload = {
  user?: {
    id: string;
    displayName: string;
    canCreateWorkspace: boolean;
  } | null;
  login?: { configured: boolean };
  workspace?: { id: string; name: string };
  workspaces?: { id: string; name: string }[];
  team?: { agents: { role: string }[] };
};
type ApiResult = { response: Response; text: string; data: Payload };
let base = '';
async function api(
  path: string,
  options: {
    method?: string;
    cookie?: string;
    payload?: unknown;
    origin?: string | null;
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin !== null) headers.Origin = options.origin ?? base;
  if (options.payload !== undefined)
    headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.payload !== undefined
      ? { body: JSON.stringify(options.payload) }
      : {}),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  const text = await response.text();
  let data: Payload;
  try {
    data = JSON.parse(text) as Payload;
  } catch {
    throw new Error('接口未返回有效 JSON：' + path);
  }
  assert.equal(
    response.headers.get('cache-control'),
    'no-store',
    '协作接口必须禁止缓存',
  );
  for (const key of [
    '"accessToken"',
    '"encryptedCredential"',
    '"password"',
    '"providerId"',
    '"subject"',
  ])
    assert(!text.includes(key), '公共接口泄露了私有身份字段');
  for (const token of issuedTokens.keys())
    assert(!text.includes(token), '公共接口泄露了上游令牌');
  return { response, text, data };
}
function status(result: ApiResult, expected: number, label: string) {
  assert.equal(result.response.status, expected, label);
}
async function login(account: string) {
  const result = await api('/api/session', {
    method: 'POST',
    payload: { account, password: users.get(account)!.password },
  });
  status(result, 200, '本人协作账号登录');
  const header = result.response.headers.get('set-cookie') ?? '';
  assert(/httponly/i.test(header), '会话 cookie 必须 HttpOnly');
  assert(/samesite=strict/i.test(header), '会话 cookie 必须 SameSite Strict');
  assert(/path=\//i.test(header), '会话 cookie 必须覆盖本站路径');
  const cookie = header.split(';')[0]!;
  assert(
    cookie.startsWith('tandem_session='),
    '本机 HTTP 测试应使用本机会话 cookie',
  );
  assert(result.data.user?.id, '登录应返回公开用户标识');
  return { cookie, user: result.data.user! };
}

async function browserRegression() {
  const { workManagementBrowser } =
    await import('./work-management-browser.js');
  await workManagementBrowser(
    base,
    'zhangsan',
    users.get('zhangsan')!.password,
  );
}

try {
  await admin.connect();
  await admin.query('CREATE DATABASE ' + databaseName);
  databaseCreated = true;
  await runScript('scripts/db-bootstrap.ts');
  await runScript('scripts/db-migrate.ts');
  await new Promise<void>((done, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', done);
  });
  fixtureListening = true;
  const address = fixture.address();
  assert(address && typeof address === 'object', '测试协作系统未启动');
  const port = await sparePort();
  base = 'http://127.0.0.1:' + port;
  Object.assign(env, {
    NODE_ENV: 'production',
    DATABASE_URL: env.DATABASE_URL,
    PORT: String(port),
    TANDEM_HOST: '127.0.0.1',
    TANDEM_PUBLIC_URL: base,
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    TANDEM_IDENTITY_URL: 'http://127.0.0.1:' + address.port,
    TANDEM_IDENTITY_ALLOW_HTTP: 'true',
    TANDEM_IDENTITY_ID: 'http-regression',
    TANDEM_IDENTITY_LABEL: '隔离测试连接',
    TANDEM_COMMANDER_ACCOUNTS: 'zhangsan',
    LOG_LEVEL: 'silent',
    TANDEM_ATTACHMENT_ROOT: attachmentTestRoot,
  });
  child = spawn(process.execPath, ['scripts/web.mjs', 'start'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  child.once('error', () => {
    childFailed = true;
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (childFailed || child.exitCode !== null)
      throw new Error('测试 Web 启动失败，请先重新构建');
    try {
      if (
        (
          await fetch(base + '/api/health/ready', {
            signal: AbortSignal.timeout(1000),
          })
        ).status === 200
      ) {
        ready = true;
        break;
      }
    } catch {
      /* The server may still be starting. */
    }
    await sleep(200);
  }
  assert(ready, '测试 Web 未在期限内就绪');

  const publicSession = await api('/api/session');
  status(publicSession, 200, '未登录时读取身份连接状态');
  assert.equal(publicSession.data.login?.configured, true);
  assert.equal(publicSession.data.user, null);
  status(
    await api('/api/session', {
      method: 'POST',
      payload: { account: 'zhangsan', password: 'incorrect-fixture-password' },
    }),
    401,
    '错误密码拒绝登录',
  );
  const owner = await login('zhangsan');
  assert.equal(owner.user.canCreateWorkspace, true);
  const workspaceInput = { name: '项目 A 协作空间', requestId: randomUUID() };
  status(
    await api('/api/workspaces', {
      method: 'POST',
      cookie: owner.cookie,
      payload: workspaceInput,
      origin: null,
    }),
    403,
    '缺少来源的写请求被拒绝',
  );
  status(
    await api('/api/workspaces', {
      method: 'POST',
      cookie: owner.cookie,
      payload: workspaceInput,
      origin: 'https://untrusted.example',
    }),
    403,
    '跨站写请求被拒绝',
  );
  const created = await api('/api/workspaces', {
    method: 'POST',
    cookie: owner.cookie,
    payload: workspaceInput,
  });
  status(created, 201, '创建工作空间');
  assert(created.data.workspace?.id, '创建工作空间应返回标识');
  const workspaceId = created.data.workspace!.id;
  const repeated = await api('/api/workspaces', {
    method: 'POST',
    cookie: owner.cookie,
    payload: workspaceInput,
  });
  status(repeated, 201, '重复创建幂等');
  assert.equal(repeated.data.workspace?.id, workspaceId);
  status(
    await api('/api/workspaces', {
      method: 'POST',
      cookie: owner.cookie,
      payload: { ...workspaceInput, name: '不一致内容' },
    }),
    409,
    '同幂等键异内容冲突',
  );
  const overview = await api('/api/workspaces/' + workspaceId, {
    cookie: owner.cookie,
  });
  status(overview, 200, '读取 T 组');
  assert.deepEqual(
    overview.data.team?.agents.map((agent) => agent.role).sort(),
    ['architect', 'designer', 'engineer'],
  );
  status(
    await api('/api/connection', { cookie: owner.cookie }),
    200,
    '读取当前用户连接授权',
  );

  const member = await login('lisi');
  assert.equal(member.user.canCreateWorkspace, false);
  assert.equal(
    (await api('/api/workspaces', { cookie: member.cookie })).data.workspaces
      ?.length,
    0,
  );
  status(
    await api('/api/workspaces', {
      method: 'POST',
      cookie: member.cookie,
      payload: { name: '无权限空间', requestId: randomUUID() },
    }),
    403,
    '普通成员不能创建工作空间',
  );
  status(
    await api('/api/workspaces/' + workspaceId, { cookie: member.cookie }),
    403,
    '已知空间标识不代表有访问权',
  );
  status(
    await api('/api/workspaces/' + randomUUID(), { cookie: member.cookie }),
    403,
    '猜测空间标识不泄露资源',
  );
  const membersPath = '/api/workspaces/' + workspaceId + '/members';
  status(
    await api(membersPath, {
      method: 'POST',
      cookie: owner.cookie,
      payload: { identityId: member.user.id, role: 'member' },
    }),
    200,
    '创建人授权已认证成员',
  );
  status(
    await api('/api/workspaces/' + workspaceId, { cookie: member.cookie }),
    200,
    '授权后可读取空间',
  );
  status(
    await api(membersPath, {
      method: 'POST',
      cookie: member.cookie,
      payload: { identityId: member.user.id, role: 'admin' },
    }),
    403,
    '成员不能自我提权',
  );
  status(
    await api(membersPath + '/' + member.user.id, {
      method: 'DELETE',
      cookie: owner.cookie,
    }),
    200,
    '撤销成员访问权',
  );
  status(
    await api('/api/workspaces/' + workspaceId, { cookie: member.cookie }),
    403,
    '撤权立即阻止访问',
  );
  assert.equal(
    (await api('/api/workspaces', { cookie: member.cookie })).data.workspaces
      ?.length,
    0,
  );
  status(
    await api('/api/session', { method: 'DELETE', cookie: member.cookie }),
    200,
    '退出当前会话',
  );
  status(
    await api('/api/workspaces', { cookie: member.cookie }),
    401,
    '退出后重放旧 cookie 无效',
  );

  for (const [token, account] of issuedTokens)
    if (account === 'zhangsan') revokedTokens.add(token);
  status(
    await api('/api/workspaces', { cookie: owner.cookie }),
    401,
    '上游授权撤销立即阻止访问',
  );
  const currentOwner = await login('zhangsan');
  unavailable = true;
  const outage = await api('/api/workspaces/' + workspaceId, {
    cookie: currentOwner.cookie,
  });
  status(outage, 503, '上游不可用时失败关闭');
  assert(
    !outage.text.includes(workspaceInput.name),
    '上游不可用时不能返回旧空间数据',
  );
  status(
    await api('/api/session', {
      method: 'DELETE',
      cookie: currentOwner.cookie,
    }),
    200,
    '上游故障期间仍可本地退出',
  );
  status(
    await api('/api/workspaces', { cookie: currentOwner.cookie }),
    401,
    '故障期间退出也撤销旧 cookie',
  );
  console.log(
    '协作 HTTP 回归通过：真实登录/会话、来源校验、T 组三人、幂等、成员授权、即时撤权及上游故障关闭。',
  );
  if (process.argv.includes('--browser')) {
    unavailable = false;
    await browserRegression();
  }
} finally {
  await stopWeb();
  if (attachmentTestRoot.startsWith(attachmentTestParent + sep))
    await rm(attachmentTestRoot, { recursive: true, force: true });
  if (fixtureListening) {
    fixture.closeAllConnections();
    await new Promise<void>((done) => fixture.close(() => done()));
  }
  try {
    if (databaseCreated) {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [databaseName],
      );
      await admin.query('DROP DATABASE ' + databaseName);
    }
  } finally {
    await admin.end();
  }
}
