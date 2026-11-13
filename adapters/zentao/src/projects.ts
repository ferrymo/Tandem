import { createHash } from 'node:crypto';
import { DomainError } from '@tandem/core';
import type {
  ExternalExecution,
  ExternalProject,
  ExternalTask,
  ProjectSystem,
  TaskDraftAction,
} from '@tandem/core';

type RecordValue = Record<string, unknown>;
type Options = {
  connectionId: string;
  baseUrl: string;
  accessToken: string;
  subject?: string;
  allowInsecureHttp?: boolean;
  fetch?: typeof globalThis.fetch;
};
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = () => new DomainError('UNAVAILABLE', '协作系统返回了无效响应');
const identifier = (value: unknown): string => {
  const str =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (typeof str !== 'string' || !/^[1-9]\d{0,19}$/.test(str)) throw invalid();
  return str;
};
const string = (value: unknown, max = 20000) =>
  typeof value === 'string' ? value.slice(0, max) : '';
const number = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const optionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const account = (value: unknown) =>
  typeof value === 'string'
    ? value
    : record(value)
      ? string(value.account, 120)
      : '';
const deleted = (value: RecordValue) =>
  value.deleted === true || value.deleted === 1 || value.deleted === '1';
const plain = (value: string) =>
  value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
const html = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\n', '<br>');
const pageNumber = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000)
    throw new DomainError('INVALID_INPUT', '分页参数无效');
  return value;
};

/** ZenTao REST v1; verified against the installed 22.7 entries and config/apiv1.php. */
export class ZentaoProjectSystem implements ProjectSystem {
  readonly connectionId: string;
  private readonly endpoint: string;
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: Options) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new DomainError('INVALID_INPUT', '连接地址无效');
    }
    if (
      !options.connectionId ||
      !/^[A-Za-z0-9,_-]{8,4096}$/.test(options.accessToken) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && options.allowInsecureHttp))
    )
      throw new DomainError('INVALID_INPUT', '协作连接或凭证无效');
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/api.php/v1') ? path : path + '/api.php/v1';
    this.connectionId = options.connectionId;
    this.endpoint = url.toString().replace(/\/$/, '');
    this.request = options.fetch ?? globalThis.fetch;
  }
  private async json(
    path: string,
    method = 'GET',
    body?: RecordValue,
  ): Promise<RecordValue> {
    try {
      const init: RequestInit & { cache: 'no-store' } = {
        method,
        headers: {
          Accept: 'application/json',
          Token: this.options.accessToken,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      };
      if (body) init.body = JSON.stringify(body);
      const response = await this.request(this.endpoint + path, init);
      if (!response.ok || response.status >= 300) {
        await response.body?.cancel();
        if ([401, 403, 404].includes(response.status))
          throw new DomainError('FORBIDDEN', '协作资源不存在或当前账号无权限');
        if (response.status === 400 || response.status === 422)
          throw new DomainError(
            'INVALID_INPUT',
            '协作系统拒绝了此操作，请核对任务字段及状态',
          );
        throw new DomainError('UNAVAILABLE', '协作系统暂不可用');
      }
      const max = 2 * 1024 * 1024;
      if (Number(response.headers.get('Content-Length')) > max) {
        await response.body?.cancel();
        throw invalid();
      }
      const reader = response.body?.getReader();
      if (!reader) throw invalid();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > max) {
            await reader.cancel();
            throw invalid();
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const result: unknown = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      );
      if (
        !record(result) ||
        result.status === 'fail' ||
        result.result === 'fail'
      )
        throw invalid();
      return result;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('UNAVAILABLE', '协作系统请求失败或超时');
    }
  }
  private projectValue(raw: RecordValue): ExternalProject {
    if (deleted(raw) || !string(raw.name, 200))
      throw new DomainError('FORBIDDEN', '项目不存在或已删除');
    return {
      id: identifier(raw.id),
      name: string(raw.name, 200),
      status: string(raw.status, 40),
    };
  }
  async projects(page = 1) {
    const raw = await this.json(
      '/projects?status=all&limit=100&page=' + pageNumber(page),
    );
    if (!Array.isArray(raw.projects)) throw invalid();
    const items = raw.projects
      .filter(record)
      .filter((v) => !deleted(v))
      .map((v) => this.projectValue(v));
    return { items, total: number(raw.total), page };
  }
  async project(projectId: string) {
    return this.projectValue(
      await this.json('/projects/' + identifier(projectId)),
    );
  }
  private async execution(projectId: string, executionId: string) {
    const raw = await this.json('/executions/' + identifier(executionId));
    if (deleted(raw) || identifier(raw.project) !== projectId)
      throw new DomainError('FORBIDDEN', '执行不属于已授权项目');
    return {
      id: identifier(raw.id),
      projectId,
      name: string(raw.name, 200),
      status: string(raw.status, 40),
    };
  }
  async executions(projectId: string): Promise<readonly ExternalExecution[]> {
    const project = await this.json('/projects/' + identifier(projectId));
    this.projectValue(project);
    if (project.executionID)
      return [await this.execution(projectId, identifier(project.executionID))];
    const result: ExternalExecution[] = [];
    for (let page = 1; page <= 100; page++) {
      const raw = await this.json(
        '/projects/' +
          projectId +
          '/executions?status=all&limit=100&page=' +
          page,
      );
      if (!Array.isArray(raw.executions)) throw invalid();
      const flatten = (entries: unknown[]): void => {
        for (const item of entries) {
          if (!record(item)) throw invalid();
          if (identifier(item.project) !== projectId) throw invalid();
          result.push({
            id: identifier(item.id),
            projectId,
            name: string(item.name, 200),
            status: string(item.status, 40),
          });
          if (Array.isArray(item.children)) flatten(item.children);
        }
      };
      flatten(raw.executions);
      if (page * 100 >= number(raw.total) || raw.executions.length === 0)
        return result;
    }
    throw new DomainError(
      'UNAVAILABLE',
      '项目执行数量超过当前读取上限，请缩小范围',
    );
  }
  private taskValue(raw: RecordValue, projectId: string): ExternalTask {
    if (deleted(raw) || identifier(raw.project) !== projectId)
      throw new DomainError('FORBIDDEN', '任务不属于已授权项目');
    const values = {
      id: identifier(raw.id),
      projectId,
      executionId: identifier(raw.execution),
      name: string(raw.name, 200),
      status: string(raw.status, 40),
      description: plain(string(raw.desc)),
      assignedTo: account(raw.assignedTo),
      priority: optionalNumber(raw.pri),
      estimate: optionalNumber(raw.estimate),
      deadline: string(raw.deadline, 40),
      consumed: optionalNumber(raw.consumed),
      left: optionalNumber(raw.left),
      realStarted: string(raw.realStarted, 40),
      updatedAt: string(raw.lastEditedDate, 40),
    };
    // Include content and hours: second-resolution timestamps alone miss concurrent edits.
    const version = createHash('sha256')
      .update(
        JSON.stringify({
          ...values,
          rawDescription: typeof raw.desc === 'string' ? raw.desc : '',
        }),
      )
      .digest('hex');
    return { ...values, version };
  }
  async tasks(projectId: string, executionId: string, page = 1) {
    await this.project(projectId);
    await this.execution(projectId, executionId);
    const raw = await this.json(
      '/executions/' +
        executionId +
        '/tasks?status=all&limit=100&page=' +
        pageNumber(page),
    );
    if (!Array.isArray(raw.tasks)) throw invalid();
    return {
      items: raw.tasks
        .filter(record)
        .filter((v) => !deleted(v))
        .map((v) => this.taskValue(v, projectId)),
      total: number(raw.total),
      page,
    };
  }
  async task(projectId: string, taskId: string) {
    await this.project(projectId);
    return this.taskValue(
      await this.json('/tasks/' + identifier(taskId)),
      projectId,
    );
  }
  async readAccessKey(projectId: string, executionId?: string) {
    await this.project(projectId);
    if (executionId) await this.execution(projectId, executionId);
    const raw = await this.json('/user?fields=rights');
    if (
      !record(raw.profile) ||
      !record(raw.rights) ||
      (this.options.subject &&
        identifier(raw.profile.id) !== this.options.subject)
    )
      throw new DomainError('FORBIDDEN', '账号身份已变化');
    const rights = record(raw.rights.rights) ? raw.rights.rights : {};
    const module = record(rights[executionId ? 'execution' : 'project'])
      ? (rights[executionId ? 'execution' : 'project'] as RecordValue)
      : {};
    if (
      raw.rights.admin !== true &&
      raw.rights.admin !== 1 &&
      !module[executionId ? 'task' : 'execution']
    )
      throw new DomainError('FORBIDDEN', '当前账号没有此查询权限');
    return createHash('sha256')
      .update(JSON.stringify({ subject: raw.profile.id, rights: raw.rights }))
      .digest('hex');
  }
  async assertWritable(projectId: string, action?: TaskDraftAction) {
    await this.project(projectId);
    const raw = await this.json('/user?fields=rights');
    if (
      !record(raw.profile) ||
      !record(raw.rights) ||
      (this.options.subject &&
        identifier(raw.profile.id) !== this.options.subject)
    )
      throw new DomainError('FORBIDDEN', '账号身份已变化');
    const rights = record(raw.rights.rights) ? raw.rights.rights : {};
    const taskRights = record(rights.task) ? rights.task : {};
    const operation = !action
      ? 'edit'
      : action.kind === 'task.create'
        ? 'create'
        : action.kind === 'task.update'
          ? 'edit'
          : action.kind === 'task.effort'
            ? 'recordworkhour'
            : action.transition;
    if (
      raw.rights.admin !== true &&
      raw.rights.admin !== 1 &&
      !taskRights[operation] &&
      !(operation === 'recordworkhour' && taskRights.recordestimate)
    )
      throw new DomainError('FORBIDDEN', '当前账号没有此任务操作权限');
    if (action?.kind === 'task.create') {
      await this.execution(projectId, action.executionId);
      return;
    }
    if (action) {
      const task = await this.task(projectId, action.taskId);
      if (task.version !== action.expectedVersion)
        throw new DomainError('CONFLICT', '外部任务已经变化');
      if (action.kind === 'task.status') {
        const allowed: Record<string, readonly string[]> = {
          start: ['wait'],
          pause: ['doing'],
          finish: ['wait', 'doing', 'pause'],
          close: ['done', 'cancel'],
        };
        if (!allowed[action.transition]?.includes(task.status))
          throw new DomainError('CONFLICT', '当前任务状态不允许此流转');
        if (
          action.transition === 'start' &&
          (task.consumed === null || action.consumed < task.consumed)
        )
          throw new DomainError(
            'INVALID_INPUT',
            '累计耗时未知或不能减少，请刷新核对',
          );
      }
      if (
        action.kind === 'task.effort' &&
        ['closed', 'cancel'].includes(task.status)
      )
        throw new DomainError('CONFLICT', '已关闭或取消的任务不能登记工时');
    }
  }
  async execute(projectId: string, action: TaskDraftAction) {
    // Recheck immediately before send. Upstream remains the final permission authority.
    await this.assertWritable(projectId, action);
    let raw: RecordValue;
    if (action.kind === 'task.create') {
      raw = await this.json(
        '/executions/' + identifier(action.executionId) + '/tasks',
        'POST',
        {
          name: action.name,
          desc: html(action.description),
          assignedTo: action.assignedTo,
          type: 'devel',
          estStarted: action.startDate,
          deadline: action.deadline,
          pri: action.priority,
          estimate: action.estimate,
        },
      );
    } else if (action.kind === 'task.update') {
      const c = action.changes;
      const body: RecordValue = {};
      if (c.name !== undefined) body.name = c.name;
      if (c.description !== undefined) body.desc = html(c.description);
      if (c.assignedTo !== undefined) body.assignedTo = c.assignedTo;
      if (c.priority !== undefined) body.pri = c.priority;
      if (c.estimate !== undefined) body.estimate = c.estimate;
      if (c.deadline !== undefined) body.deadline = c.deadline;
      raw = await this.json('/tasks/' + identifier(action.taskId), 'PUT', body);
    } else if (action.kind === 'task.effort') {
      raw = await this.json(
        '/tasks/' + identifier(action.taskId) + '/estimate',
        'POST',
        {
          date: [action.date],
          consumed: [action.consumed],
          left: [action.left],
          work: [action.work],
        },
      );
    } else {
      const body: RecordValue = { comment: html(action.comment) };
      if (action.transition === 'start') {
        body.consumed = action.consumed;
        body.left = action.left;
        if (action.realStarted) body.realStarted = action.realStarted;
      }
      if (action.transition === 'finish') {
        body.currentConsumed = action.consumed;
        body.realStarted = action.realStarted;
        body.finishedDate = action.finishedDate;
      }
      raw = await this.json(
        '/tasks/' + identifier(action.taskId) + '/' + action.transition,
        'POST',
        body,
      );
    }
    const task = this.taskValue(raw, projectId);
    if (action.kind !== 'task.create' && task.id !== action.taskId)
      throw invalid();
    return { taskId: task.id, status: task.status };
  }
}
