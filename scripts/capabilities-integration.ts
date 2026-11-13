import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { CapabilitiesService } from '../packages/application/src/capabilities.js';
import type {
  CapabilityUsage,
  SkillBundle,
} from '../packages/core/src/index.js';
import {
  createPool,
  PostgresCapabilityRepository,
  PostgresCollaborationRepository,
  PostgresDeliveryRepository,
  PostgresJobQueue,
  PostgresProjectsRepository,
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
const name = 'tandem_caps_' + randomUUID().replaceAll('-', '');
const env = { ...process.env };
for (const key of required) {
  const url = new URL(env[key]!);
  url.pathname = '/' + name;
  env[key] = url.toString();
}
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL!,
});
await admin.connect();
await admin.query('CREATE DATABASE ' + name);
const fixture = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL! });
const app = createPool(env.DATABASE_URL!);
const worker = createPool(env.WORKER_DATABASE_URL!);
const collab = new PostgresCollaborationRepository(app);
const projects = new PostgresProjectsRepository(app);
const caps = new PostgresCapabilityRepository(app);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
async function script(path: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(path + ' failed')),
    );
  });
}
async function login(subject: string, commander = false) {
  return collab.createSession({
    login: {
      providerId: 'capabilities-fixture',
      subject,
      displayName: subject,
      canCreateWorkspace: commander,
    },
    tokenHash: digest(randomUUID()),
    encryptedCredential: 'integration-fixture-only',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
}
const bundle = (
  skillName = 'verification',
  version = '1.0.0',
): SkillBundle => ({
  name: skillName,
  version,
  description: '隔离验收技能',
  source: { kind: 'upload', label: 'integration fixture' },
  permissions: ['execution.script'],
  dependencies: [],
  files: {
    'SKILL.md': `---\nname: ${skillName}\ndescription: Isolated verification\n---\nUse the bundled verification script.`,
    'scripts/check.mjs': 'console.log("verified")',
  },
});
try {
  await script('scripts/db-bootstrap.ts');
  await script('scripts/db-migrate.ts');
  await fixture.connect();
  const owner = await login('张三', true);
  const member = await login('李四');
  const outsider = await login('其他空间', true);
  const space = await collab.createWorkspace(
    owner.identity.id,
    '能力集成验收',
    randomUUID(),
  );
  const other = await collab.createWorkspace(
    outsider.identity.id,
    '隔离空间',
    randomUUID(),
  );
  const scope = { workspaceId: space.id, actorId: owner.identity.id };
  const memberScope = { ...scope, actorId: member.identity.id };
  await collab.setMember(
    owner.identity.id,
    space.id,
    member.identity.id,
    'member',
  );
  const team = (await collab.overview(owner.identity.id, space.id)).team;
  const project = await projects.bind(scope, 'capabilities-fixture', '1');
  const projectB = await projects.bind(scope, 'capabilities-fixture', '2');
  await projects.grant(scope, project.id, member.identity.id, 'viewer');
  const service = new CapabilitiesService(
    caps,
    {
      catalog: async () => [
        {
          name: 'echo',
          description: 'fixture',
          inputSchema: { type: 'object' },
          schemaHash: '',
        },
      ],
      invoke: async () => ({
        isError: false,
        content: [{ type: 'text', text: 'fixture result' }],
      }),
    },
    {
      assertProject: async (s, id, write) => {
        await projects.link(s, id, write);
      },
      assertOwner: async (s, binding, ownerSession) => {
        await projects.link(
          { workspaceId: s.workspaceId, actorId: ownerSession.identity.id },
          binding.projectId,
        );
      },
      hash: digest,
      seal: (v) => 'encrypted:' + v,
      open: (v) => v.slice(10),
    },
  );
  const installed = await service.installSkill(scope, bundle());
  const initialVersion = installed.versions[0]!;
  const repeated = await service.installSkill(scope, bundle());
  assert.equal(repeated.versions.length, 1);
  await assert.rejects(
    service.installSkill(scope, {
      ...bundle(),
      files: { ...bundle().files, 'extra.md': 'conflicting immutable version' },
    }),
    { code: 'CONFLICT' },
  );
  await assert.rejects(service.installSkill(memberScope, bundle('forbidden')), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    withScope(app, scope, (c) =>
      c.query('UPDATE tandem.skill_versions SET bundle=$1 WHERE id=$2', [
        JSON.stringify(bundle()),
        initialVersion.id,
      ]),
    ),
    /permission denied/,
  );
  const binding = {
    projectId: project.id,
    teamId: team.id,
    agentRole: 'engineer' as const,
  };
  await service.bindSkill(scope, {
    ...binding,
    skillId: installed.id,
    versionId: initialVersion.id,
    permissions: ['execution.script'],
    enabled: true,
  });
  await assert.rejects(
    service.bindSkill(scope, {
      ...binding,
      skillId: installed.id,
      versionId: initialVersion.id,
      permissions: ['host.admin'],
      enabled: true,
    }),
    { code: 'FORBIDDEN' },
  );
  const upgraded = await service.installSkill(
    scope,
    bundle('verification', '2.0.0'),
  );
  assert.equal(upgraded.versions.length, 2);
  assert.equal(
    (
      await service.resolveSkills(scope, {
        ...binding,
        versions: [{ skillId: installed.id, versionId: initialVersion.id }],
      })
    )[0]!.version,
    '1.0.0',
  );
  const hiddenSkill = await service.installSkill(
    scope,
    bundle('other-project-only'),
  );
  await service.bindSkill(scope, {
    ...binding,
    projectId: projectB.id,
    skillId: hiddenSkill.id,
    versionId: hiddenSkill.versions[0]!.id,
    permissions: ['execution.script'],
    enabled: true,
  });
  assert.equal(
    (
      await caps.listSkills({
        workspaceId: space.id,
        actorId: outsider.identity.id,
      })
    ).length,
    0,
  );
  assert.equal(
    (
      await caps.listSkills({
        workspaceId: other.id,
        actorId: owner.identity.id,
      })
    ).length,
    0,
  );
  const server = await service.saveServer(scope, {
    name: '协议验收',
    connection: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
  });
  await service.setCredential(scope, server.id, 'owner-fixture-token');
  await service.setCredential(memberScope, server.id, 'member-fixture-token');
  assert.equal(
    await caps.credential(scope, server.id),
    'encrypted:owner-fixture-token',
  );
  assert.equal(
    await caps.credential(memberScope, server.id),
    'encrypted:member-fixture-token',
  );
  assert.equal(
    await caps.credential(
      { ...scope, actorId: outsider.identity.id },
      server.id,
    ),
    null,
  );
  const tested = await service.testServer(scope, server.id);
  await service.grantTool(scope, {
    ...binding,
    serverId: server.id,
    toolName: 'echo',
    effect: 'read',
    enabled: true,
  });
  await assert.rejects(
    service.grantTool(scope, {
      ...binding,
      projectId: projectB.id,
      teamId: (await collab.overview(outsider.identity.id, other.id)).team.id,
      serverId: server.id,
      toolName: 'echo',
      effect: 'read',
      enabled: true,
    }),
    { code: 'FORBIDDEN' },
  );
  const invocation = {
    ...binding,
    serverId: server.id,
    toolName: 'echo',
    arguments: {},
  };
  assert.equal((await service.callTool(scope, invocation)).kind, 'result');
  assert.ok(
    (await service.usage(scope, project.id)).every(
      (item) => !JSON.stringify(item).includes('fixture result'),
    ),
  );

  const run = await new PostgresDeliveryRepository(app).start(owner, {
    workspaceId: space.id,
    projectId: project.id,
    requestId: randomUUID(),
    goal: '隔离能力授权验收',
    acceptance: '固定版本和范围',
    mode: 'demo',
    budgetCalls: 5,
    budgetTokens: 10000,
    maxRevisions: 0,
  });
  const queue = new PostgresJobQueue(worker);
  const workerId = randomUUID();
  const job = await queue.claim(workerId, 60000);
  assert.ok(job);
  assert.equal(job.reference, run.id);
  const fence = { job, workerId };
  const workerCaps = new PostgresCapabilityRepository(worker, fence);
  assert.equal(
    (await workerCaps.ownerSession(scope, project.id, team.id)).identity.id,
    owner.identity.id,
  );
  await assert.rejects(workerCaps.ownerSession(scope, projectB.id, team.id), {
    code: 'FORBIDDEN',
  });
  const visible = await workerCaps.listSkills(scope);
  assert.deepEqual(
    visible.map((s) => s.id),
    [installed.id],
  );
  assert.equal(
    await workerCaps.credential(scope, server.id),
    'encrypted:owner-fixture-token',
  );
  await assert.rejects(workerCaps.getSkill(scope, hiddenSkill.id), {
    code: 'FORBIDDEN',
  });
  assert.equal((await workerCaps.skillBindings(scope, projectB.id)).length, 0);
  await assert.rejects(workerCaps.listSkills(memberScope), {
    code: 'FORBIDDEN',
  });
  assert.equal(
    (await new PostgresCapabilityRepository(worker).listSkills(scope)).length,
    0,
  );
  await assert.rejects(workerCaps.setSkillEnabled(scope, installed.id, false), {
    code: 'FORBIDDEN',
  });
  const usage: Omit<CapabilityUsage, 'id' | 'createdAt' | 'actorId'> = {
    kind: 'skill',
    resourceId: installed.id,
    projectId: project.id,
    version: '1.0.0',
    status: 'succeeded',
    summary: 'worker scoped load',
  };
  await workerCaps.recordUsage(scope, usage);
  await assert.rejects(
    workerCaps.recordUsage(scope, { ...usage, projectId: projectB.id }),
    { code: 'FORBIDDEN' },
  );
  await fixture.query(
    `UPDATE tandem.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [job.id],
  );
  await assert.rejects(workerCaps.listSkills(scope), { code: 'FORBIDDEN' });

  await projects.grant(scope, project.id, member.identity.id, 'editor');
  await projects.grant(scope, project.id, owner.identity.id, 'viewer');
  assert.equal(
    (await caps.ownerSession(memberScope, project.id, team.id, false)).identity
      .id,
    owner.identity.id,
  );
  await assert.rejects(
    caps.ownerSession(memberScope, project.id, team.id, true),
    { code: 'FORBIDDEN' },
  );
  await fixture.query(
    `UPDATE tandem.project_grants SET role='editor' WHERE workspace_id=$1 AND project_id=$2 AND identity_id=$3`,
    [space.id, project.id, owner.identity.id],
  );

  const updated = await service.saveServer(scope, {
    id: server.id,
    expectedRevision: tested.revision,
    name: '新地址配置',
    connection: { type: 'http', url: 'http://127.0.0.1:2/mcp' },
  });
  assert.equal(updated.credentialConfigured, false);
  assert.equal(await caps.credential(scope, server.id), null);
  assert.equal(await caps.credential(scope, server.id, tested.revision), null);
  await assert.rejects(service.callTool(scope, invocation), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(
    service.callTool(scope, {
      ...invocation,
      expectedRevision: tested.revision,
      expectedSchemaHash: tested.tools[0]!.schemaHash,
    }),
    { code: 'CONFLICT' },
  );
  await service.setSkillEnabled(scope, installed.id, false);
  await assert.rejects(
    service.resolveSkills(scope, {
      ...binding,
      versions: [{ skillId: installed.id, versionId: initialVersion.id }],
    }),
    { code: 'FORBIDDEN' },
  );
  await service.removeServer(scope, server.id);
  assert.equal((await service.listServers(scope)).length, 0);
  await assert.rejects(caps.getServer(scope, server.id), { code: 'FORBIDDEN' });
  assert.ok((await service.usage(scope, project.id)).length > 0);
  await projects.grant(scope, project.id, member.identity.id, null);
  assert.equal((await caps.toolGrants(memberScope, project.id)).length, 0);
  console.log(
    '能力集成通过：真实 PG 迁移、不可变技能资源/版本、固定绑定、跨空间项目团队隔离、个人凭证、配置版本、停用移除、Worker 原身份/项目/团队/租约 RLS 与审计。',
  );
} finally {
  await Promise.all([app.end(), worker.end(), fixture.end()]);
  if (/^tandem_caps_[a-f0-9]{32}$/.test(name))
    await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await admin.end();
}
