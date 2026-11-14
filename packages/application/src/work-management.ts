import {
  DomainError,
  projectStages,
  taskStatuses,
  workPermissions,
} from '@tandem/core';
import type {
  StoredSession,
  WorkAttachmentInput,
  WorkCommand,
  WorkManagementRepository,
  WorkProtocol,
} from '@tandem/core';

const fail = (message: string): never => {
  throw new DomainError('INVALID_INPUT', message);
};
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseWorkCommand(input: unknown, actorId: string): WorkCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return fail('请提交有效操作');
  const row = input as Record<string, unknown>;
  const string = (
    key: string,
    max = 200,
    required = false,
    defaultValue = '',
  ) => {
    const value = row[key] ?? defaultValue;
    if (
      typeof value !== 'string' ||
      value.length > max ||
      (required && !value.trim())
    )
      return fail(`${key} 内容不符合要求`);
    return value.trim();
  };
  const id = (key: string, required = false): string | null => {
    const value = row[key];
    if (value === undefined || value === null || value === '') {
      if (required) return fail(`${key} 不能为空`);
      return null;
    }
    if (typeof value !== 'string' || !uuidPattern.test(value))
      return fail(`${key} 标识无效`);
    return value;
  };
  const number = (
    key: string,
    min = 0,
    max = 1e9,
    nullable = false,
    defaultValue = 0,
  ): number | null => {
    const value = row[key];
    if ((value === undefined || value === null || value === '') && nullable)
      return null;
    const n = value ?? defaultValue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
      return fail(`${key} 数值无效`);
    return n;
  };
  const bool = (key: string, defaultValue = true) => {
    const value = row[key] ?? defaultValue;
    if (typeof value !== 'boolean') return fail(`${key} 须为布尔值`);
    return value;
  };
  const enumValue = <T extends string>(
    key: string,
    values: readonly T[],
    defaultValue?: T,
  ): T => {
    const value = row[key] ?? defaultValue;
    if (typeof value !== 'string' || !values.includes(value as T))
      return fail(`${key} 选项无效`);
    return value as T;
  };
  const list = (key: string, uuids = false) => {
    const value = row[key] ?? [];
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some(
        (v) =>
          typeof v !== 'string' ||
          v.length > 200 ||
          (uuids && !uuidPattern.test(v)),
      )
    )
      return fail(`${key} 列表无效`);
    return [...new Set(value)] as string[];
  };
  const date = (key: string) => {
    const value = row[key];
    if (value === null || value === undefined || value === '') return null;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value
    )
      return fail(`${key} 日期无效`);
    return value;
  };
  const range = (start: string | null, end: string | null) => {
    if (start && end && start > end) fail('结束日期不能早于开始日期');
  };
  const url = (key: string, required = false) => {
    const value = string(key, 2000, required);
    if (!value) return value;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return fail(`${key} 地址无效`);
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return fail(`${key} 使用不含凭证及查询参数的 HTTP 地址`);
    return value.replace(/\/$/, '');
  };
  const ref = (key = 'credentialRef') => {
    const value = string(key, 200);
    if (value && !/^[A-Z_][A-Z0-9_]{1,199}$/.test(value))
      return fail('凭证只允许填写环境变量名称');
    return value;
  };
  const editId = id('id');
  const version = number('version', 1, 2147483647, true);
  if (editId && !version) fail('编辑时必须携带内容版本');
  const base = {
    ...(editId ? { id: editId } : {}),
    ...(version ? { version } : {}),
  };
  const command = string('command', 100, true);
  const protocol = (): WorkProtocol =>
    enumValue('protocol', ['openai', 'anthropic', 'ollama'], 'openai');
  switch (command) {
    case 'save-project-group':
      return {
        command,
        ...base,
        name: string('name', 120, true),
        parentId: id('parentId'),
        sortOrder: number('sortOrder', -100000, 100000)!,
      };
    case 'save-project': {
      const initiatedOn = date('initiatedOn'),
        launchOn = date('launchOn'),
        acceptanceOn = date('acceptanceOn'),
        maintenanceUntil = date('maintenanceUntil');
      range(initiatedOn, launchOn);
      range(launchOn, acceptanceOn);
      range(acceptanceOn, maintenanceUntil);
      return {
        command,
        ...base,
        name: string('name', 200, true),
        description: string('description', 20000),
        groupId: id('groupId'),
        stage: enumValue('stage', projectStages, 'initiated'),
        ownerId: id('ownerId') ?? actorId,
        initiatedOn,
        launchOn,
        acceptanceOn,
        maintenanceUntil,
        plannedDays: number('plannedDays', 0, 1e7, true),
        plannedAmount: number('plannedAmount', 0, 1e12, true),
        repositoryUrl: string('repositoryUrl', 2000),
        deploymentTarget: string('deploymentTarget', 2000),
        deploymentBranch: string('deploymentBranch', 200),
        deploymentCommand: string('deploymentCommand', 6000),
      };
    }
    case 'save-team':
      return {
        command,
        ...base,
        name: string('name', 120, true),
        description: string('description', 2000),
        memberIds: list('memberIds', true),
      };
    case 'save-project-member':
      return {
        command,
        ...base,
        projectId: id('projectId', true)!,
        participantId: id('participantId', true)!,
        role: string('role', 80, true),
        canWrite: bool('canWrite', false),
      };
    case 'remove-project-group':
    case 'remove-project-member':
      return {
        command,
        id: id('id', true)!,
        version: number('version', 1, 2147483647)!,
      };
    case 'remove-module':
      return {
        command,
        id: id('id', true)!,
        projectId: id('projectId', true)!,
        version: number('version', 1, 2147483647)!,
      };
    case 'save-module':
      return {
        command,
        ...base,
        projectId: id('projectId', true)!,
        name: string('name', 120, true),
        description: string('description', 6000),
      };
    case 'save-document': {
      const scope = enumValue(
        'scope',
        ['project', 'team', 'personal'],
        'personal',
      );
      const visibility =
        scope === 'personal'
          ? 'private'
          : enumValue('visibility', ['space', 'private'], 'space');
      const projectId = id('projectId'),
        teamId = id('teamId');
      if (
        (scope === 'project' && (!projectId || teamId)) ||
        (scope === 'team' && (!teamId || projectId)) ||
        (scope === 'personal' && (projectId || teamId))
      )
        fail('文档空间和关联范围不一致');
      return {
        command,
        ...base,
        title: string('title', 200, true),
        body: string('body', 500000),
        scope,
        visibility,
        projectId,
        teamId,
      };
    }
    case 'save-task': {
      const plannedStart = date('plannedStart'),
        plannedEnd = date('plannedEnd'),
        actualStart = date('actualStart'),
        actualEnd = date('actualEnd');
      range(plannedStart, plannedEnd);
      range(actualStart, actualEnd);
      const status = enumValue('status', taskStatuses, 'not_started'),
        cancellationReason = string('cancellationReason', 2000);
      if (status === 'cancelled' && !cancellationReason)
        fail('取消任务时请填写取消原因');
      return {
        command,
        ...base,
        projectId: id('projectId', true)!,
        moduleId: id('moduleId'),
        name: string('name', 200, true),
        description: string('description', 20000),
        assigneeId: id('assigneeId'),
        collaboratorIds: list('collaboratorIds', true),
        plannedStart,
        plannedEnd,
        plannedHours: number('plannedHours', 0, 1e7, true),
        actualStart,
        actualEnd,
        status,
        cancellationReason,
      };
    }
    case 'add-task-comment':
      return {
        command,
        taskId: id('taskId', true)!,
        body: string('body', 20000, true),
      };
    case 'log-efforts': {
      const entries = row.entries;
      if (
        !Array.isArray(entries) ||
        entries.length === 0 ||
        entries.length > 100
      )
        fail('每次填报须为 1–100 条工时');
      return {
        command,
        requestId: id('requestId', true)!,
        entries: (entries as unknown[]).map((value) => {
          if (!value || typeof value !== 'object') return fail('工时行无效');
          const entry = value as Record<string, unknown>;
          if (
            typeof entry.taskId !== 'string' ||
            !uuidPattern.test(entry.taskId) ||
            typeof entry.date !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
            !Number.isFinite(Date.parse(entry.date)) ||
            new Date(entry.date + 'T00:00:00Z').toISOString().slice(0, 10) !==
              entry.date ||
            typeof entry.hours !== 'number' ||
            !Number.isFinite(entry.hours) ||
            entry.hours <= 0 ||
            entry.hours > 24 ||
            typeof entry.note !== 'string' ||
            entry.note.length > 2000
          )
            return fail('工时须包含有效任务、日期、0–24 小时和说明');
          return {
            taskId: entry.taskId,
            date: entry.date,
            hours: entry.hours,
            note: entry.note.trim(),
          };
        }),
      };
    }
    case 'save-agent':
      return {
        command,
        ...base,
        name: string('name', 120, true),
        description: string('description', 2000),
        avatar: string('avatar', 2000),
        teamId: id('teamId'),
        modelChannelId: id('modelChannelId'),
        model: string('model', 200),
        protocol: protocol(),
        sandboxId: id('sandboxId'),
        skillIds: list('skillIds', true),
        mcpServerIds: list('mcpServerIds', true),
        enabled: bool('enabled'),
      };
    case 'save-sandbox':
      return {
        command,
        ...base,
        name: string('name', 120, true),
        image: string('image', 500, true),
        workdir: string('workdir', 500, false, '/workspace'),
        networkPolicy: enumValue(
          'networkPolicy',
          ['none', 'restricted'],
          'none',
        ),
        cpu: number('cpu', 0.1, 64, false, 1)!,
        memoryMb: number('memoryMb', 128, 131072, false, 1024)!,
        enabled: bool('enabled'),
      };
    case 'save-model-channel': {
      const models = list('models');
      if (models.some((model) => /\p{Cc}/u.test(model)))
        fail('模型名称不能包含换行或控制字符');
      return {
        command,
        ...base,
        name: string('name', 120, true),
        baseUrl: url('baseUrl', true),
        protocol: protocol(),
        models: [
          ...new Set(models.map((model) => model.trim()).filter(Boolean)),
        ],
        credentialRef: ref(),
        enabled: bool('enabled'),
      };
    }
    case 'save-role': {
      const permissions = list('permissions');
      if (
        permissions.some(
          (permission) =>
            !workPermissions.includes(
              permission as (typeof workPermissions)[number],
            ),
        )
      )
        fail('角色包含不支持的权限');
      return {
        command,
        ...base,
        name: string('name', 120, true),
        description: string('description', 2000),
        permissions,
        memberIds: list('memberIds', true),
        enabled: bool('enabled'),
      };
    }
    case 'save-menu':
      return {
        command,
        ...base,
        key: enumValue('key', [
          'projects',
          'documents',
          'tasks',
          'analysis',
          'agents',
          'connectors',
          'admin',
        ]),
        label: string('label', 30, true),
        visible: bool('visible'),
        sortOrder: number('sortOrder', -100000, 100000)!,
      };
    case 'save-plugin':
      return {
        command,
        ...base,
        name: string('name', 120, true),
        description: string('description', 2000),
        source: string('source', 2000, true),
        pinnedVersion: string('pinnedVersion', 200, true),
        enabled: bool('enabled', false),
      };
    case 'save-connector':
      return {
        command,
        ...base,
        name: string('name', 120, true),
        kind: enumValue('kind', ['zentao'], 'zentao'),
        baseUrl: url('baseUrl', true),
        databaseHost: string('databaseHost', 500),
        databasePort: number('databasePort', 1, 65535, false, 3306)!,
        databaseName: string('databaseName', 120),
        databaseUser: string('databaseUser', 120),
        credentialRef: ref(),
        enabled: bool('enabled', false),
      };
    case 'remove-configuration':
      return {
        command,
        kind: enumValue('kind', [
          'agent',
          'sandbox',
          'model-channel',
          'role',
          'menu',
          'plugin',
          'connector',
        ]),
        id: id('id', true)!,
        version: number('version', 1, 2147483647)!,
      };
    default:
      return fail('不支持的管理操作');
  }
}

export class WorkManagementService {
  constructor(private readonly repository: WorkManagementRepository) {}
  snapshot(session: StoredSession, workspaceId: string) {
    return this.repository.snapshot({
      workspaceId,
      actorId: session.identity.id,
    });
  }
  async execute(session: StoredSession, workspaceId: string, input: unknown) {
    return this.repository.execute(
      { workspaceId, actorId: session.identity.id },
      parseWorkCommand(input, session.identity.id),
    );
  }
  createAttachment(
    session: StoredSession,
    workspaceId: string,
    input: WorkAttachmentInput,
  ) {
    if (
      !input.name.trim() ||
      input.name.length > 250 ||
      input.mime.length > 200 ||
      !Number.isSafeInteger(input.size) ||
      input.size < 1 ||
      input.size > 20971520 ||
      !uuidPattern.test(input.storageKey) ||
      (!input.taskId && !input.documentId) ||
      (input.taskId && input.documentId)
    )
      fail('附件信息不符合要求');
    for (const value of [input.projectId, input.taskId, input.documentId])
      if (value && !uuidPattern.test(value)) fail('附件关联标识无效');
    return this.repository.createAttachment(
      { workspaceId, actorId: session.identity.id },
      input,
    );
  }
  attachment(session: StoredSession, workspaceId: string, id: string) {
    if (!uuidPattern.test(id)) fail('附件标识无效');
    return this.repository.attachment(
      { workspaceId, actorId: session.identity.id },
      id,
    );
  }
  deleteAttachment(session: StoredSession, workspaceId: string, id: string) {
    if (!uuidPattern.test(id)) fail('附件标识无效');
    return this.repository.deleteAttachment(
      { workspaceId, actorId: session.identity.id },
      id,
    );
  }
}
