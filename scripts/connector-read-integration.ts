import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import pg from 'pg';
import { ConnectorReadService } from '../packages/application/src/connector-read';
import { WorkManagementService } from '../packages/application/src/work-management';
import { createSessionCodec } from '../packages/platform/src/session-crypto';
import { ZentaoReadOnlyDatabase } from '../adapters/zentao/src/readonly-database';
import {
  createPool,
  PostgresCollaborationRepository,
  PostgresConnectorAuthorizationRepository,
  PostgresWorkManagementRepository,
  withScope,
} from '../packages/storage-postgres/src/index';

const exec = promisify(execFile),
  suffix = randomUUID().replaceAll('-', ''),
  container = 'tandem-connector-test-' + suffix,
  database = 'tandem_connector_' + suffix;
const rootPassword = randomBytes(24).toString('hex'),
  readPassword = randomBytes(24).toString('hex'),
  writePassword = randomBytes(24).toString('hex'),
  apiPassword = randomBytes(16).toString('hex');
const env = { ...process.env };
assert(/^tandem-connector-test-[a-f0-9]{32}$/.test(container));
for (const key of [
  'DATABASE_ADMIN_URL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'WORKER_DATABASE_URL',
]) {
  if (!env[key]) throw new Error('请先初始化 .env');
  const url = new URL(env[key]);
  url.pathname = '/' + database;
  env[key] = url.href;
}
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
await admin.query('CREATE DATABASE ' + database);
const pool = createPool(env.DATABASE_URL!),
  collab = new PostgresCollaborationRepository(pool),
  work = new WorkManagementService(new PostgresWorkManagementRepository(pool)),
  repo = new PostgresConnectorAuthorizationRepository(pool),
  codec = createSessionCodec(randomBytes(32).toString('hex'));
let fixture: Connection | undefined,
  businessWrites = 0;
const project = (id: string) => ({
  id: Number(id),
  name: id === '1' ? '项目甲' : '私有项目乙',
  status: 'doing',
  deleted: '0',
});
const task = {
  id: 11,
  project: 1,
  execution: 101,
  name: '可见任务',
  status: 'doing',
  assignedTo: 'member',
  estimate: 8,
  consumed: 3,
  left: 5,
  deadline: '2026-12-01',
  deleted: '0',
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const account = String(request.headers.token ?? '').replace(
    /^test-token-/,
    '',
  );
  const reply = (status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  if (request.method === 'POST' && url.pathname === '/api.php/v1/tokens') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (
      !['owner', 'member'].includes(input.account) ||
      input.password !== apiPassword
    )
      return reply(401, { error: 'invalid' });
    return reply(200, { token: 'test-token-' + input.account });
  }
  if (request.method !== 'GET') {
    businessWrites++;
    return reply(405, {});
  }
  if (!['owner', 'member'].includes(account)) return reply(401, {});
  if (url.pathname === '/api.php/v1/user')
    return reply(200, {
      profile: {
        id: account === 'owner' ? 1 : 2,
        account,
        realname: account === 'owner' ? '张三' : '李四',
        deleted: '0',
      },
    });
  if (url.pathname === '/api.php/v1/projects') {
    const items =
      account === 'owner' ? [project('1'), project('2')] : [project('1')];
    return reply(200, { projects: items, total: items.length });
  }
  if (url.pathname === '/api.php/v1/projects/2' && account === 'member')
    return reply(403, {});
  if (
    url.pathname === '/api.php/v1/projects/1' ||
    url.pathname === '/api.php/v1/projects/2'
  )
    return reply(200, project(url.pathname.endsWith('/1') ? '1' : '2'));
  if (url.pathname === '/api.php/v1/projects/1/executions')
    return reply(200, {
      executions: [{ id: 101, project: 1, name: '授权执行', status: 'doing' }],
      total: 1,
    });
  if (url.pathname === '/api.php/v1/executions/101')
    return reply(200, {
      id: 101,
      project: 1,
      name: '授权执行',
      status: 'doing',
    });
  if (url.pathname === '/api.php/v1/executions/101/tasks')
    return reply(200, { tasks: [task], total: 1 });
  return reply(404, {});
});
const runScript = (file: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(file + ' failed: ' + out)),
    );
  });
try {
  await runScript('scripts/db-bootstrap.ts');
  await runScript('scripts/db-migrate.ts');
  await exec(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'MYSQL_ROOT_PASSWORD',
      '-e',
      'MYSQL_ROOT_HOST=%',
      '-e',
      'MYSQL_DATABASE=zentao',
      '-p',
      '127.0.0.1::3306',
      'mysql:8.4',
    ],
    {
      env: { ...process.env, MYSQL_ROOT_PASSWORD: rootPassword },
      windowsHide: true,
    },
  );
  const binding = (
    await exec('docker', ['port', container, '3306/tcp'], { windowsHide: true })
  ).stdout.trim();
  const mysqlPort = Number(binding.split(':').at(-1));
  assert(Number.isInteger(mysqlPort));
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      fixture = await mysql.createConnection({
        host: '127.0.0.1',
        port: mysqlPort,
        user: 'root',
        password: rootPassword,
        database: 'zentao',
        connectTimeout: 1000,
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  assert(fixture, '隔离MySQL启动超时');
  await fixture.query(
    'CREATE TABLE zt_user(id int PRIMARY KEY,account varchar(120),deleted char(1))',
  );
  await fixture.query(
    'CREATE TABLE zt_project(id int PRIMARY KEY,name varchar(200),status varchar(30),deleted char(1))',
  );
  await fixture.query(
    'CREATE TABLE zt_task(id int PRIMARY KEY,project int,execution int,name varchar(200),status varchar(30),assignedTo varchar(120),module int,estimate decimal(10,2),consumed decimal(10,2),`left` decimal(10,2),deadline date,deleted char(1))',
  );
  await fixture.query(
    "INSERT INTO zt_user VALUES(1,'owner','0'),(2,'member','0')",
  );
  await fixture.query(
    "INSERT INTO zt_project VALUES(1,'项目甲','doing','0'),(2,'私有项目乙','doing','0')",
  );
  await fixture.query(
    "INSERT INTO zt_task VALUES(11,1,101,'可见任务','doing','member',5,8,3,5,'2026-12-01','0'),(12,1,102,'执行ACL隐藏任务','wait','owner',5,8,0,8,'2026-12-01','0'),(21,2,201,'私有项目任务','wait','owner',5,10,0,10,'2026-12-01','0')",
  );
  await fixture.query("CREATE USER 'tandem_readonly'@'%' IDENTIFIED BY ?", [
    readPassword,
  ]);
  await fixture.query("GRANT SELECT ON zentao.* TO 'tandem_readonly'@'%'");
  await fixture.query("CREATE USER 'tandem_writer'@'%' IDENTIFIED BY ?", [
    writePassword,
  ]);
  await fixture.query("GRANT SELECT,INSERT ON zentao.* TO 'tandem_writer'@'%'");
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const session = async (subject: string) =>
    collab.createSession({
      login: {
        providerId: 'connector-fixture',
        subject,
        displayName: subject,
        canCreateWorkspace: true,
      },
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      encryptedCredential: 'isolated-only',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  const owner = await session('张三'),
    member = await session('李四'),
    outsider = await session('王五'),
    workspace = await collab.createWorkspace(
      owner.identity.id,
      '连接器隔离验证',
      randomUUID(),
    );
  await collab.setMember(
    owner.identity.id,
    workspace.id,
    member.identity.id,
    'member',
  );
  const config = await work.execute(owner, workspace.id, {
    command: 'save-connector',
    name: '本机只读源',
    baseUrl,
    databaseHost: '127.0.0.1',
    databasePort: mysqlPort,
    databaseName: 'zentao',
    databaseUser: 'tandem_readonly',
    enabled: true,
  });
  assert(config.id);
  const adapter = new ZentaoReadOnlyDatabase(),
    service = new ConnectorReadService(repo, codec, adapter);
  await service.save(owner, workspace.id, config.id, {
    account: 'owner',
    apiPassword,
    databasePassword: readPassword,
  });
  const tested = await service.test(owner, workspace.id, config.id);
  assert.equal(tested.ok, true);
  assert.equal(tested.database.readOnly, true);
  assert.equal(tested.authorization.visibleProjects, 2);
  const catalog = await service.read(owner, workspace.id, config.id, {});
  assert.equal(catalog.projects.length, 2);
  assert.equal(catalog.tasksLoaded, false);
  const read = await service.read(owner, workspace.id, config.id, {
    projectId: '1',
    limit: 100,
  });
  assert.deepEqual(
    read.tasks.map((task) => task.id),
    ['11'],
  );
  assert.equal(read.tasks[0]?.consumedHours, 3);
  assert.equal(read.tasks[0]?.deadline, '2026-12-01');
  assert.equal(read.tasksLoaded, true);
  await assert.rejects(service.test(member, workspace.id, config.id), {
    code: 'CONFLICT',
  });
  await service.save(member, workspace.id, config.id, {
    account: 'member',
    apiPassword,
    databasePassword: readPassword,
  });
  await assert.rejects(
    service.read(member, workspace.id, config.id, { projectId: '2' }),
    { code: 'FORBIDDEN' },
  );
  assert.deepEqual(
    (
      await service.read(member, workspace.id, config.id, { projectId: '1' })
    ).tasks.map((task) => task.id),
    ['11'],
  );
  assert.equal(
    await withScope(
      pool,
      { workspaceId: workspace.id, actorId: member.identity.id },
      async (client) =>
        (await client.query('SELECT * FROM tandem.wm_connector_authorizations'))
          .rowCount,
    ),
    1,
  );
  const encrypted = await repo.authorization(
    { workspaceId: workspace.id, actorId: owner.identity.id },
    config.id,
  );
  assert(encrypted);
  assert(!encrypted.encryptedValues.includes(readPassword));
  assert.throws(() =>
    codec.open(
      encrypted.encryptedValues,
      `connector-credential:${workspace.id}:${config.id}:${member.identity.id}:1`,
    ),
  );
  const writer = await work.execute(owner, workspace.id, {
    command: 'save-connector',
    name: '拒绝写账号',
    baseUrl,
    databaseHost: '127.0.0.1',
    databasePort: mysqlPort,
    databaseName: 'zentao',
    databaseUser: 'tandem_writer',
    enabled: true,
  });
  await service.save(owner, workspace.id, writer.id, {
    account: 'owner',
    apiPassword,
    databasePassword: writePassword,
  });
  await assert.rejects(service.test(owner, workspace.id, writer.id), {
    code: 'FORBIDDEN',
  });
  const before = await work.snapshot(owner, workspace.id),
    main = before.connectors.find((item) => item.id === config.id);
  assert(main);
  await work.execute(owner, workspace.id, {
    command: 'save-connector',
    ...main,
    name: '版本改变',
  });
  await assert.rejects(service.test(owner, workspace.id, config.id), {
    code: 'CONFLICT',
  });
  await assert.rejects(
    service.save(owner, workspace.id, config.id, {
      databasePassword: readPassword,
    }),
    { code: 'INVALID_INPUT' },
  );
  await service.save(owner, workspace.id, config.id, {
    account: 'owner',
    apiPassword,
    databasePassword: readPassword,
  });
  const other = await collab.createWorkspace(
    outsider.identity.id,
    '其他连接空间',
    randomUUID(),
  );
  await assert.rejects(service.test(outsider, other.id, config.id), {
    code: 'FORBIDDEN',
  });
  await collab.removeMember(
    owner.identity.id,
    workspace.id,
    member.identity.id,
  );
  await assert.rejects(service.test(member, workspace.id, config.id), {
    code: 'FORBIDDEN',
  });
  const [counts] = await fixture.query<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM zt_task',
  );
  assert.equal(counts[0]?.count, 3);
  assert.equal(businessWrites, 0);
  console.log(
    '连接器集成通过：真实MySQL8.4仅SELECT账号与READ ONLY事务、写权限账号拒绝、本人API认证及精确任务ACL、无业务写入、PG每人加密授权/RLS/撤权/配置版本绑定。禅道HTTP使用本机隔离替身，未访问客户数据库。',
  );
} finally {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture?.end().catch(() => fixture?.destroy());
  await exec('docker', ['rm', '-f', container], { windowsHide: true }).catch(
    () => undefined,
  );
  await pool.end();
  await admin.query('DROP DATABASE ' + database + ' WITH (FORCE)');
  await admin.end();
}
