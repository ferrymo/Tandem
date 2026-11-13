import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import {
  createPool,
  PostgresCollaborationRepository,
  withScope,
} from '../packages/storage-postgres/src/index.js';

const required = [
  'DATABASE_ADMIN_URL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'WORKER_DATABASE_URL',
] as const;
for (const key of required)
  if (!process.env[key]) throw new Error('请先初始化 .env');
const name = 'tandem_collab_' + randomUUID().replaceAll('-', '');
const testUrl = (input: string) => {
  const parsed = new URL(input);
  parsed.pathname = '/' + name;
  return parsed.toString();
};
const env = { ...process.env };
for (const key of required) env[key] = testUrl(process.env[key]!);
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL!,
});
await admin.connect();
await admin.query('CREATE DATABASE ' + name);
const fixture = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL! });
const app = createPool(env.DATABASE_URL!);
const independentApp = createPool(env.DATABASE_URL!);
const worker = createPool(env.WORKER_DATABASE_URL!);
const repository = new PostgresCollaborationRepository(app);
const otherProcessRepository = new PostgresCollaborationRepository(
  independentApp,
);
async function script(path: string) {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', path], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    proc.once('error', reject);
    proc.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(path + ' failed')),
    );
  });
}
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
async function login(
  subject: string,
  canCreateWorkspace = false,
  providerId = 'test-provider',
) {
  const token = randomUUID();
  const tokenHash = digest(token);
  const session = await repository.createSession({
    login: { providerId, subject, displayName: subject, canCreateWorkspace },
    tokenHash,
    encryptedCredential: 'encrypted-test-credential',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  return { ...session, token, tokenHash };
}
try {
  await script('scripts/db-bootstrap.ts');
  await script('scripts/db-migrate.ts');
  await script('scripts/db-migrate.ts');
  await fixture.connect();
  const owner = await login('张三', true);
  const adminUser = await login('李四');
  const member = await login('测试成员');
  const outsider = await login('隔离测试', true);
  const foreign = await login('其他连接用户', true, 'other-provider');
  const ownerId = owner.identity.id;
  const adminId = adminUser.identity.id;
  const memberId = member.identity.id;
  await assert.rejects(
    repository.refreshIdentity(ownerId, {
      providerId: 'test-provider',
      subject: '李四',
      displayName: '身份错配',
      canCreateWorkspace: true,
    }),
    { code: 'FORBIDDEN' },
  );
  await repository.refreshIdentity(ownerId, {
    providerId: owner.identity.providerId,
    subject: owner.identity.subject,
    displayName: '张三',
    canCreateWorkspace: false,
  });
  await assert.rejects(
    repository.createWorkspace(ownerId, '已撤销指挥官权限', randomUUID()),
    { code: 'FORBIDDEN' },
  );
  await repository.refreshIdentity(ownerId, {
    providerId: owner.identity.providerId,
    subject: owner.identity.subject,
    displayName: '张三',
    canCreateWorkspace: true,
  });
  await assert.rejects(
    repository.createWorkspace(memberId, '无权创建', randomUUID()),
    { code: 'FORBIDDEN' },
  );
  const requestId = randomUUID();
  const spaces = await Promise.all(
    Array.from({ length: 4 }, () =>
      repository.createWorkspace(ownerId, '工作空间 A', requestId),
    ),
  );
  const space = spaces[0]!;
  assert.ok(spaces.every((value) => value.id === space.id));
  await fixture.query(`CREATE FUNCTION tandem.reject_agent_fixture() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'initialization rollback fixture'; END $$`);
  await fixture.query(
    'CREATE TRIGGER reject_agent_fixture BEFORE INSERT ON tandem.agents FOR EACH ROW EXECUTE FUNCTION tandem.reject_agent_fixture()',
  );
  try {
    await assert.rejects(
      repository.createWorkspace(ownerId, '必须整体回滚', randomUUID()),
      /initialization rollback fixture/,
    );
    assert.equal(
      (
        await fixture.query(
          "SELECT 1 FROM tandem.workspaces WHERE name='必须整体回滚'",
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await fixture.query('SELECT count(*)::int AS n FROM tandem.agent_teams'))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await fixture.query(
          'SELECT count(*)::int AS n FROM tandem.workspace_members',
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await fixture.query('DROP TRIGGER reject_agent_fixture ON tandem.agents');
    await fixture.query('DROP FUNCTION tandem.reject_agent_fixture()');
  }
  await assert.rejects(
    repository.createWorkspace(ownerId, '冲突名称', requestId),
    { code: 'CONFLICT' },
  );
  const overview = await repository.overview(ownerId, space.id);
  assert.equal(overview.team.name, 'T 组');
  assert.equal(overview.team.ownerId, ownerId);
  assert.deepEqual(
    overview.team.agents.map((agent) => agent.role),
    ['designer', 'architect', 'engineer'],
  );
  assert.equal(
    (await fixture.query('SELECT count(*)::int AS n FROM tandem.agent_teams'))
      .rows[0].n,
    1,
  );
  assert.equal(
    (await fixture.query('SELECT count(*)::int AS n FROM tandem.agents'))
      .rows[0].n,
    3,
  );
  await fixture.query(
    "UPDATE tandem.agents SET description='用户配置保留' WHERE id=$1",
    [overview.team.agents[0]!.id],
  );
  await repository.createWorkspace(ownerId, '工作空间 A', requestId);
  assert.equal(
    (await repository.overview(ownerId, space.id)).team.agents[0]!.description,
    '用户配置保留',
  );
  await assert.rejects(repository.overview(outsider.identity.id, space.id), {
    code: 'FORBIDDEN',
  });
  assert.deepEqual(await repository.listWorkspaces(memberId), []);
  await repository.setMember(ownerId, space.id, adminId, 'admin');
  await repository.setMember(adminId, space.id, memberId, 'member');
  assert.equal((await repository.listWorkspaces(memberId))[0]!.role, 'member');
  assert.equal((await repository.members(memberId, space.id)).length, 3);
  await assert.rejects(
    repository.setMember(memberId, space.id, outsider.identity.id, 'member'),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    repository.setMember(adminId, space.id, memberId, 'admin'),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    repository.setMember(adminId, space.id, adminId, 'member'),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(repository.removeMember(adminId, space.id, ownerId), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(repository.removeMember(ownerId, space.id, ownerId), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    repository.setMember(ownerId, space.id, foreign.identity.id, 'member'),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    repository.setMember(ownerId, space.id, randomUUID(), 'member'),
    { code: 'FORBIDDEN' },
  );
  const scope = { workspaceId: space.id, actorId: ownerId };
  for (const table of [
    'workspaces',
    'workspace_members',
    'agent_teams',
    'agents',
  ]) {
    assert.ok(
      (
        await withScope(app, scope, (client) =>
          client.query('SELECT * FROM tandem.' + table),
        )
      ).rowCount! > 0,
    );
    assert.equal(
      (
        await withScope(
          app,
          { ...scope, actorId: outsider.identity.id },
          (client) => client.query('SELECT * FROM tandem.' + table),
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await app.query('SELECT * FROM tandem.' + table)).rowCount,
      0,
    );
  }
  const otherSpace = await repository.createWorkspace(
    outsider.identity.id,
    '工作空间 B',
    randomUUID(),
  );
  assert.equal(
    (
      await withScope(app, scope, (client) =>
        client.query('SELECT * FROM tandem.workspaces WHERE id=$1', [
          otherSpace.id,
        ]),
      )
    ).rowCount,
    0,
  );
  await assert.rejects(app.query('SELECT * FROM tandem.identities'));
  await assert.rejects(app.query('SELECT * FROM tandem.sessions'));
  await assert.rejects(
    worker.query('SELECT tandem.find_identity_session($1)', [owner.tokenHash]),
  );
  await assert.rejects(worker.query('SELECT * FROM tandem.agents'));
  await assert.rejects(
    withScope(app, scope, (client) =>
      client.query(
        "UPDATE tandem.workspace_members SET role='owner' WHERE identity_id=$1",
        [memberId],
      ),
    ),
  );
  await repository.removeMember(adminId, space.id, memberId);
  await assert.rejects(repository.overview(memberId, space.id), {
    code: 'FORBIDDEN',
  });
  assert.deepEqual(await repository.listWorkspaces(memberId), []);
  assert.equal(
    (
      await withScope(app, { ...scope, actorId: memberId }, (client) =>
        client.query('SELECT * FROM tandem.agents'),
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    withScope(app, scope, async (client) => {
      await client.query('SELECT tandem.change_workspace_member($1,$2,$3)', [
        space.id,
        memberId,
        'member',
      ]);
      throw new Error('rollback fixture');
    }),
    /rollback fixture/,
  );
  assert.deepEqual(await repository.listWorkspaces(memberId), []);
  assert.equal(
    (await otherProcessRepository.session(owner.tokenHash))!.identity.id,
    ownerId,
  );
  const persisted = (
    await fixture.query(
      'SELECT token_hash, encrypted_credential FROM tandem.sessions WHERE id=$1',
      [owner.id],
    )
  ).rows[0];
  assert.equal(persisted.token_hash, owner.tokenHash);
  assert.notEqual(persisted.token_hash, owner.token);
  await repository.revokeSession(owner.tokenHash);
  assert.equal(await otherProcessRepository.session(owner.tokenHash), null);
  assert.equal(
    (
      await fixture.query(
        'SELECT encrypted_credential FROM tandem.sessions WHERE id=$1',
        [owner.id],
      )
    ).rows[0].encrypted_credential,
    null,
  );
  await fixture.query(
    "UPDATE tandem.sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
    [member.id],
  );
  assert.equal(await repository.session(member.tokenHash), null);
  console.log(
    '协作集成通过：真实 PG 迁移、会话摘要/撤销/过期、并发幂等初始化、T 组三人、配置保留、角色限制、撤权及跨身份/空间 RLS、跨连接拒绝、事务回滚。',
  );
} finally {
  await Promise.all([
    app.end(),
    independentApp.end(),
    worker.end(),
    fixture.end(),
  ]);
  if (/^tandem_collab_[a-f0-9]{32}$/.test(name))
    await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await admin.end();
}
