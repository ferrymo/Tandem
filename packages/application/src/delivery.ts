import { DomainError } from '@tandem/core';
import type {
  DeliveryAuthorization,
  DeliveryDetail,
  DeliveryProfiles,
  DeliveryRepository,
  DeliveryStart,
  ResourceScope,
  StoredSession,
  ExtensionDraftAction,
  DraftExecutionContext,
  DraftFence,
  DeliveryExecution,
} from '@tandem/core';

export class DeliveryService {
  constructor(
    private readonly repository: DeliveryRepository,
    private readonly authorization: DeliveryAuthorization,
  ) {}
  async start(session: StoredSession, input: DeliveryStart) {
    if (
      !input.goal.trim() ||
      input.goal.length > 6000 ||
      !input.acceptance.trim() ||
      input.acceptance.length > 6000
    )
      throw new DomainError(
        'INVALID_INPUT',
        '请填写目标和可验证的验收条件（各不超过 6000 字）',
      );
    if (
      !['demo', 'deploy'].includes(input.mode) ||
      !Number.isInteger(input.budgetCalls) ||
      input.budgetCalls < 5 ||
      input.budgetCalls > 100 ||
      !Number.isInteger(input.budgetTokens) ||
      input.budgetTokens < 10000 ||
      input.budgetTokens > 2000000 ||
      !Number.isInteger(input.maxRevisions) ||
      input.maxRevisions < 0 ||
      input.maxRevisions > 5
    )
      throw new DomainError('INVALID_INPUT', '运行预算或交付模式不符合要求');
    await this.authorization.assertProject(
      session,
      input.workspaceId,
      input.projectId,
    );
    return this.repository.start(session, {
      ...input,
      goal: input.goal.trim(),
      acceptance: input.acceptance.trim(),
    });
  }
  async list(session: StoredSession, workspaceId: string, projectId?: string) {
    const scope = this.scope(session, workspaceId);
    const runs = await this.repository.list(scope, projectId);
    const allowed = [];
    for (const run of runs) {
      try {
        await this.authorization.assertProject(
          session,
          workspaceId,
          run.projectId,
        );
        allowed.push(run);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'FORBIDDEN'))
          throw error;
      }
    }
    return allowed;
  }
  async detail(
    session: StoredSession,
    workspaceId: string,
    runId: string,
  ): Promise<DeliveryDetail> {
    const detail = await this.repository.detail(
      this.scope(session, workspaceId),
      runId,
    );
    await this.authorization.assertProject(
      session,
      workspaceId,
      detail.run.projectId,
    );
    return detail;
  }
  async control(
    session: StoredSession,
    workspaceId: string,
    runId: string,
    command: 'pause' | 'resume' | 'cancel',
  ) {
    await this.detail(session, workspaceId, runId);
    return this.repository.control(
      this.scope(session, workspaceId),
      runId,
      command,
      session.id,
    );
  }
  profiles(session: StoredSession, workspaceId: string) {
    return this.repository.profiles(this.scope(session, workspaceId));
  }
  async configure(
    session: StoredSession,
    workspaceId: string,
    profiles: DeliveryProfiles,
  ) {
    for (const role of ['designer', 'architect', 'engineer'] as const) {
      const profile = profiles[role];
      if (
        !profile ||
        typeof profile.model !== 'string' ||
        profile.model.length > 200 ||
        typeof profile.instructions !== 'string' ||
        profile.instructions.length > 6000
      )
        throw new DomainError(
          'INVALID_INPUT',
          '请为三个角色提供有效模型与补充要求',
        );
    }
    await this.repository.setProfiles(
      this.scope(session, workspaceId),
      profiles,
    );
  }
  async extendBudget(
    session: StoredSession,
    workspaceId: string,
    runId: string,
    calls: number,
    tokens: number,
  ) {
    const { run } = await this.detail(session, workspaceId, runId);
    if (
      run.actorId !== session.identity.id ||
      !Number.isInteger(calls) ||
      calls < run.budgetCalls ||
      calls > 100 ||
      !Number.isInteger(tokens) ||
      tokens < run.budgetTokens ||
      tokens > 2000000
    )
      throw new DomainError(
        'INVALID_INPUT',
        '仅发起人可增加累计预算（最多 100 次、200 万 token）',
      );
    return this.repository.extendBudget(
      this.scope(session, workspaceId),
      runId,
      calls,
      tokens,
    );
  }
  async validateDeploymentProposal(
    scope: ResourceScope,
    projectId: string,
    action: ExtensionDraftAction,
  ) {
    if (
      action.kind !== 'delivery.deploy' &&
      action.kind !== 'delivery.rollback'
    )
      throw new DomainError('INVALID_INPUT', '不支持的部署草案');
    const { run } = await this.repository.detail(scope, action.runId);
    if (
      run.projectId !== projectId ||
      !run.artifact?.passed ||
      run.revision !== action.version ||
      (!['awaiting_deployment', 'delivered'].includes(run.status) &&
        !(run.status === 'running' && run.phase === 'delivery'))
    )
      throw new DomainError('CONFLICT', '运行、产物版本或交付状态已变化');
    if (
      action.kind === 'delivery.deploy' &&
      (run.artifact.artifactRef !== action.artifactRef ||
        run.artifact.contentHash !== action.contentHash)
    )
      throw new DomainError('CONFLICT', '草案没有绑定当前验证产物');
    if (
      action.kind === 'delivery.rollback' &&
      (!run.deployment ||
        run.deployment.id !== action.deploymentId ||
        run.deployment.contentHash !== action.contentHash ||
        !run.deployment.previousDeploymentId)
    )
      throw new DomainError('CONFLICT', '当前部署没有可回滚的版本');
    return run;
  }
  async executeApprovedDeployment(
    context: DraftExecutionContext,
    action: ExtensionDraftAction,
    fence: DraftFence,
    execution: DeliveryExecution,
    signal: AbortSignal,
  ) {
    if (
      action.kind !== 'delivery.deploy' &&
      action.kind !== 'delivery.rollback'
    )
      throw new DomainError('INVALID_INPUT', '不支持的部署草案');
    return this.repository.withDeploymentLock(fence, async () => {
      const delivery = await this.repository.deploymentContext(fence);
      if (
        !delivery ||
        delivery.run.id !== action.runId ||
        delivery.run.actorId !== context.draft.actorId ||
        delivery.session.id !== context.draft.sessionId ||
        delivery.session.identity.id !== delivery.run.actorId ||
        context.session.id !== context.draft.sessionId ||
        context.session.identity.id !== context.draft.actorId
      )
        throw new DomainError('FORBIDDEN', '部署草案原身份或版本不可用');
      if (!(await this.repository.deploymentWriteAllowed(fence)))
        throw new DomainError('FORBIDDEN', '发起人或团队挂靠人缺少项目写权限');
      await this.authorization.assertProject(
        delivery.session,
        delivery.run.workspaceId,
        delivery.run.projectId,
        true,
      );
      await this.authorization.assertProject(
        delivery.ownerSession,
        delivery.run.workspaceId,
        delivery.run.projectId,
        true,
      );
      if (!(await this.repository.deploymentWriteAllowed(fence)))
        throw new DomainError(
          'FORBIDDEN',
          '部署发送前项目写权限或执行租约已变化',
        );
      const receipt =
        action.kind === 'delivery.deploy'
          ? await execution.deploy({
              runId: delivery.run.id,
              projectId: delivery.run.projectId,
              artifact: delivery.run.artifact!,
              approvalId: context.draft.id,
              signal,
            })
          : await execution.rollback({
              runId: delivery.run.id,
              projectId: delivery.run.projectId,
              deploymentId: action.deploymentId,
              approvalId: context.draft.id,
              signal,
            });
      if (
        !(await this.repository.recordDeployment(
          fence,
          delivery.run.id,
          receipt,
        ))
      )
        throw new DomainError(
          'CONFLICT',
          '部署已执行，执行回执尚未入库；需要核对实际状态',
        );
      return {
        status: receipt.status,
        reference: receipt.id,
        summary:
          receipt.status === 'failed'
            ? '部署健康检查失败，保留前一版本'
            : '本地演示版本已健康验证，部署与回滚记录已保存',
      };
    });
  }
  async reconcileDeployment(
    session: StoredSession,
    workspaceId: string,
    runId: string,
    draftId: string,
    execution: DeliveryExecution,
    confirmNotPublished = false,
    signal: AbortSignal = new AbortController().signal,
  ) {
    const scope = this.scope(session, workspaceId);
    const context = await this.repository.reconciliationContext(
      scope,
      runId,
      draftId,
      session.id,
    );
    await this.authorization.assertProject(
      context.delivery.session,
      workspaceId,
      context.delivery.run.projectId,
    );
    await this.authorization.assertProject(
      context.delivery.ownerSession,
      workspaceId,
      context.delivery.run.projectId,
    );
    const inspection = await execution.inspectDeployment(
      context.delivery.run.projectId,
      draftId,
      signal,
    );
    if (inspection.receipt) {
      if (!inspection.healthy && inspection.receipt.status !== 'failed')
        throw new DomainError(
          'UNAVAILABLE',
          '持久发布记录存在，但HTTP健康检查失败；保留未知结果等待修复',
        );
      let receipt = {
        ...inspection.receipt,
        healthCheckedAt: inspection.verifiedAt,
      };
      if (
        context.draft.action.kind === 'delivery.rollback' &&
        receipt.status === 'healthy' &&
        receipt.previousDeploymentId === context.draft.action.deploymentId
      )
        receipt = { ...receipt, status: 'rolled_back' };
      await this.repository.recordReconciliation(
        scope,
        runId,
        draftId,
        session.id,
        receipt,
        false,
      );
      return {
        outcome: 'recovered' as const,
        run: (await this.repository.detail(scope, runId)).run,
      };
    }
    if (confirmNotPublished)
      await this.repository.recordReconciliation(
        scope,
        runId,
        draftId,
        session.id,
        null,
        true,
      );
    return {
      outcome: confirmNotPublished
        ? ('ready_for_new_proposal' as const)
        : ('confirmation_required' as const),
      verifiedAt: inspection.verifiedAt,
      run: confirmNotPublished
        ? (await this.repository.detail(scope, runId)).run
        : context.delivery.run,
    };
  }
  private scope(session: StoredSession, workspaceId: string): ResourceScope {
    return { workspaceId, actorId: session.identity.id };
  }
}
