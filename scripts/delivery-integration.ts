import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import {
  createPool,
  PostgresCollaborationRepository,
  PostgresDeliveryRepository,
  PostgresProjectsRepository,
  PostgresJobQueue,
} from '../packages/storage-postgres/src/index';
import type {
  DeliveryStart,
  DraftFence,
  DeploymentReceipt,
  ExtensionDraftAction,
  StoredSession,
} from '../packages/core/src/index';
const keys = [
  'DATABASE_ADMIN_URL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'WORKER_DATABASE_URL',
] as const;
for (const key of keys)
  if (!process.env[key]) throw new Error('请先初始化.env');
const name = 'tandem_delivery_' + randomUUID().replaceAll('-', '');
const env = { ...process.env };
for (const key of keys) {
  const address = new URL(process.env[key]!);
  address.pathname = '/' + name;
  env[key] = address.href;
}
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
await admin.query('CREATE DATABASE ' + name);
const app = createPool(env.DATABASE_URL!);
const worker = createPool(env.WORKER_DATABASE_URL!);
const fixture = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
const collaboration = new PostgresCollaborationRepository(app);
const repository = new PostgresDeliveryRepository(app);
const workerRepository = new PostgresDeliveryRepository(worker);
const projects = new PostgresProjectsRepository(app);
const workerProjects = new PostgresProjectsRepository(worker);
const queue = new PostgresJobQueue(worker);
const script = (path: string) =>
  new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(path + ' failed')),
    );
  });
try {
  await script('scripts/db-bootstrap.ts');
  await script('scripts/db-migrate.ts');
  await fixture.connect();
  const session = await collaboration.createSession({
    login: {
      providerId: 'delivery-test',
      subject: '张三',
      displayName: '张三',
      canCreateWorkspace: true,
    },
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    encryptedCredential: 'isolated-test-credential',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const workspace = await collaboration.createWorkspace(
    session.identity.id,
    '交付隔离测试',
    randomUUID(),
  );
  const scope = { workspaceId: workspace.id, actorId: session.identity.id };
  const project = await projects.bind(scope, 'delivery-test', '1');
  const input: DeliveryStart = {
    workspaceId: workspace.id,
    projectId: project.id,
    goal: '隔离交付测试',
    acceptance: '验证预算、租约、重启、审批版本',
    mode: 'deploy',
    budgetCalls: 10,
    budgetTokens: 100000,
    maxRevisions: 1,
    requestId: randomUUID(),
  };
  const run = await repository.start(session, input);
  assert.equal((await repository.start(session, input)).id, run.id);
  await assert.rejects(repository.start(session, { ...input, goal: '冲突' }));
  const workerId = randomUUID();
  const job = await queue.claim(workerId, 30000);
  assert.equal(job?.reference, run.id);
  const fence = { job: job!, workerId };
  const context = await workerRepository.workerContext(fence);
  assert.equal(context?.run.actorId, session.identity.id);
  assert.deepEqual(context?.documents, []);
  assert.equal(await workerRepository.reserveCall(fence, 1000), true);
  await workerRepository.settleCall(fence, 1000, 700);
  assert.equal(
    await workerRepository.checkpoint(fence, {
      status: 'running',
      phase: 'architecture',
      event: {
        kind: 'design_completed',
        role: 'designer',
        summary: '设计保存',
      },
      document: {
        kind: 'design',
        role: 'designer',
        content: '隔离测试设计文档',
      },
    }),
    true,
  );
  assert.equal((await repository.detail(scope, run.id)).run.usedTokens, 700);
  assert.equal(
    await workerRepository.checkpoint(
      { ...fence, job: { ...job!, token: '999999' } },
      { event: { kind: 'stale', summary: '过期写入' } },
    ),
    false,
  );
  await repository.control(scope, run.id, 'pause', session.id);
  assert.equal(await queue.renew(job!, workerId, 30000), false);
  await repository.extendBudget(scope, run.id, 20, 200000);
  await repository.control(scope, run.id, 'resume', session.id);
  const next = await queue.claim(workerId, 30000);
  assert.ok(next);
  const resumed = { job: next, workerId };
  const resumedContext = await workerRepository.workerContext(resumed);
  assert.equal(resumedContext?.run.usedCalls, 1);
  assert.equal(resumedContext?.run.usedTokens, 700);
  assert.equal(resumedContext?.run.budgetTokens, 200000);
  assert.equal(resumedContext?.documents[0]?.content, '隔离测试设计文档');
  const artifact = {
    artifactRef: `artifacts/${run.id}/0-test`,
    contentHash: 'a'.repeat(64),
    files: [],
    commands: [],
    passed: true,
    verifiedAt: new Date().toISOString(),
  };
  await workerRepository.checkpoint(resumed, {
    phase: 'delivery',
    status: 'running',
    artifact,
    event: { kind: 'verified', summary: '隔离DB版本测试证据' },
  });
  const action = {
    kind: 'delivery.deploy' as const,
    runId: run.id,
    artifactRef: artifact.artifactRef,
    contentHash: artifact.contentHash,
    version: 0,
  };
  const requestId = randomUUID();
  const draft = await workerProjects.createWorkerDraft(
    resumed,
    '部署隔离测试',
    action,
    requestId,
  );
  assert.equal(draft.actorId, session.identity.id);
  assert.equal(draft.sessionId, session.id);
  await assert.rejects(
    workerProjects.createWorkerDraft(
      resumed,
      '错误摘要',
      { ...action, contentHash: 'b'.repeat(64) },
      randomUUID(),
    ),
  );
  await workerRepository.checkpoint(resumed, {
    status: 'awaiting_deployment',
    event: { kind: 'waiting_approval', summary: '等待统一草案审批' },
  });
  await queue.complete(next, workerId);
  await projects.reviewDraft(scope, draft.id, 1, true);
  const deploymentJob = await queue.claim(workerId, 30000);
  assert.equal(deploymentJob?.kind, 'draft.execute');
  const deploymentFence = { job: deploymentJob!, workerId };
  assert.equal(
    (await workerProjects.workerContext(deploymentFence))?.draft.id,
    draft.id,
  );
  assert.equal(await workerProjects.beginAction(deploymentFence), true);
  assert.equal(
    (await workerRepository.deploymentContext(deploymentFence))?.run.id,
    run.id,
  );
  const receipt: DeploymentReceipt = {
    id: draft.id,
    artifactRef: artifact.artifactRef,
    contentHash: artifact.contentHash,
    version: 0,
    status: 'healthy',
    environment: 'local-demo',
    healthCheckedAt: new Date().toISOString(),
    previousDeploymentId: null,
  };
  assert.equal(
    await workerRepository.recordDeployment(deploymentFence, run.id, {
      ...receipt,
      contentHash: 'b'.repeat(64),
    }),
    false,
  );
  assert.equal(
    await workerRepository.recordDeployment(deploymentFence, run.id, receipt),
    true,
  );
  assert.equal(
    await workerRepository.deploymentWriteAllowed(deploymentFence),
    true,
  );
  assert.equal(
    (await repository.detail(scope, run.id)).run.status,
    'delivered',
  );
  await workerProjects.finishAction(deploymentFence, {
    status: 'succeeded',
    receipt: { status: 'healthy', reference: draft.id },
  });
  await queue.complete(deploymentJob!, workerId);
  await fixture.query(
    "UPDATE tandem.project_drafts SET status='unknown' WHERE id=$1",
    [draft.id],
  );
  assert.equal(
    (
      await repository.reconciliationContext(
        scope,
        run.id,
        draft.id,
        session.id,
      )
    ).draft.id,
    draft.id,
  );
  await assert.rejects(
    repository.recordReconciliation(
      scope,
      run.id,
      draft.id,
      session.id,
      { ...receipt, contentHash: 'b'.repeat(64) },
      false,
    ),
  );
  await repository.recordReconciliation(
    scope,
    run.id,
    draft.id,
    session.id,
    receipt,
    false,
  );
  assert.equal((await projects.draft(scope, draft.id)).status, 'succeeded');
  const uncertain = await repository.start(session, {
    ...input,
    requestId: randomUUID(),
  });
  const uncertainJob = await queue.claim(workerId, 30000);
  assert.equal(uncertainJob?.reference, uncertain.id);
  const uncertainFence = { job: uncertainJob!, workerId };
  const uncertainArtifact = {
    ...artifact,
    artifactRef: `artifacts/${uncertain.id}/0-test`,
  };
  await workerRepository.checkpoint(uncertainFence, {
    phase: 'delivery',
    status: 'running',
    artifact: uncertainArtifact,
    event: { kind: 'test', summary: '结果未知恢复测试' },
  });
  const uncertainDraft = await workerProjects.createWorkerDraft(
    uncertainFence,
    '结果未知部署',
    {
      ...action,
      runId: uncertain.id,
      artifactRef: uncertainArtifact.artifactRef,
    },
    randomUUID(),
  );
  await workerRepository.checkpoint(uncertainFence, {
    status: 'awaiting_deployment',
    event: { kind: 'wait', summary: '待审批' },
  });
  await queue.complete(uncertainJob!, workerId);
  await projects.reviewDraft(scope, uncertainDraft.id, 1, true);
  const uncertainExecution = await queue.claim(workerId, 30000);
  const uncertainExecutionFence = { job: uncertainExecution!, workerId };
  assert.equal(await workerProjects.beginAction(uncertainExecutionFence), true);
  await workerProjects.finishAction(uncertainExecutionFence, {
    status: 'unknown',
    error: 'TEST_RESULT_UNKNOWN',
  });
  await queue.complete(uncertainExecution!, workerId);
  await assert.rejects(
    repository.control(scope, uncertain.id, 'resume', session.id),
  );
  await assert.rejects(
    repository.recordReconciliation(
      scope,
      uncertain.id,
      uncertainDraft.id,
      session.id,
      null,
      false,
    ),
  );
  await repository.recordReconciliation(
    scope,
    uncertain.id,
    uncertainDraft.id,
    session.id,
    null,
    true,
  );
  assert.equal(
    (await projects.draft(scope, uncertainDraft.id)).status,
    'unknown',
  );
  await repository.control(scope, uncertain.id, 'resume', session.id);
  const continued = await queue.claim(workerId, 30000);
  assert.equal(continued?.reference, uncertain.id);
  await repository.control(scope, uncertain.id, 'cancel', session.id);
  const origin = await repository.start(session, {
    ...input,
    mode: 'demo',
    requestId: randomUUID(),
  });
  const originJob = await queue.claim(workerId, 30000);
  assert.equal(originJob?.reference, origin.id);
  const originContext = await workerRepository.workerContext({
    job: originJob!,
    workerId,
  });
  const toolDraft = await workerProjects.createWorkerDraft(
    { job: originJob!, workerId },
    '取消原运行工具测试',
    {
      kind: 'mcp.call',
      serverId: randomUUID(),
      serverRevision: 1,
      toolName: 'write',
      schemaHash: 'c'.repeat(64),
      projectId: project.id,
      teamId: originContext!.run.teamId,
      agentRole: 'engineer',
      arguments: { name: 'isolated' },
    },
    randomUUID(),
  );
  await workerRepository.checkpoint(
    { job: originJob!, workerId },
    { status: 'needs_decision', event: { kind: 'wait', summary: '工具待审' } },
  );
  await queue.complete(originJob!, workerId);
  await projects.reviewDraft(scope, toolDraft.id, 1, true);
  const toolJob = await queue.claim(workerId, 30000);
  assert.equal(toolJob?.reference, toolDraft.id);
  await repository.control(scope, origin.id, 'cancel', session.id);
  assert.equal((await projects.draft(scope, toolDraft.id)).status, 'failed');
  assert.equal(
    await workerProjects.beginAction({ job: toolJob!, workerId }),
    false,
  );
  assert.equal(await queue.renew(toolJob!, workerId, 30000), false);
  const member = await collaboration.createSession({
    login: {
      providerId: 'delivery-test',
      subject: '李四',
      displayName: '李四',
      canCreateWorkspace: false,
    },
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    encryptedCredential: 'isolated-member-credential',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await collaboration.setMember(
    session.identity.id,
    workspace.id,
    member.identity.id,
    'admin',
  );
  await projects.grant(scope, project.id, member.identity.id, 'editor');
  const memberScope = {
    workspaceId: workspace.id,
    actorId: member.identity.id,
  };
  const reloginActor = () =>
    collaboration.createSession({
      login: {
        providerId: session.identity.providerId,
        subject: session.identity.subject,
        displayName: session.identity.displayName,
        canCreateWorkspace: session.identity.canCreateWorkspace,
      },
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      encryptedCredential: 'isolated-relogin-credential',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
  async function approvedDraft(
    authSession: StoredSession,
    deploymentAction: ExtensionDraftAction,
  ) {
    const proposed = await projects.createDraft(
      { workspaceId: workspace.id, actorId: authSession.identity.id },
      authSession.id,
      project.id,
      '新会话部署权限测试',
      deploymentAction,
      randomUUID(),
    );
    await projects.reviewDraft(scope, proposed.id, 1, true);
    const claimed = await queue.claim(workerId, 30000);
    assert.equal(claimed?.reference, proposed.id);
    return { draft: proposed, fence: { job: claimed!, workerId } };
  }
  async function finishPublication(
    deploymentFence: DraftFence,
    publication: DeploymentReceipt,
  ) {
    assert.equal(await workerProjects.beginAction(deploymentFence), true);
    assert.equal(
      await workerRepository.recordDeployment(
        deploymentFence,
        run.id,
        publication,
      ),
      true,
    );
    await workerProjects.finishAction(deploymentFence, {
      status: 'succeeded',
      receipt: { status: publication.status, reference: publication.id },
    });
    await queue.complete(deploymentFence.job, workerId);
  }
  const relogged = await reloginActor();
  assert.equal(relogged.identity.id, session.identity.id);
  assert.notEqual(relogged.id, session.id);
  const redeploy = await approvedDraft(relogged, action);
  // The new immutable draft owns execution credentials. The old run session is
  // history, so its revocation must not replace or invalidate the new session.
  await fixture.query(
    'UPDATE tandem.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
    [session.id],
  );
  const reloggedContext = await workerRepository.deploymentContext(
    redeploy.fence,
  );
  assert.equal(reloggedContext?.session.id, relogged.id);
  assert.equal(reloggedContext?.session.identity.id, session.identity.id);
  assert.equal(reloggedContext?.run.sessionId, session.id);
  assert.equal(
    await workerRepository.deploymentWriteAllowed(redeploy.fence),
    true,
  );
  assert.equal(
    await workerRepository.deploymentContext({
      ...redeploy.fence,
      job: { ...redeploy.fence.job, token: '999999' },
    }),
    null,
  );
  await fixture.query(
    'UPDATE tandem.sessions SET revoked_at=NULL WHERE id=$1',
    [session.id],
  );
  await finishPublication(redeploy.fence, {
    ...receipt,
    id: redeploy.draft.id,
    previousDeploymentId: receipt.id,
  });
  const rollbackSession = await reloginActor();
  const rollback = await approvedDraft(rollbackSession, {
    kind: 'delivery.rollback',
    runId: run.id,
    deploymentId: redeploy.draft.id,
    contentHash: artifact.contentHash,
    version: 0,
  });
  assert.equal(
    (await workerRepository.deploymentContext(rollback.fence))?.session.id,
    rollbackSession.id,
  );
  await finishPublication(rollback.fence, {
    ...receipt,
    id: rollback.draft.id,
    status: 'rolled_back',
    previousDeploymentId: redeploy.draft.id,
  });
  assert.equal(
    (await repository.detail(scope, run.id)).run.sessionId,
    session.id,
  );
  assert.equal(
    (await repository.detail(scope, run.id)).run.deployment?.status,
    'rolled_back',
  );

  const wrongActor = await approvedDraft(member, action);
  assert.ok(await workerProjects.workerContext(wrongActor.fence));
  assert.equal(
    await workerRepository.deploymentContext(wrongActor.fence),
    null,
  );
  assert.equal(
    await workerRepository.deploymentWriteAllowed(wrongActor.fence),
    false,
  );
  await workerProjects.finishAction(wrongActor.fence, {
    status: 'failed',
    error: 'ACTOR_SCOPE_MISMATCH',
  });
  await queue.complete(wrongActor.fence.job, workerId);
  for (const invalidation of ['revoked', 'expired'] as const) {
    const invalidSession = await reloginActor();
    const invalidDraft = await approvedDraft(invalidSession, action);
    if (invalidation === 'revoked')
      await fixture.query(
        'UPDATE tandem.sessions SET revoked_at=clock_timestamp() WHERE id=$1',
        [invalidSession.id],
      );
    else
      await fixture.query(
        "UPDATE tandem.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [invalidSession.id],
      );
    // A newer valid login cannot rescue the already-approved draft's invalid
    // frozen session; the approver/session may never be silently substituted.
    await reloginActor();
    assert.equal(
      await workerRepository.deploymentContext(invalidDraft.fence),
      null,
    );
    assert.equal(
      await workerRepository.deploymentWriteAllowed(invalidDraft.fence),
      false,
    );
    assert.equal(await workerProjects.beginAction(invalidDraft.fence), false);
    assert.equal(await workerProjects.workerContext(invalidDraft.fence), null);
    assert.equal(
      (await projects.draft(scope, invalidDraft.draft.id)).status,
      'failed',
    );
    await queue.complete(invalidDraft.fence.job, workerId);
  }
  const ownerWrite = await repository.start(member, {
    ...input,
    requestId: randomUUID(),
  });
  const ownerWriteJob = await queue.claim(workerId, 30000);
  assert.equal(ownerWriteJob?.reference, ownerWrite.id);
  const ownerWriteFence = { job: ownerWriteJob!, workerId };
  const ownerWriteArtifact = {
    ...artifact,
    artifactRef: `artifacts/${ownerWrite.id}/0-test`,
  };
  await workerRepository.checkpoint(ownerWriteFence, {
    status: 'running',
    phase: 'delivery',
    artifact: ownerWriteArtifact,
    event: { kind: 'test', summary: 'owner写权限测试' },
  });
  const ownerWriteDraft = await workerProjects.createWorkerDraft(
    ownerWriteFence,
    'owner写权限',
    {
      ...action,
      runId: ownerWrite.id,
      artifactRef: ownerWriteArtifact.artifactRef,
    },
    randomUUID(),
  );
  await workerRepository.checkpoint(ownerWriteFence, {
    status: 'awaiting_deployment',
    event: { kind: 'wait', summary: '等待审批' },
  });
  await queue.complete(ownerWriteJob!, workerId);
  await projects.reviewDraft(scope, ownerWriteDraft.id, 1, true);
  const ownerWriteExecution = await queue.claim(workerId, 30000);
  const ownerWriteExecutionFence = { job: ownerWriteExecution!, workerId };
  await projects.grant(scope, project.id, session.identity.id, 'viewer');
  assert.ok(await workerRepository.deploymentContext(ownerWriteExecutionFence));
  assert.equal(
    await workerRepository.deploymentWriteAllowed(ownerWriteExecutionFence),
    false,
  );
  await projects.grant(memberScope, project.id, session.identity.id, 'editor');
  assert.equal(
    await workerRepository.deploymentWriteAllowed(ownerWriteExecutionFence),
    true,
  );
  await repository.control(memberScope, ownerWrite.id, 'cancel', member.id);
  const another = await repository.start(session, {
    ...input,
    mode: 'demo',
    requestId: randomUUID(),
  });
  const pending = await queue.claim(workerId, 30000);
  assert.equal(pending?.reference, another.id);
  await projects.grant(scope, project.id, session.identity.id, null);
  assert.equal(
    await workerRepository.workerContext({ job: pending!, workerId }),
    null,
  );
  assert.equal(
    (
      await fixture.query(
        'SELECT status FROM tandem.delivery_runs WHERE id=$1',
        [another.id],
      )
    ).rows[0].status,
    'needs_auth',
  );
  console.log(
    '交付PG集成通过：隔离数据库0001–0009迁移、幂等启动、身份/项目授权、预算与检查点续跑、租约拒写、统一部署版本/摘要、未知结果核对及显式新提案、取消阻断关联工具草案；同actor新会话部署/回滚且保留run原会话，异actor/草案会话撤销或过期拒绝，owner仅viewer时拒绝部署、撤权停止。',
  );
} finally {
  await Promise.all([app.end(), worker.end(), fixture.end()]);
  if (/^tandem_delivery_[a-f0-9]{32}$/.test(name))
    await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await admin.end();
}
