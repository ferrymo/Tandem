import { DomainError } from '@tandem/core';
import type {
  DraftExecutionExtension,
  DraftFence,
  DraftValidationExtension,
  ProjectDraftAction,
  ProjectSystem,
  ProjectsRepository,
  ResourceScope,
  StoredSession,
  TaskDraftAction,
} from '@tandem/core';

const id = (value: string) =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const day = (value: string) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const taskAction = (action: ProjectDraftAction): action is TaskDraftAction =>
  action.kind.startsWith('task.');
const hours = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= 100000;
/** Process-local payload cache; the shared PG version invalidates it across processes. */
export class ProjectReadCache {
  private readonly entries = new Map<
    string,
    { expires: number; value: unknown }
  >();
  constructor(
    private readonly ttlMs = 15000,
    private readonly now: () => number = Date.now,
  ) {}
  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.value as T;
    const value = await load();
    if (this.entries.size >= 500) {
      for (const [entry, item] of this.entries)
        if (item.expires <= this.now()) this.entries.delete(entry);
      if (this.entries.size >= 500)
        this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { expires: this.now() + this.ttlMs, value });
    return value;
  }
}
const defaultReadCache = new ProjectReadCache();
export function validateTaskAction(action: TaskDraftAction): void {
  if (!action || typeof action !== 'object')
    throw new DomainError('INVALID_INPUT', '草案动作无效');
  if (action.kind === 'task.create') {
    if (
      !id(action.executionId) ||
      !text(action.name, 200) ||
      typeof action.description !== 'string' ||
      action.description.length > 20000 ||
      !text(action.assignedTo, 120) ||
      !day(action.startDate) ||
      !day(action.deadline) ||
      action.deadline < action.startDate ||
      !Number.isInteger(action.priority) ||
      action.priority < 0 ||
      action.priority > 4 ||
      !Number.isFinite(action.estimate) ||
      action.estimate < 0 ||
      action.estimate > 100000
    )
      throw new DomainError(
        'INVALID_INPUT',
        '请填写有效的任务名称、执行、负责人、日期与估算',
      );
  } else if (action.kind === 'task.update') {
    const c = action.changes;
    if (
      !id(action.taskId) ||
      !/^[a-f0-9]{64}$/.test(action.expectedVersion) ||
      !c ||
      typeof c !== 'object' ||
      Array.isArray(c) ||
      Object.keys(c).length === 0 ||
      Object.keys(c).some(
        (key) =>
          ![
            'name',
            'description',
            'assignedTo',
            'priority',
            'estimate',
            'deadline',
          ].includes(key),
      ) ||
      (c.name !== undefined && !text(c.name, 200)) ||
      (c.description !== undefined &&
        (typeof c.description !== 'string' || c.description.length > 20000)) ||
      (c.assignedTo !== undefined && !text(c.assignedTo, 120)) ||
      (c.deadline !== undefined && !day(c.deadline)) ||
      (c.priority !== undefined &&
        (!Number.isInteger(c.priority) || c.priority < 0 || c.priority > 4)) ||
      (c.estimate !== undefined &&
        (!Number.isFinite(c.estimate) || c.estimate < 0 || c.estimate > 100000))
    )
      throw new DomainError('INVALID_INPUT', '任务修改字段或版本无效');
  } else if (action.kind === 'task.status' || action.kind === 'task.effort') {
    if (
      !id(action.taskId) ||
      !/^[a-f0-9]{64}$/.test(action.expectedVersion) ||
      !hours(action.consumed) ||
      !hours(action.left)
    )
      throw new DomainError('INVALID_INPUT', '任务版本与工时无效');
    if (action.kind === 'task.status') {
      if (
        !['start', 'pause', 'finish', 'close'].includes(action.transition) ||
        typeof action.comment !== 'string' ||
        action.comment.length > 20000 ||
        (action.transition === 'finish' &&
          (!action.realStarted ||
            !action.finishedDate ||
            !Number.isFinite(Date.parse(action.realStarted)) ||
            !Number.isFinite(Date.parse(action.finishedDate)) ||
            action.finishedDate < action.realStarted))
      )
        throw new DomainError(
          'INVALID_INPUT',
          '任务状态、实际开始和完成时间无效',
        );
    } else if (
      !day(action.date) ||
      action.date > new Date().toISOString().slice(0, 10) ||
      action.consumed <= 0 ||
      !text(action.work, 20000)
    )
      throw new DomainError('INVALID_INPUT', '工时日期、工作内容或耗时无效');
  } else throw new DomainError('INVALID_INPUT', '不支持此草案动作');
}

export class ProjectsService {
  constructor(
    private readonly repository: ProjectsRepository,
    private readonly upstream: ProjectSystem,
    private readonly extensions?: DraftValidationExtension,
    private readonly cache = defaultReadCache,
  ) {}
  availableProjects(page = 1) {
    return this.upstream.projects(page);
  }
  async bindProject(scope: ResourceScope, externalId: string) {
    if (!id(externalId)) throw new DomainError('INVALID_INPUT', '项目标识无效');
    await this.upstream.project(externalId);
    return this.repository.bind(scope, this.upstream.connectionId, externalId);
  }
  async assertProjectAccess(
    scope: ResourceScope,
    projectId: string,
    write = false,
  ) {
    const link = await this.repository.link(scope, projectId, write);
    if (link.connectionId !== this.upstream.connectionId)
      throw new DomainError('FORBIDDEN', '项目不属于当前账号连接');
    await this.upstream.project(link.externalId);
    return link;
  }
  async listProjects(scope: ResourceScope) {
    const links = await this.repository.links(scope);
    return Promise.all(
      links.map(async (link) => {
        try {
          const project = await this.assertProjectAccess(scope, link.id);
          let canWrite = false;
          try {
            await this.repository.link(scope, link.id, true);
            canWrite = true;
          } catch (error) {
            if (!(error instanceof DomainError && error.code === 'FORBIDDEN'))
              throw error;
          }
          return {
            ...project,
            external: await this.upstream.project(link.externalId),
            available: true as const,
            canWrite,
          };
        } catch (error) {
          if (
            error instanceof DomainError &&
            ['FORBIDDEN', 'UNAVAILABLE'].includes(error.code)
          )
            return { ...link, external: null, available: false as const };
          throw error;
        }
      }),
    );
  }
  async grants(scope: ResourceScope, projectId: string) {
    await this.assertProjectAccess(scope, projectId);
    return this.repository.grants(scope, projectId);
  }
  async grant(
    scope: ResourceScope,
    projectId: string,
    identityId: string,
    role: 'viewer' | 'editor' | null,
  ) {
    await this.assertProjectAccess(scope, projectId, true);
    if (role !== null && role !== 'viewer' && role !== 'editor')
      throw new DomainError('INVALID_INPUT', '项目角色无效');
    await this.repository.grant(scope, projectId, identityId, role);
  }
  async executions(scope: ResourceScope, projectId: string) {
    const link = await this.assertProjectAccess(scope, projectId);
    const permission = await this.upstream.readAccessKey(link.externalId);
    const key = JSON.stringify([
      scope.workspaceId,
      scope.actorId,
      link.id,
      link.connectionId,
      link.cacheVersion,
      permission,
      'executions',
    ]);
    return this.cache.read(key, () =>
      this.upstream.executions(link.externalId),
    );
  }
  async tasks(
    scope: ResourceScope,
    projectId: string,
    executionId: string,
    page = 1,
  ) {
    const link = await this.assertProjectAccess(scope, projectId);
    const permission = await this.upstream.readAccessKey(
      link.externalId,
      executionId,
    );
    const key = JSON.stringify([
      scope.workspaceId,
      scope.actorId,
      link.id,
      link.connectionId,
      link.cacheVersion,
      permission,
      'tasks',
      executionId,
      page,
    ]);
    return this.cache.read(key, () =>
      this.upstream.tasks(link.externalId, executionId, page),
    );
  }
  async task(scope: ResourceScope, projectId: string, taskId: string) {
    const link = await this.assertProjectAccess(scope, projectId);
    return this.upstream.task(link.externalId, taskId);
  }
  async messages(scope: ResourceScope, projectId: string, taskId: string) {
    await this.task(scope, projectId, taskId);
    return this.repository.messages(scope, projectId, taskId);
  }
  async addMessage(
    scope: ResourceScope,
    projectId: string,
    taskId: string,
    body: string,
  ) {
    await this.assertProjectAccess(scope, projectId, true);
    await this.task(scope, projectId, taskId);
    if (!text(body, 20000))
      throw new DomainError('INVALID_INPUT', '消息须为 1–20000 个字符');
    await this.repository.addMessage(scope, projectId, taskId, body.trim());
  }
  async drafts(scope: ResourceScope, projectId?: string) {
    if (projectId) await this.assertProjectAccess(scope, projectId);
    const drafts = await this.repository.drafts(scope, projectId);
    const allowed = new Set<string>();
    for (const project of new Set(drafts.map((draft) => draft.projectId))) {
      try {
        await this.assertProjectAccess(scope, project);
        allowed.add(project);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'FORBIDDEN'))
          throw error;
      }
    }
    return drafts.filter((draft) => allowed.has(draft.projectId));
  }
  async draft(scope: ResourceScope, draftId: string) {
    const draft = await this.repository.draft(scope, draftId);
    await this.assertProjectAccess(scope, draft.projectId);
    return draft;
  }
  private async validate(
    scope: ResourceScope,
    projectId: string,
    title: string,
    action: ProjectDraftAction,
  ) {
    if (!text(title, 200))
      throw new DomainError('INVALID_INPUT', '草案标题须为 1–200 个字符');
    if (
      !action ||
      typeof action !== 'object' ||
      Array.isArray(action) ||
      typeof action.kind !== 'string'
    )
      throw new DomainError('INVALID_INPUT', '草案动作无效');
    const project = await this.assertProjectAccess(scope, projectId, true);
    if (!taskAction(action)) {
      if (
        !this.extensions ||
        !['mcp.call', 'delivery.deploy', 'delivery.rollback'].includes(
          action.kind,
        )
      )
        throw new DomainError('INVALID_INPUT', '此草案动作尚未配置');
      await this.extensions.validate(scope, project, action);
      return;
    }
    validateTaskAction(action);
    await this.upstream.assertWritable(project.externalId, action);
    if (action.kind !== 'task.create') {
      const task = await this.upstream.task(project.externalId, action.taskId);
      if (task.version !== action.expectedVersion)
        throw new DomainError(
          'CONFLICT',
          '外部任务已变化，请刷新后重新编辑草案',
        );
    }
  }
  async createDraft(
    scope: ResourceScope,
    sessionId: string,
    projectId: string,
    title: string,
    action: ProjectDraftAction,
    requestId: string,
  ) {
    await this.validate(scope, projectId, title, action);
    return this.repository.createDraft(
      scope,
      sessionId,
      projectId,
      title.trim(),
      action,
      requestId,
    );
  }
  async reviseDraft(
    scope: ResourceScope,
    draftId: string,
    version: number,
    title: string,
    action: ProjectDraftAction,
  ) {
    const draft = await this.draft(scope, draftId);
    await this.validate(scope, draft.projectId, title, action);
    return this.repository.reviseDraft(
      scope,
      draftId,
      version,
      title.trim(),
      action,
    );
  }
  async reviewDraft(
    scope: ResourceScope,
    draftId: string,
    version: number,
    approve: boolean,
  ) {
    const draft = await this.draft(scope, draftId);
    if (approve)
      await this.validate(scope, draft.projectId, draft.title, draft.action);
    return this.repository.reviewDraft(scope, draftId, version, approve);
  }
}

/** No credential is substituted by the reviewer; the factory receives the original session. */
export class DraftWorker {
  constructor(
    private readonly repository: ProjectsRepository,
    private readonly systemFor: (
      session: StoredSession,
    ) => Promise<ProjectSystem>,
    private readonly extensions?: DraftExecutionExtension,
  ) {}
  async execute(fence: DraftFence): Promise<void> {
    const context = await this.repository.workerContext(fence);
    if (!context) return;
    let upstream: ProjectSystem;
    try {
      upstream = await this.systemFor(context.session);
      if (upstream.connectionId !== context.project.connectionId)
        throw new DomainError('FORBIDDEN', '原执行连接已变化');
      await upstream.project(context.project.externalId);
      if (taskAction(context.draft.action)) {
        validateTaskAction(context.draft.action);
        await upstream.assertWritable(
          context.project.externalId,
          context.draft.action,
        );
      } else {
        if (!this.extensions)
          throw new DomainError('UNAVAILABLE', '草案执行器尚未配置');
        await this.extensions.validate(context, context.draft.action);
      }
      if (
        taskAction(context.draft.action) &&
        context.draft.action.kind !== 'task.create'
      ) {
        const task = await upstream.task(
          context.project.externalId,
          context.draft.action.taskId,
        );
        if (task.version !== context.draft.action.expectedVersion)
          throw new DomainError('CONFLICT', '外部任务已变化，原审批不能执行');
      }
    } catch (error) {
      await this.repository.finishAction(fence, {
        status: 'failed',
        error:
          error instanceof DomainError ? error.code : 'UPSTREAM_UNAVAILABLE',
      });
      return;
    }
    if (!(await this.repository.beginAction(fence))) return;
    try {
      const action = context.draft.action;
      const receipt = taskAction(action)
        ? await upstream.execute(context.project.externalId, action)
        : await this.extensions!.execute(context, action, fence);
      await this.repository.finishAction(
        fence,
        receipt.status === 'failed'
          ? { status: 'failed', receipt, error: 'EXTERNAL_ACTION_FAILED' }
          : { status: 'succeeded', receipt },
      );
    } catch (error) {
      // A response lost after send cannot safely be retried, particularly for task creation.
      await this.repository.finishAction(fence, {
        status: 'unknown',
        error:
          error instanceof DomainError ? error.code : 'UPSTREAM_RESULT_UNKNOWN',
      });
    }
  }
}
