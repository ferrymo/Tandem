import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DomainError } from '../../packages/core/src/index';
import type {
  DeliveryEvidence,
  DeliveryRepository,
  DeliveryWorkerContext,
  DeploymentReceipt,
  DraftExecutionContext,
  DraftFence,
  ExtensionDraftAction,
  Job,
  SkillVersion,
} from '../../packages/core/src/index';
import { runDeliveryJob } from '../../packages/agent-runtime/src/delivery';
import type { DeliveryRuntimePorts } from '../../packages/agent-runtime/src/delivery';
import { validateDeliveryPackage } from '../../adapters/execution/src/index';
import { DeliveryService } from '../../packages/application/src/delivery';
const pkg = {
  files: [
    { path: 'index.html', content: '<!doctype html><title>Demo</title>' },
    {
      path: 'app.test.mjs',
      content:
        'import test from "node:test";import assert from "node:assert/strict";test("add",()=>assert.equal(1+1,2));',
    },
  ],
  testCommands: [['node', '--test', 'app.test.mjs']],
  buildCommands: [],
  previewPath: 'index.html',
  summary: 'Demo',
  limitations: ['模拟数据'],
};
const job: Job = {
  id: 'job',
  workspaceId: 'workspace',
  kind: 'delivery.run',
  reference: 'run',
  token: '1',
  attempts: 1,
  maxAttempts: 3,
  checkpoint: {},
};
function skillVersion(files: Record<string, string>): SkillVersion {
  return {
    id: 'version-1',
    skillId: 'skill-1',
    name: '测试技能',
    version: '1.0.0',
    description: '按需资源读取测试',
    source: { kind: 'upload', label: 'fixture' },
    permissions: [],
    dependencies: [],
    files,
    contentHash: 'fixture-package-hash',
    installedAt: 'now',
  };
}
function fixture() {
  const session = {
    id: 'session',
    identity: {
      id: 'actor',
      providerId: 'test',
      subject: '张三',
      displayName: '张三',
      canCreateWorkspace: true,
    },
    encryptedCredential: 'encrypted',
    expiresAt: '2099-01-01',
  };
  let context: DeliveryWorkerContext = {
    run: {
      id: 'run',
      workspaceId: 'workspace',
      projectId: 'project',
      teamId: 'team',
      actorId: 'actor',
      ownerId: 'actor',
      sessionId: 'session',
      goal: '计算演示',
      acceptance: '计算正确，输入错误可恢复',
      mode: 'demo',
      assignedRole: null,
      status: 'queued',
      phase: 'design',
      revision: 0,
      generation: 0,
      budgetCalls: 20,
      usedCalls: 0,
      budgetTokens: 500000,
      usedTokens: 0,
      maxRevisions: 1,
      error: null,
      createdAt: 'now',
      updatedAt: 'now',
      artifact: null,
      deployment: null,
    },
    session,
    ownerSession: session,
    profiles: {
      designer: { model: '', instructions: '' },
      architect: { model: '', instructions: '' },
      engineer: { model: '', instructions: '' },
    },
    documents: [],
    project: {
      id: 'project',
      workspaceId: 'workspace',
      connectionId: 'test',
      externalId: '1',
      createdBy: 'actor',
      cacheVersion: '1',
      createdAt: 'now',
    },
  };
  const events: string[] = [];
  const repository: DeliveryRepository = {
    start: vi.fn(),
    list: vi.fn(),
    detail: vi.fn(),
    control: vi.fn(),
    profiles: vi.fn(),
    setProfiles: vi.fn(),
    extendBudget: vi.fn(),
    deploymentContext: vi.fn(),
    deploymentWriteAllowed: vi.fn(),
    recordDeployment: vi.fn(),
    withDeploymentLock: async (_fence, work) => work(),
    reconciliationContext: vi.fn(),
    recordReconciliation: vi.fn(),
    workerContext: async () => context,
    reserveCall: async (_fence, tokens) => {
      if (
        context.run.usedCalls >= context.run.budgetCalls ||
        context.run.usedTokens + tokens > context.run.budgetTokens
      )
        return false;
      context = {
        ...context,
        run: {
          ...context.run,
          usedCalls: context.run.usedCalls + 1,
          usedTokens: context.run.usedTokens + tokens,
        },
      };
      return true;
    },
    settleCall: async (_fence, reserved, actual) => {
      context = {
        ...context,
        run: {
          ...context.run,
          usedTokens: context.run.usedTokens - reserved + actual,
        },
      };
    },
    checkpoint: async (_fence, patch) => {
      const { event, document, ...run } = patch;
      events.push(event.kind);
      context = {
        ...context,
        run: { ...context.run, ...run },
        documents: document
          ? [
              ...context.documents,
              {
                ...document,
                version:
                  context.documents.filter((d) => d.kind === document.kind)
                    .length + 1,
                createdAt: 'now',
              },
            ]
          : context.documents,
      };
      return true;
    },
  };
  const evidence: DeliveryEvidence = {
    artifactRef: 'artifacts/run/0-fixture',
    contentHash: 'a'.repeat(64),
    files: [],
    commands: [],
    passed: true,
    verifiedAt: 'now',
  };
  const ports: DeliveryRuntimePorts = {
    repository,
    model: {
      configured: true,
      defaultModel: 'test-model',
      generate: vi.fn(async (input) => ({
        text: input.prompt.includes('输出严格JSON，不附解释')
          ? JSON.stringify(pkg)
          : input.prompt.includes('独立复核实际工程')
            ? JSON.stringify({ approved: true, issues: [] })
            : '根据目标形成的阶段文档',
        totalTokens: 100,
      })),
    },
    execution: {
      configured: true,
      verify: vi.fn(async () => evidence),
      read: vi.fn(),
      deploy: vi.fn(),
      rollback: vi.fn(),
      deploymentFile: vi.fn(),
      inspectDeployment: vi.fn(),
    },
    authorize: vi.fn(async () => undefined),
    capabilities: {
      resolveSkills: vi.fn(async () => []),
      listTools: vi.fn(async () => []),
      callTool: vi.fn(),
    },
    proposeDeployment: vi.fn(async () => ({ id: 'draft' })),
  };
  return {
    ports,
    evidence,
    events,
    read: () => context,
    update: (patch: Partial<DeliveryWorkerContext['run']>) => {
      context = { ...context, run: { ...context.run, ...patch } };
    },
    signal: new AbortController().signal,
  };
}
describe('T组持久化运行', () => {
  it('通过真实执行端口及双重复核后才交付Demo', async () => {
    const f = fixture();
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('delivered');
    expect(f.read().run.usedCalls).toBe(5);
    expect(f.ports.execution.verify).toHaveBeenCalledOnce();
    expect(f.ports.execution.deploy).not.toHaveBeenCalled();
    expect(
      f.read().documents.filter((d) => d.kind.startsWith('skills.')),
    ).toHaveLength(3);
    expect(
      f.read().documents.filter((d) => d.kind.startsWith('tools.')),
    ).toHaveLength(3);
    expect(f.events).toContain('review_completed');
  });
  it('模型未配置时保留可续跑状态且不伪造产物', async () => {
    const f = fixture();
    f.ports.model = { ...f.ports.model, configured: false };
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('needs_configuration');
    expect(f.read().run.artifact).toBeNull();
    expect(f.read().run.usedCalls).toBe(0);
  });
  it('双重复核实际收到前序设计、架构与执行环境证据', async () => {
    const f = fixture();
    const design = '设计文档v1：支持输入校验、空态和键盘提交';
    const architecture = '架构文档v1：共享业务源构建为内联经典脚本';
    const execution = {
      kind: 'docker',
      image: 'node@sha256:' + 'a'.repeat(64),
      network: 'none',
      user: '1000:1000',
      browserValidation: 'not_performed',
    } as const;
    vi.mocked(f.ports.model.generate)
      .mockResolvedValueOnce({ text: design, totalTokens: 100 })
      .mockResolvedValueOnce({ text: architecture, totalTokens: 100 });
    vi.mocked(f.ports.execution.verify).mockResolvedValueOnce({
      ...f.evidence,
      execution,
    });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('delivered');
    const reviews = vi
      .mocked(f.ports.model.generate)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.prompt.includes('独立复核实际工程'));
    expect(reviews).toHaveLength(2);
    for (const input of reviews) {
      expect(input.prompt).toContain(design);
      expect(input.prompt).toContain(architecture);
      expect(input.prompt).toContain(JSON.stringify(execution));
    }
  });
  it('首次授权失败也明确落状态', async () => {
    const f = fixture();
    f.ports.authorize = async () => {
      throw new DomainError('FORBIDDEN', '撤权');
    };
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('needs_auth');
    expect(f.ports.model.generate).not.toHaveBeenCalled();
  });
  it('截断响应精确结算但不推进阶段，续跑保留累计调用与token', async () => {
    const f = fixture();
    vi.mocked(f.ports.model.generate).mockResolvedValueOnce({
      text: '截断的设计文档不应保存为完成',
      totalTokens: 1234,
      truncated: true,
    });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run).toMatchObject({
      status: 'needs_decision',
      phase: 'design',
      usedCalls: 1,
      usedTokens: 1234,
    });
    expect(
      f.read().documents.some((document) => document.kind === 'design'),
    ).toBe(false);
    expect(f.ports.execution.verify).not.toHaveBeenCalled();
    f.update({ status: 'queued', generation: 1 });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run).toMatchObject({
      status: 'delivered',
      usedCalls: 6,
      usedTokens: 1734,
    });
    expect(JSON.stringify(f.read().documents)).not.toContain('截断的设计文档');
  });
  it('非合约文件元素进入有限返工，既有坏工程也能从test阶段续跑恢复', async () => {
    const f = fixture();
    // A previously saved package passed the shallow runtime JSON check. Resume
    // must convert its input failure into rework instead of repeating TypeError.
    f.update({ phase: 'implementation' });
    vi.mocked(f.ports.model.generate).mockResolvedValueOnce({
      text: JSON.stringify({ ...pkg, files: [null, pkg.files[1]] }),
      totalTokens: 100,
    });
    vi.mocked(f.ports.execution.verify)
      .mockRejectedValueOnce(new Error('模拟升级前旧执行器的TypeError'))
      .mockImplementationOnce(async ({ package: value }) => {
        validateDeliveryPackage(value);
        throw new Error('坏工程不应通过');
      });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run).toMatchObject({
      status: 'failed',
      phase: 'test',
      usedCalls: 1,
    });
    f.update({ status: 'queued', generation: 1 });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run).toMatchObject({
      status: 'delivered',
      revision: 1,
      usedCalls: 4,
    });
    expect(
      f.read().documents.find((document) => document.kind === 'issues')
        ?.content,
    ).toContain('隔离执行前校验未通过');
  });
  it('新生成的非合约文件元素直接触发有限返工，不会落入无法恢复的failed', async () => {
    const f = fixture();
    f.update({ phase: 'implementation' });
    vi.mocked(f.ports.model.generate).mockResolvedValueOnce({
      text: JSON.stringify({ ...pkg, files: [null, pkg.files[1]] }),
      totalTokens: 100,
    });
    vi.mocked(f.ports.execution.verify).mockImplementation(
      async ({ package: value }) => {
        validateDeliveryPackage(value);
        return f.evidence;
      },
    );
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run).toMatchObject({
      status: 'delivered',
      revision: 1,
      usedCalls: 4,
    });
    expect(f.events).toContain('revision_requested');
    expect(f.events).not.toContain('interrupted');
  });
  it('失败测试触发有限修订并保留累计调用预算', async () => {
    const f = fixture();
    vi.mocked(f.ports.execution.verify).mockResolvedValueOnce({
      artifactRef: 'failed',
      contentHash: 'bad',
      files: [],
      commands: [
        {
          command: ['node', '--test'],
          exitCode: 1,
          output: 'assertion failed',
        },
      ],
      passed: false,
      verifiedAt: 'now',
    });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('delivered');
    expect(f.read().run.revision).toBe(1);
    expect(f.read().run.usedCalls).toBe(6);
    expect(f.ports.execution.verify).toHaveBeenCalledTimes(2);
    expect(
      f.read().documents.find((d) => d.kind === 'issues')?.content,
    ).toContain('assertion failed');
  });
  it('预算不足停止模型请求，续跑不重置预算', async () => {
    const f = fixture();
    f.update({ usedCalls: 20 });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('needs_decision');
    expect(f.read().run.usedCalls).toBe(20);
    expect(f.ports.model.generate).not.toHaveBeenCalled();
  });
  it('部署模式只生成统一草案，审批前绝不执行部署', async () => {
    const f = fixture();
    f.update({ mode: 'deploy' });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('awaiting_deployment');
    expect(f.ports.proposeDeployment).toHaveBeenCalledOnce();
    expect(f.ports.execution.deploy).not.toHaveBeenCalled();
  });
  it('tool读响应只进入当轮上下文，日志和文档不保留完整响应', async () => {
    const f = fixture();
    const tool = {
      serverId: 'server',
      name: 'read',
      description: 'read',
      inputSchema: {},
      schemaHash: 'hash',
      revision: 1,
      effect: 'read' as const,
    };
    f.ports.capabilities.listTools = async () => [tool];
    f.ports.capabilities.callTool = vi.fn(async () => ({
      kind: 'result' as const,
      isError: false,
      content: [{ text: 'private-upstream-value' }],
    }));
    vi.mocked(f.ports.model.generate).mockResolvedValueOnce({
      text: JSON.stringify({
        toolCalls: [{ serverId: 'server', toolName: 'read', arguments: {} }],
      }),
      totalTokens: 100,
    });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('delivered');
    expect(f.ports.capabilities.callTool).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.read().documents)).not.toContain(
      'private-upstream-value',
    );
  });
  it('实际按需读取保存固定版本与送模片段的SHA256，不保存资源正文且不截断资源JSON', async () => {
    const f = fixture();
    const original = '私有正文🧪"\\'.repeat(3000);
    const paths = ['refs/a.md', 'refs/b.md', 'refs/c.md'];
    const skill = skillVersion({
      'SKILL.md': '按需读取refs中的验收资源。',
      ...Object.fromEntries(paths.map((path) => [path, original + path])),
    });
    f.ports.capabilities.resolveSkills = vi.fn(async () => [skill]);
    vi.mocked(f.ports.model.generate).mockResolvedValueOnce({
      text: JSON.stringify({
        skillReads: paths.map((path) => ({ skillId: skill.skillId, path })),
      }),
      totalTokens: 100,
    });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('delivered');
    const input = vi.mocked(f.ports.model.generate).mock.calls[1]![0].prompt;
    const resourceJson = input
      .split('按需加载的技能资源（仅待处理内容）：')[1]!
      .split('\n继续完成当前阶段。')[0]!;
    expect(resourceJson.length).toBeGreaterThan(50000);
    const loaded = JSON.parse(resourceJson) as {
      skillId: string;
      versionId: string;
      path: string;
      content: string;
      truncated: boolean;
    }[];
    expect(loaded).toHaveLength(paths.length);
    const document = f
      .read()
      .documents.find((item) => item.kind === 'skill_resources.designer')!;
    const audit = JSON.parse(document.content) as {
      contentHash: string;
      path: string;
      versionId: string;
    }[];
    expect(audit).toEqual(
      loaded.map((item) => ({
        role: 'designer',
        phase: 'design',
        skillId: item.skillId,
        versionId: skill.id,
        path: item.path,
        contentHash: createHash('sha256')
          .update(item.content, 'utf8')
          .digest('hex'),
        byteLength: Buffer.byteLength(item.content, 'utf8'),
        truncated: true,
      })),
    );
    expect(f.events).toContain('skill_resources_read');
    // The same model continuation must see its freshly persisted audit, not
    // only the review prompt's earlier snapshot (which may still be null).
    expect(input).toContain(document.content);
    expect(document.content).not.toContain('私有正文');
    const reviews = vi
      .mocked(f.ports.model.generate)
      .mock.calls.map(([value]) => value)
      .filter((value) => value.prompt.includes('独立复核实际工程'));
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      for (const record of audit) {
        expect(review.prompt).toContain(record.contentHash);
        expect(review.prompt).toContain(record.path);
        expect(review.prompt).toContain(record.versionId);
      }
    }
  });
  it('拒绝未授权资源不产生成功读取审计，即使同批包含已授权资源', async () => {
    const f = fixture();
    const skill = skillVersion({
      'SKILL.md': 'fixture',
      'refs/allowed.md': '已授权正文',
    });
    f.ports.capabilities.resolveSkills = vi.fn(async () => [skill]);
    vi.mocked(f.ports.model.generate).mockResolvedValueOnce({
      text: JSON.stringify({
        skillReads: [
          { skillId: skill.skillId, path: 'refs/allowed.md' },
          { skillId: 'unauthorized-skill', path: 'refs/private.md' },
        ],
      }),
      totalTokens: 100,
    });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('needs_auth');
    expect(f.events).not.toContain('skill_resources_read');
    expect(
      f
        .read()
        .documents.some((item) => item.kind.startsWith('skill_resources.')),
    ).toBe(false);
    expect(f.ports.model.generate).toHaveBeenCalledOnce();
  });
  it.each([
    null,
    { skillId: 'skill-1' },
    { skillId: 123, path: 'refs/a.md' },
    { skillId: 'skill-1', path: [] },
  ])(
    'skillReads元素格式错误（%s）进入INVALID_INPUT状态且不伪造读取记录',
    async (read) => {
      const f = fixture();
      vi.mocked(f.ports.model.generate).mockResolvedValueOnce({
        text: JSON.stringify({ skillReads: [read] }),
        totalTokens: 100,
      });
      await runDeliveryJob(job, 'worker', f.ports, f.signal);
      expect(f.read().run.status).toBe('needs_decision');
      expect(f.read().run.error).toContain('技能资源读取格式');
      expect(f.events).not.toContain('skill_resources_read');
      expect(
        f
          .read()
          .documents.some((item) => item.kind.startsWith('skill_resources.')),
      ).toBe(false);
    },
  );
  it('待审批工具检查点不能通过续跑重新问模型来绕过', async () => {
    const f = fixture();
    f.ports.capabilities.listTools = async () => [
      {
        serverId: 'server',
        name: 'write',
        description: 'write',
        inputSchema: {},
        schemaHash: 'frozen',
        revision: 1,
        effect: 'write',
      },
    ];
    f.ports.capabilities.callTool = vi.fn(async () => ({
      kind: 'proposal' as const,
      draftId: 'original-draft',
    }));
    vi.mocked(f.ports.model.generate).mockResolvedValueOnce({
      text: JSON.stringify({
        toolCalls: [
          {
            serverId: 'server',
            toolName: 'write',
            arguments: { name: 'reviewed' },
          },
        ],
      }),
      totalTokens: 100,
    });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('needs_decision');
    expect(
      f.read().documents.find((d) => d.kind === 'pending_tool')?.content,
    ).toContain('original-draft');
    f.update({ status: 'queued', generation: 1 });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('needs_decision');
    expect(f.ports.model.generate).toHaveBeenCalledOnce();
    expect(
      vi.mocked(f.ports.capabilities.callTool).mock.calls[0]?.[2],
    ).toMatchObject({ expectedRevision: 1, expectedSchemaHash: 'frozen' });
    f.ports.capabilities.callTool = vi.fn(async () => ({
      kind: 'result' as const,
      isError: false,
      content: [{ status: 'succeeded', reference: 'original-draft' }],
    }));
    f.update({ status: 'queued', generation: 2 });
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('delivered');
  });
});
describe('批准部署的冻结会话', () => {
  function deploymentFixture(kind: 'delivery.deploy' | 'delivery.rollback') {
    const f = fixture();
    f.update({ status: 'delivered', phase: 'delivery', artifact: f.evidence });
    const draftSession = { ...f.read().session, id: 'draft-session' };
    const delivery: DeliveryWorkerContext = {
      ...f.read(),
      session: draftSession,
    };
    const action: ExtensionDraftAction =
      kind === 'delivery.deploy'
        ? {
            kind,
            runId: 'run',
            artifactRef: f.evidence.artifactRef,
            contentHash: f.evidence.contentHash,
            version: 0,
          }
        : {
            kind,
            runId: 'run',
            deploymentId: 'prior-deployment',
            contentHash: f.evidence.contentHash,
            version: 0,
          };
    const context: DraftExecutionContext = {
      draft: {
        id: 'approved-draft',
        workspaceId: 'workspace',
        projectId: 'project',
        actorId: 'actor',
        sessionId: draftSession.id,
        title: '获批部署',
        version: 1,
        action,
        status: 'executing',
        reviewerId: 'reviewer',
        reviewedAt: 'now',
        createdAt: 'now',
        updatedAt: 'now',
        receipt: null,
        error: null,
      },
      session: draftSession,
      project: delivery.project,
    };
    const fence: DraftFence = {
      job: { ...job, kind: 'draft.execute', reference: context.draft.id },
      workerId: 'worker',
    };
    const receipt: DeploymentReceipt = {
      id: context.draft.id,
      artifactRef: f.evidence.artifactRef,
      contentHash: f.evidence.contentHash,
      version: 0,
      status: kind === 'delivery.deploy' ? 'healthy' : 'rolled_back',
      environment: 'local-demo',
      healthCheckedAt: 'now',
      previousDeploymentId: 'prior-deployment',
    };
    vi.mocked(f.ports.repository.deploymentContext).mockResolvedValue(delivery);
    vi.mocked(f.ports.repository.deploymentWriteAllowed).mockResolvedValue(
      true,
    );
    vi.mocked(f.ports.repository.recordDeployment).mockResolvedValue(true);
    vi.mocked(f.ports.execution.deploy).mockResolvedValue(receipt);
    vi.mocked(f.ports.execution.rollback).mockResolvedValue(receipt);
    const authorization = { assertProject: vi.fn(async () => undefined) };
    const service = new DeliveryService(f.ports.repository, authorization);
    return {
      ...f,
      delivery,
      context,
      action,
      fence,
      receipt,
      authorization,
      service,
    };
  }
  it.each(['delivery.deploy', 'delivery.rollback'] as const)(
    '同actor重新登录后按草案冻结session执行%s',
    async (kind) => {
      const f = deploymentFixture(kind);
      const result = await f.service.executeApprovedDeployment(
        f.context,
        f.action,
        f.fence,
        f.ports.execution,
        f.signal,
      );
      expect(result).toMatchObject({
        status: f.receipt.status,
        reference: f.context.draft.id,
      });
      expect(f.authorization.assertProject.mock.calls).toEqual([
        [f.context.session, 'workspace', 'project', true],
        [f.delivery.ownerSession, 'workspace', 'project', true],
      ]);
      expect(f.ports.repository.deploymentWriteAllowed).toHaveBeenCalledTimes(
        2,
      );
      expect(f.ports.repository.recordDeployment).toHaveBeenCalledWith(
        f.fence,
        'run',
        f.receipt,
      );
      expect(f.read().run.sessionId).toBe('session');
      if (kind === 'delivery.deploy') {
        expect(f.ports.execution.deploy).toHaveBeenCalledWith({
          runId: 'run',
          projectId: 'project',
          artifact: f.evidence,
          approvalId: f.context.draft.id,
          signal: f.signal,
        });
        expect(f.ports.execution.rollback).not.toHaveBeenCalled();
      } else {
        expect(f.ports.execution.rollback).toHaveBeenCalledWith({
          runId: 'run',
          projectId: 'project',
          deploymentId: 'prior-deployment',
          approvalId: f.context.draft.id,
          signal: f.signal,
        });
        expect(f.ports.execution.deploy).not.toHaveBeenCalled();
      }
    },
  );
  it.each([
    'run-actor',
    'delivery-session',
    'delivery-identity',
    'draft-session',
    'draft-identity',
  ] as const)('冻结草案与执行身份不一致时拒绝：%s', async (mismatch) => {
    const f = deploymentFixture('delivery.deploy');
    let delivery = f.delivery;
    let context = f.context;
    if (mismatch === 'run-actor')
      delivery = {
        ...delivery,
        run: { ...delivery.run, actorId: 'other-actor' },
      };
    if (mismatch === 'delivery-session')
      delivery = {
        ...delivery,
        session: { ...delivery.session, id: 'another-session' },
      };
    if (mismatch === 'delivery-identity')
      delivery = {
        ...delivery,
        session: {
          ...delivery.session,
          identity: { ...delivery.session.identity, id: 'other-actor' },
        },
      };
    if (mismatch === 'draft-session')
      context = {
        ...context,
        session: { ...context.session, id: 'another-session' },
      };
    if (mismatch === 'draft-identity')
      context = {
        ...context,
        session: {
          ...context.session,
          identity: { ...context.session.identity, id: 'other-actor' },
        },
      };
    vi.mocked(f.ports.repository.deploymentContext).mockResolvedValue(delivery);
    await expect(
      f.service.executeApprovedDeployment(
        context,
        f.action,
        f.fence,
        f.ports.execution,
        f.signal,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.authorization.assertProject).not.toHaveBeenCalled();
    expect(f.ports.execution.deploy).not.toHaveBeenCalled();
    expect(f.ports.repository.recordDeployment).not.toHaveBeenCalled();
  });
  it('重新登录也不能绕过执行发送前撤权或租约失效', async () => {
    const f = deploymentFixture('delivery.deploy');
    vi.mocked(f.ports.repository.deploymentWriteAllowed)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      f.service.executeApprovedDeployment(
        f.context,
        f.action,
        f.fence,
        f.ports.execution,
        f.signal,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.authorization.assertProject).toHaveBeenCalledTimes(2);
    expect(f.ports.execution.deploy).not.toHaveBeenCalled();
    expect(f.ports.repository.recordDeployment).not.toHaveBeenCalled();
  });
});
describe('工程包执行边界', () => {
  it.each([
    ['null文件元素', { ...pkg, files: [null, pkg.files[1]] }],
    [
      '非字符串路径',
      { ...pkg, files: [{ path: 1, content: 'text' }, pkg.files[1]] },
    ],
    [
      '非字符串内容',
      { ...pkg, files: [{ path: 'index.html', content: null }, pkg.files[1]] },
    ],
    ['非字符串预览路径', { ...pkg, previewPath: {} }],
    ['null命令', { ...pkg, testCommands: [null] }],
    ['命令参数对象', { ...pkg, testCommands: [['node', {}]] }],
    ['非数组命令', { ...pkg, buildCommands: ['node build.mjs'] }],
    ['null限制项', { ...pkg, limitations: [null] }],
    ['非数组限制', { ...pkg, limitations: {} }],
  ])('%s统一返回可返工的INVALID_INPUT', (_description, value) => {
    expect(() => validateDeliveryPackage(value)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });
  it('拒绝路径穿越和无行为测试工程', () => {
    expect(() =>
      validateDeliveryPackage({
        ...pkg,
        files: [{ path: '../escape', content: 'bad' }, pkg.files[1]],
      }),
    ).toThrow();
    expect(() =>
      validateDeliveryPackage({ ...pkg, testCommands: [['npm', 'test']] }),
    ).toThrow();
    expect(() => validateDeliveryPackage(pkg)).not.toThrow();
  });
});
