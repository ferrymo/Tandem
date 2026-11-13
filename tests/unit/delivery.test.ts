import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../packages/core/src/index';
import type {
  DeliveryEvidence,
  DeliveryRepository,
  DeliveryWorkerContext,
  Job,
} from '../../packages/core/src/index';
import { runDeliveryJob } from '../../packages/agent-runtime/src/delivery';
import type { DeliveryRuntimePorts } from '../../packages/agent-runtime/src/delivery';
import { validateDeliveryPackage } from '../../adapters/execution/src/index';
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
  it('首次授权失败也明确落状态', async () => {
    const f = fixture();
    f.ports.authorize = async () => {
      throw new DomainError('FORBIDDEN', '撤权');
    };
    await runDeliveryJob(job, 'worker', f.ports, f.signal);
    expect(f.read().run.status).toBe('needs_auth');
    expect(f.ports.model.generate).not.toHaveBeenCalled();
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
describe('工程包执行边界', () => {
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
