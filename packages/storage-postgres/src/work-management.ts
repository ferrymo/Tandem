import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from '@tandem/core';
import type {
  ResourceScope,
  WorkAttachment,
  WorkAttachmentInput,
  WorkCommand,
  WorkManagementRepository,
  WorkResult,
  WorkSnapshot,
} from '@tandem/core';
import { withScope } from './index';

const tables = {
  agent: 'wm_agents',
  sandbox: 'wm_sandboxes',
  'model-channel': 'wm_model_channels',
  role: 'wm_roles',
  menu: 'wm_menus',
  plugin: 'wm_plugins',
  connector: 'wm_connectors',
} as const;
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (v) => '_' + v.toLowerCase());
const camel = (key: string) =>
  key.replace(/_([a-z])/g, (_, v: string) => v.toUpperCase());
const numeric = new Set([
  'plannedDays',
  'plannedAmount',
  'plannedHours',
  'actualHours',
  'hours',
  'cpu',
  'size',
]);
const dates = new Set([
  'initiatedOn',
  'launchOn',
  'acceptanceOn',
  'maintenanceUntil',
  'plannedStart',
  'plannedEnd',
  'actualStart',
  'actualEnd',
  'date',
]);
function convert(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (['workspace_id', 'created_by', 'storage_key'].includes(key)) continue;
    const name = camel(key);
    result[name] =
      value instanceof Date
        ? dates.has(name)
          ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
          : value.toISOString()
        : numeric.has(name) && value !== null
          ? Number(value)
          : value;
  }
  return result;
}
const forbidden = (message = '对象不存在或无访问权限'): never => {
  throw new DomainError('FORBIDDEN', message);
};
function storageError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code =
    error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === '42501') return forbidden();
  if (code === '23505')
    throw new DomainError('CONFLICT', '已有相同记录或请求标识已用于其他内容');
  if (code === '23503')
    throw new DomainError('CONFLICT', '关联对象不存在、属于其他范围或仍被使用');
  if (
    ['22023', '22P02', '23514', '22003', '22007', '22008'].includes(
      String(code),
    )
  )
    throw new DomainError('INVALID_INPUT', '输入内容或关联范围不符合要求');
  throw error;
}
export class PostgresWorkManagementRepository implements WorkManagementRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(
    scope: ResourceScope,
    work: (
      client: pg.PoolClient,
      admin: boolean,
      permissions: string[],
    ) => Promise<T>,
    exclusive = false,
  ): Promise<T> {
    try {
      return await withScope(this.pool, scope, async (client) => {
        // Serializes permission changes with this request, including mid-flight revocation.
        const row = (
          await client.query<{ role: string }>(
            exclusive
              ? 'SELECT tandem.wm_lock_scope_exclusive() AS role'
              : 'SELECT tandem.wm_lock_scope() AS role',
          )
        ).rows[0];
        if (!row?.role) return forbidden('工作空间不存在或成员权限已撤销');
        const permissions = (
          await client.query<{ permissions: string[] }>(
            'SELECT tandem.wm_permissions() AS permissions',
          )
        ).rows[0]!.permissions;
        return work(client, ['owner', 'admin'].includes(row.role), permissions);
      });
    } catch (error) {
      return storageError(error);
    }
  }
  private async project(client: pg.PoolClient, id: string, write = true) {
    const row = (
      await client.query<Record<string, unknown>>(
        'SELECT * FROM tandem.wm_projects WHERE id=$1 AND tandem.wm_project_access(id,$2)',
        [id, write],
      )
    ).rows[0];
    if (!row) return forbidden('项目不存在或无相应权限');
    return row;
  }
  private async participant(
    client: pg.PoolClient,
    scope: ResourceScope,
    id: string,
    projectId?: string,
    humanOnly = false,
  ) {
    const row = (
      await client.query(
        `SELECT 1 FROM tandem.visible_workspace_members($1) WHERE identity_id=$2
      ${humanOnly ? '' : `UNION ALL SELECT 1 FROM tandem.agents WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT 1 FROM tandem.wm_agents WHERE workspace_id=$1 AND id=$2 AND enabled`}`,
        [scope.workspaceId, id],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        'INVALID_INPUT',
        '所选人员或 Agent 已离开空间或不可用',
      );
    if (projectId) {
      const member = (
        await client.query(
          'SELECT 1 FROM tandem.wm_project_members WHERE project_id=$1 AND participant_id=$2 UNION ALL SELECT 1 FROM tandem.wm_projects WHERE id=$1 AND owner_id=$2',
          [projectId, id],
        )
      ).rows[0];
      if (!member)
        throw new DomainError(
          'INVALID_INPUT',
          '请先将执行人或协助人加入项目团队',
        );
    }
  }
  private async exists(
    client: pg.PoolClient,
    scope: ResourceScope,
    table: string,
    id: string | null,
  ) {
    if (!id) return;
    const row = (
      await client.query(
        `SELECT 1 FROM tandem.${table} WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, id],
      )
    ).rows[0];
    if (!row) return forbidden('关联对象不存在或不在当前授权范围');
  }
  private async save(
    client: pg.PoolClient,
    scope: ResourceScope,
    table: string,
    data: Record<string, unknown>,
    id?: string,
    version?: number,
  ): Promise<WorkResult> {
    const keys = Object.keys(data);
    const values = keys.map((key) => data[key]);
    if (id) {
      const result = await client.query<{ id: string; version: number }>(
        `UPDATE tandem.${table} SET ${keys.map((key, index) => `${snake(key)}=$${index + 1}`).join(',')},version=version+1${['wm_projects', 'wm_documents', 'wm_tasks'].includes(table) ? ',updated_at=clock_timestamp()' : ''} WHERE id=$${keys.length + 1} AND workspace_id=$${keys.length + 2} AND version=$${keys.length + 3} RETURNING id,version`,
        [...values, id, scope.workspaceId, version],
      );
      if (!result.rows[0])
        throw new DomainError(
          'CONFLICT',
          '记录已更新、已撤权或不存在，请重新读取后再保存',
        );
      return result.rows[0];
    }
    if (table === 'wm_projects') {
      const projectId = randomUUID();
      await client.query(
        `INSERT INTO tandem.wm_projects(id,workspace_id,${keys.map(snake).join(',')}) VALUES($1,$2,${keys.map((_, i) => '$' + (i + 3)).join(',')})`,
        [projectId, scope.workspaceId, ...values],
      );
      await client.query('SELECT tandem.wm_bootstrap_project_member($1)', [
        projectId,
      ]);
      return { id: projectId, version: 1 };
    }
    return (
      await client.query<{ id: string; version: number }>(
        `INSERT INTO tandem.${table}(workspace_id,${keys.map(snake).join(',')}) VALUES($1,${keys.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING id,version`,
        [scope.workspaceId, ...values],
      )
    ).rows[0]!;
  }
  async snapshot(scope: ResourceScope): Promise<WorkSnapshot> {
    return this.scoped(scope, async (client, canAdmin, permissions) => {
      const select = async (table: string, extra = '') =>
        (
          await client.query<Record<string, unknown>>(
            `SELECT * ${extra} FROM tandem.${table} WHERE workspace_id=$1 ORDER BY id`,
            [scope.workspaceId],
          )
        ).rows.map(convert);
      const [
        groups,
        projects,
        modules,
        projectMembers,
        documents,
        tasks,
        taskEvents,
        efforts,
        agents,
        sandboxes,
        modelChannels,
        roles,
        menus,
        plugins,
        connectors,
        attachments,
        teams,
        humans,
        bots,
      ] = [
        await select('wm_project_groups'),
        await select(
          'wm_projects',
          ",tandem.wm_project_access(id,true) AND tandem.wm_has_permission('project.manage') AS can_write",
        ),
        await select('wm_modules'),
        await select('wm_project_members'),
        await select('wm_documents'),
        await select(
          'wm_tasks',
          `,ARRAY(SELECT participant_id FROM tandem.wm_task_collaborators c WHERE c.task_id=wm_tasks.id ORDER BY participant_id) AS collaborator_ids`,
        ),
        await select('wm_task_events'),
        await select('wm_efforts'),
        await select('wm_agents'),
        await select('wm_sandboxes'),
        await select('wm_model_channels'),
        await select(
          'wm_roles',
          `,ARRAY(SELECT identity_id FROM tandem.wm_role_assignments a WHERE a.role_id=wm_roles.id ORDER BY identity_id) AS member_ids`,
        ),
        await select('wm_menus'),
        await select('wm_plugins'),
        await select('wm_connectors'),
        await select('wm_attachments'),
        await select(
          'wm_teams',
          `,created_by AS owner_id,ARRAY(SELECT identity_id FROM tandem.wm_team_members m WHERE m.team_id=wm_teams.id ORDER BY identity_id) AS member_ids`,
        ),
        await client.query<{ id: string; name: string; kind: 'human' }>(
          `SELECT identity_id AS id,display_name AS name,'human' AS kind FROM tandem.visible_workspace_members($1)`,
          [scope.workspaceId],
        ),
        await client.query<{ id: string; name: string; kind: 'agent' }>(
          `SELECT id,name,'agent' AS kind FROM tandem.agents WHERE workspace_id=$1`,
          [scope.workspaceId],
        ),
      ];
      return {
        groups,
        projects,
        modules,
        projectMembers,
        documents,
        tasks,
        taskEvents,
        efforts,
        agents,
        sandboxes,
        modelChannels,
        roles,
        menus,
        plugins,
        connectors,
        attachments,
        teams,
        participants: [
          ...humans.rows,
          ...bots.rows,
          ...agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            kind: 'agent',
          })),
        ],
        canAdmin,
        permissions,
        actorId: scope.actorId,
      } as WorkSnapshot;
    });
  }
  execute(scope: ResourceScope, input: WorkCommand): Promise<WorkResult> {
    return this.scoped(
      scope,
      async (client, admin, permissions) => {
        const { command, ...data } = input;
        let needed: string | null = null;
        if (command === 'save-project')
          needed = input.id ? 'project.manage' : 'project.create';
        else if (
          [
            'save-project-member',
            'remove-project-member',
            'save-module',
            'remove-module',
            'save-task',
            'add-task-comment',
            'log-efforts',
          ].includes(command)
        )
          needed = 'project.manage';
        else if (command === 'save-document') needed = 'document.manage';
        else if (command === 'save-team') needed = 'team.manage';
        else if (command === 'save-agent') needed = 'agent.manage';
        else if (
          [
            'save-sandbox',
            'save-model-channel',
            'save-plugin',
            'save-connector',
          ].includes(command)
        )
          needed = 'config.manage';
        if (needed && !permissions.includes(needed))
          return forbidden('当前角色不允许此操作');
        if (command === 'remove-project-group') {
          if (!admin) return forbidden('仅管理员可维护项目分组');
          const c = input as Extract<
            WorkCommand,
            { command: 'remove-project-group' }
          >;
          const old = (
            await client.query(
              'SELECT version FROM tandem.wm_project_groups WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
              [scope.workspaceId, c.id],
            )
          ).rows[0];
          if (!old) return forbidden('分组不存在或不在当前工作空间');
          if (old.version !== c.version)
            throw new DomainError('CONFLICT', '分组已更新，请重新读取后删除');
          const references = await client.query(
            'SELECT 1 FROM tandem.wm_project_groups WHERE workspace_id=$1 AND parent_id=$2 UNION ALL SELECT 1 FROM tandem.wm_projects WHERE workspace_id=$1 AND group_id=$2 LIMIT 1',
            [scope.workspaceId, c.id],
          );
          if (references.rowCount)
            throw new DomainError(
              'CONFLICT',
              '分组下仍有子分组或项目，请先移出后再删除',
            );
          await client.query(
            'DELETE FROM tandem.wm_project_groups WHERE workspace_id=$1 AND id=$2 AND version=$3',
            [scope.workspaceId, c.id, c.version],
          );
          return { id: c.id };
        }
        if (command === 'save-project-group') {
          if (!admin) return forbidden('仅管理员可维护项目分组');
          const c = input as Extract<
            WorkCommand,
            { command: 'save-project-group' }
          >;
          if (c.parentId) {
            await this.exists(client, scope, 'wm_project_groups', c.parentId);
            if (c.id) {
              const cycle = await client.query(
                `WITH RECURSIVE parents AS (SELECT id,parent_id FROM tandem.wm_project_groups WHERE id=$1 UNION SELECT g.id,g.parent_id FROM tandem.wm_project_groups g JOIN parents p ON g.id=p.parent_id) SELECT 1 FROM parents WHERE id=$2`,
                [c.parentId, c.id],
              );
              if (cycle.rowCount)
                throw new DomainError(
                  'INVALID_INPUT',
                  '分组不能移到自身或子分组下',
                );
            }
          }
          return this.save(
            client,
            scope,
            'wm_project_groups',
            { name: c.name, parentId: c.parentId, sortOrder: c.sortOrder },
            c.id,
            c.version,
          );
        }
        if (command === 'save-project') {
          const c = input as Extract<WorkCommand, { command: 'save-project' }>;
          if (c.id) await this.project(client, c.id);
          await this.exists(client, scope, 'wm_project_groups', c.groupId);
          await this.participant(client, scope, c.ownerId, undefined, true);
          const { command: _command, id, version, ...values } = c;
          void _command;
          const result = await this.save(
            client,
            scope,
            'wm_projects',
            { ...values, ...(!id ? { createdBy: scope.actorId } : {}) },
            id,
            version,
          );
          return result;
        }
        if (command === 'save-team') {
          const c = input as Extract<WorkCommand, { command: 'save-team' }>;
          if (c.id && !admin) {
            const old = (
              await client.query(
                'SELECT created_by FROM tandem.wm_teams WHERE id=$1',
                [c.id],
              )
            ).rows[0];
            if (!old || old.created_by !== scope.actorId)
              return forbidden('只能维护本人创建的团队');
          }
          for (const member of c.memberIds)
            await this.participant(client, scope, member, undefined, true);
          const result = await this.save(
            client,
            scope,
            'wm_teams',
            {
              name: c.name,
              description: c.description,
              ...(!c.id ? { createdBy: scope.actorId } : {}),
            },
            c.id,
            c.version,
          );
          await client.query(
            'DELETE FROM tandem.wm_team_members WHERE workspace_id=$1 AND team_id=$2',
            [scope.workspaceId, result.id],
          );
          for (const member of [...new Set([...c.memberIds, scope.actorId])])
            await client.query(
              'INSERT INTO tandem.wm_team_members(workspace_id,team_id,identity_id) VALUES($1,$2,$3)',
              [scope.workspaceId, result.id, member],
            );
          return result;
        }
        if (command === 'save-project-member') {
          const c = input as Extract<
            WorkCommand,
            { command: 'save-project-member' }
          >;
          await this.project(client, c.projectId);
          await this.participant(client, scope, c.participantId);
          if (c.id) {
            const old = (
              await client.query(
                'SELECT project_id FROM tandem.wm_project_members WHERE id=$1',
                [c.id],
              )
            ).rows[0];
            if (!old || old.project_id !== c.projectId) return forbidden();
          }
          return this.save(
            client,
            scope,
            'wm_project_members',
            {
              projectId: c.projectId,
              participantId: c.participantId,
              role: c.role,
              canWrite: c.canWrite,
            },
            c.id,
            c.version,
          );
        }
        if (command === 'remove-project-member') {
          const c = input as Extract<
            WorkCommand,
            { command: 'remove-project-member' }
          >;
          const old = (
            await client.query(
              'SELECT * FROM tandem.wm_project_members WHERE id=$1',
              [c.id],
            )
          ).rows[0];
          if (!old) return forbidden();
          await this.project(client, old.project_id);
          const result = await client.query(
            'DELETE FROM tandem.wm_project_members WHERE id=$1 AND version=$2 RETURNING id',
            [c.id, c.version],
          );
          if (!result.rowCount)
            throw new DomainError('CONFLICT', '成员记录已更新，请重新读取');
          return { id: c.id };
        }
        if (command === 'remove-module') {
          const c = input as Extract<WorkCommand, { command: 'remove-module' }>;
          await this.project(client, c.projectId);
          const old = (
            await client.query(
              'SELECT version FROM tandem.wm_modules WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',
              [scope.workspaceId, c.projectId, c.id],
            )
          ).rows[0];
          if (!old) return forbidden('模块不存在或不属于当前项目');
          if (old.version !== c.version)
            throw new DomainError('CONFLICT', '模块已更新，请重新读取后删除');
          if (
            (
              await client.query(
                'SELECT 1 FROM tandem.wm_tasks WHERE workspace_id=$1 AND project_id=$2 AND module_id=$3 LIMIT 1',
                [scope.workspaceId, c.projectId, c.id],
              )
            ).rowCount
          )
            throw new DomainError(
              'CONFLICT',
              '模块仍被任务引用，请先调整任务所属模块后再删除',
            );
          await client.query(
            'DELETE FROM tandem.wm_modules WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND version=$4',
            [scope.workspaceId, c.projectId, c.id, c.version],
          );
          return { id: c.id };
        }
        if (command === 'save-module') {
          const c = input as Extract<WorkCommand, { command: 'save-module' }>;
          await this.project(client, c.projectId);
          if (c.id) {
            const old = (
              await client.query(
                'SELECT project_id FROM tandem.wm_modules WHERE id=$1',
                [c.id],
              )
            ).rows[0];
            if (!old || old.project_id !== c.projectId) return forbidden();
          }
          return this.save(
            client,
            scope,
            'wm_modules',
            {
              projectId: c.projectId,
              name: c.name,
              description: c.description,
            },
            c.id,
            c.version,
          );
        }
        if (command === 'save-document') {
          const c = input as Extract<WorkCommand, { command: 'save-document' }>;
          if (c.projectId) await this.project(client, c.projectId);
          if (c.teamId) {
            const allowed = (
              await client.query(
                'SELECT tandem.wm_team_access($1) AS allowed',
                [c.teamId],
              )
            ).rows[0];
            if (!allowed?.allowed) return forbidden('无权使用该团队空间');
          }
          if (c.id) {
            const old = (
              await client.query(
                'SELECT * FROM tandem.wm_documents WHERE id=$1 AND tandem.wm_document_access(id,true) FOR UPDATE',
                [c.id],
              )
            ).rows[0];
            if (!old) return forbidden();
            if (
              old.scope !== c.scope ||
              old.project_id !== c.projectId ||
              old.team_id !== c.teamId
            )
              throw new DomainError(
                'INVALID_INPUT',
                '文档所属空间不能直接变更，请在目标空间新建文档',
              );
            if (
              old.owner_id !== scope.actorId &&
              old.visibility !== c.visibility
            )
              return forbidden('仅文档所有者可修改可见性');
          }
          const result = await this.save(
            client,
            scope,
            'wm_documents',
            {
              title: c.title,
              body: c.body,
              visibility: c.visibility,
              ...(!c.id
                ? {
                    ownerId: scope.actorId,
                    scope: c.scope,
                    projectId: c.projectId,
                    teamId: c.teamId,
                  }
                : {}),
            },
            c.id,
            c.version,
          );
          await client.query(
            'INSERT INTO tandem.wm_document_versions(workspace_id,document_id,version,title,body,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
            [
              scope.workspaceId,
              result.id,
              result.version,
              c.title,
              c.body,
              scope.actorId,
            ],
          );
          return result;
        }
        if (command === 'save-task')
          return this.saveTask(
            client,
            scope,
            input as Extract<WorkCommand, { command: 'save-task' }>,
          );
        if (command === 'add-task-comment') {
          const c = input as Extract<
            WorkCommand,
            { command: 'add-task-comment' }
          >;
          const task = await this.task(client, c.taskId);
          await this.project(client, task.project_id as string);
          const result = await client.query<{ id: string }>(
            "INSERT INTO tandem.wm_task_events(workspace_id,task_id,actor_id,kind,body) VALUES($1,$2,$3,'comment',$4) RETURNING id",
            [scope.workspaceId, c.taskId, scope.actorId, c.body],
          );
          return result.rows[0]!;
        }
        if (command === 'log-efforts')
          return this.logEfforts(
            client,
            scope,
            input as Extract<WorkCommand, { command: 'log-efforts' }>,
          );
        if (command === 'save-role') {
          if (!admin) return forbidden('仅空间管理员可维护角色及分配成员');
          const c = input as Extract<WorkCommand, { command: 'save-role' }>;
          for (const person of c.memberIds)
            await this.participant(client, scope, person, undefined, true);
          const result = await this.save(
            client,
            scope,
            'wm_roles',
            {
              name: c.name,
              description: c.description,
              permissions: c.permissions,
              enabled: c.enabled,
            },
            c.id,
            c.version,
          );
          await client.query(
            'DELETE FROM tandem.wm_role_assignments WHERE workspace_id=$1 AND role_id=$2',
            [scope.workspaceId, result.id],
          );
          for (const person of c.memberIds)
            await client.query(
              'INSERT INTO tandem.wm_role_assignments(workspace_id,role_id,identity_id) VALUES($1,$2,$3)',
              [scope.workspaceId, result.id, person],
            );
          return result;
        }
        if (command === 'remove-configuration') {
          const c = input as Extract<
            WorkCommand,
            { command: 'remove-configuration' }
          >;
          const table = tables[c.kind];
          if (['role', 'menu'].includes(c.kind)) {
            if (!admin) return forbidden('仅空间管理员可删除角色和菜单');
          } else if (
            !permissions.includes(
              c.kind === 'agent' ? 'agent.manage' : 'config.manage',
            )
          )
            return forbidden('当前角色不允许删除此配置');
          if (c.kind === 'agent') {
            const used = await client.query(
              'SELECT 1 FROM tandem.wm_project_members WHERE participant_id=$1 UNION ALL SELECT 1 FROM tandem.wm_tasks WHERE assignee_id=$1 UNION ALL SELECT 1 FROM tandem.wm_task_collaborators WHERE participant_id=$1',
              [c.id],
            );
            if (used.rowCount)
              throw new DomainError(
                'CONFLICT',
                'Agent 已被项目或任务引用，请停用或先调整引用',
              );
          }
          const result = await client.query(
            `DELETE FROM tandem.${table} WHERE workspace_id=$1 AND id=$2 AND version=$3 RETURNING id`,
            [scope.workspaceId, c.id, c.version],
          );
          if (!result.rowCount)
            throw new DomainError('CONFLICT', '配置已更新或不存在');
          return { id: c.id };
        }
        if (command.startsWith('save-')) {
          const kind = command.slice(5) as keyof typeof tables;
          const table = tables[kind];
          if (!table)
            throw new DomainError('INVALID_INPUT', '不支持的管理操作');
          if (['role', 'menu'].includes(kind) && !admin)
            return forbidden('仅空间管理员可维护角色和菜单');
          const { id, version, ...values } = data as Record<string, unknown>;
          if (kind === 'agent') {
            await this.exists(
              client,
              scope,
              'wm_teams',
              values.teamId as string | null,
            );
            await this.exists(
              client,
              scope,
              'wm_model_channels',
              values.modelChannelId as string | null,
            );
            await this.exists(
              client,
              scope,
              'wm_sandboxes',
              values.sandboxId as string | null,
            );
            for (const skill of values.skillIds as string[])
              await this.exists(client, scope, 'skills', skill);
            for (const server of values.mcpServerIds as string[])
              await this.exists(client, scope, 'mcp_servers', server);
          }
          return this.save(
            client,
            scope,
            table,
            values,
            id as string | undefined,
            version as number | undefined,
          );
        }
        throw new DomainError('INVALID_INPUT', '不支持的管理操作');
      },
      [
        'save-role',
        'save-project',
        'save-project-member',
        'remove-project-member',
        'save-team',
      ].includes(input.command) ||
        (input.command === 'remove-configuration' && input.kind === 'role'),
    );
  }
  private async task(client: pg.PoolClient, id: string) {
    const row = (
      await client.query<Record<string, unknown>>(
        'SELECT * FROM tandem.wm_tasks WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row) return forbidden('任务不存在或无访问权限');
    return row;
  }
  private async saveTask(
    client: pg.PoolClient,
    scope: ResourceScope,
    c: Extract<WorkCommand, { command: 'save-task' }>,
  ): Promise<WorkResult> {
    await this.project(client, c.projectId);
    if (c.moduleId) {
      const module = (
        await client.query(
          'SELECT 1 FROM tandem.wm_modules WHERE id=$1 AND project_id=$2',
          [c.moduleId, c.projectId],
        )
      ).rows[0];
      if (!module)
        throw new DomainError('INVALID_INPUT', '任务模块不属于所选项目');
    }
    if (c.assigneeId)
      await this.participant(client, scope, c.assigneeId, c.projectId);
    for (const person of c.collaboratorIds)
      await this.participant(client, scope, person, c.projectId);
    const old = c.id ? await this.task(client, c.id) : null;
    if (old && old.project_id !== c.projectId)
      throw new DomainError('INVALID_INPUT', '任务不能直接移动至其他项目');
    const { command: _command, id, version, collaboratorIds, ...values } = c;
    void _command;
    const result = await this.save(
      client,
      scope,
      'wm_tasks',
      values,
      id,
      version,
    );
    const beforeCollaborators = id
      ? (
          await client.query<{ participant_id: string }>(
            'SELECT participant_id FROM tandem.wm_task_collaborators WHERE task_id=$1 ORDER BY participant_id',
            [id],
          )
        ).rows.map((v) => v.participant_id)
      : [];
    await client.query(
      'DELETE FROM tandem.wm_task_collaborators WHERE workspace_id=$1 AND task_id=$2',
      [scope.workspaceId, result.id],
    );
    for (const person of collaboratorIds)
      await client.query(
        'INSERT INTO tandem.wm_task_collaborators(workspace_id,task_id,participant_id) VALUES($1,$2,$3)',
        [scope.workspaceId, result.id, person],
      );
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const before = old ? convert(old) : {};
    for (const [key, value] of Object.entries(values))
      if (JSON.stringify(before[key] ?? null) !== JSON.stringify(value))
        changes[key] = { before: before[key] ?? null, after: value };
    if (
      JSON.stringify(beforeCollaborators) !==
      JSON.stringify([...collaboratorIds].sort())
    )
      changes.collaboratorIds = {
        before: beforeCollaborators,
        after: collaboratorIds,
      };
    await client.query(
      'INSERT INTO tandem.wm_task_events(workspace_id,task_id,actor_id,kind,body,changes) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [
        scope.workspaceId,
        result.id,
        scope.actorId,
        id ? 'updated' : 'created',
        id ? '更新了任务' : '创建了任务',
        JSON.stringify(changes),
      ],
    );
    return result;
  }
  private async logEfforts(
    client: pg.PoolClient,
    scope: ResourceScope,
    c: Extract<WorkCommand, { command: 'log-efforts' }>,
  ): Promise<WorkResult> {
    const hash = createHash('sha256')
      .update(JSON.stringify(c.entries))
      .digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      scope.workspaceId + scope.actorId + c.requestId,
    ]);
    const old = (
      await client.query<{ content_hash: string }>(
        'SELECT content_hash FROM tandem.wm_effort_batches WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
        [scope.workspaceId, scope.actorId, c.requestId],
      )
    ).rows[0];
    if (old) {
      if (old.content_hash !== hash)
        throw new DomainError('CONFLICT', '该填报标识已用于不同内容');
      return { id: c.requestId };
    }
    // Deterministic row locks avoid deadlocks across multi-project batches.
    const tasks = new Map<string, Record<string, unknown>>();
    for (const taskId of [...new Set(c.entries.map((e) => e.taskId))].sort()) {
      const task = await this.task(client, taskId);
      await this.project(client, task.project_id as string);
      tasks.set(taskId, task);
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [
      scope.workspaceId + scope.actorId,
    ]);
    const daily = new Map<string, number>();
    for (const entry of c.entries)
      daily.set(entry.date, (daily.get(entry.date) ?? 0) + entry.hours);
    for (const [day, hours] of daily) {
      const recorded = (
        await client.query<{ hours: number }>(
          `SELECT tandem.wm_actor_daily_hours($1)::float8 AS hours`,
          [day],
        )
      ).rows[0]!.hours;
      if (recorded + hours > 24)
        throw new DomainError(
          'INVALID_INPUT',
          `${day} 已填报和本次工时合计超过 24 小时`,
        );
    }
    await client.query(
      'INSERT INTO tandem.wm_effort_batches(workspace_id,actor_id,request_id,content_hash) VALUES($1,$2,$3,$4)',
      [scope.workspaceId, scope.actorId, c.requestId, hash],
    );
    for (const [index, entry] of c.entries.entries()) {
      const task = tasks.get(entry.taskId)!;
      await client.query(
        'INSERT INTO tandem.wm_efforts(workspace_id,project_id,task_id,actor_id,date,hours,note,request_id,line_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          scope.workspaceId,
          task.project_id,
          entry.taskId,
          scope.actorId,
          entry.date,
          entry.hours,
          entry.note,
          c.requestId,
          index,
        ],
      );
      await client.query(
        'UPDATE tandem.wm_tasks SET actual_hours=actual_hours+$1,version=version+1,updated_at=clock_timestamp() WHERE id=$2',
        [entry.hours, entry.taskId],
      );
      await client.query(
        "INSERT INTO tandem.wm_task_events(workspace_id,task_id,actor_id,kind,body) VALUES($1,$2,$3,'effort',$4)",
        [
          scope.workspaceId,
          entry.taskId,
          scope.actorId,
          `${entry.date} 填报 ${entry.hours} 小时${entry.note ? '：' + entry.note : ''}`,
        ],
      );
    }
    return { id: c.requestId };
  }
  async createAttachment(
    scope: ResourceScope,
    input: WorkAttachmentInput,
  ): Promise<WorkAttachment> {
    return this.scoped(scope, async (client) => {
      let projectId = input.projectId ?? null;
      if (input.taskId) {
        const task = await this.task(client, input.taskId);
        if (projectId && projectId !== task.project_id)
          throw new DomainError('INVALID_INPUT', '附件项目与任务不一致');
        projectId = task.project_id as string;
        await this.project(client, projectId);
      }
      if (input.documentId) {
        const doc = (
          await client.query(
            'SELECT * FROM tandem.wm_documents WHERE id=$1 AND tandem.wm_document_access(id,true)',
            [input.documentId],
          )
        ).rows[0];
        if (!doc) return forbidden();
        if (projectId && projectId !== doc.project_id)
          throw new DomainError('INVALID_INPUT', '附件项目与文档不一致');
        projectId = doc.project_id;
      }
      const result = await client.query(
        'INSERT INTO tandem.wm_attachments(workspace_id,project_id,task_id,document_id,owner_id,name,mime,size,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          scope.workspaceId,
          projectId,
          input.taskId ?? null,
          input.documentId ?? null,
          scope.actorId,
          input.name,
          input.mime,
          input.size,
          input.storageKey,
        ],
      );
      const attachment = convert(result.rows[0]) as WorkAttachment;
      await this.attachmentEvent(client, scope, attachment, 'attachment_added');
      return attachment;
    });
  }
  attachment(
    scope: ResourceScope,
    id: string,
  ): Promise<WorkAttachment & { storageKey: string }> {
    return this.scoped(scope, async (client) => {
      const row = (
        await client.query(
          'SELECT * FROM tandem.wm_attachments WHERE workspace_id=$1 AND id=$2',
          [scope.workspaceId, id],
        )
      ).rows[0];
      if (!row) return forbidden('附件不存在或无访问权限');
      return {
        ...convert(row),
        storageKey: row.storage_key,
      } as WorkAttachment & { storageKey: string };
    });
  }
  deleteAttachment(scope: ResourceScope, id: string): Promise<void> {
    return this.scoped(scope, async (client) => {
      const result = await client.query(
        'DELETE FROM tandem.wm_attachments WHERE workspace_id=$1 AND id=$2 RETURNING *',
        [scope.workspaceId, id],
      );
      if (!result.rowCount) return forbidden('附件不存在或无删除权限');
      await this.attachmentEvent(
        client,
        scope,
        convert(result.rows[0]) as WorkAttachment,
        'attachment_removed',
      );
    });
  }
  private async attachmentEvent(
    client: pg.PoolClient,
    scope: ResourceScope,
    attachment: WorkAttachment,
    kind: 'attachment_added' | 'attachment_removed',
  ): Promise<void> {
    if (!attachment.taskId) return;
    const metadata = {
      id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
    };
    const added = kind === 'attachment_added';
    await client.query(
      'INSERT INTO tandem.wm_task_events(workspace_id,task_id,actor_id,kind,body,changes,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp())',
      [
        scope.workspaceId,
        attachment.taskId,
        scope.actorId,
        kind,
        `${added ? '添加' : '移除'}了附件「${attachment.name}」`,
        JSON.stringify({
          attachment: {
            before: added ? null : metadata,
            after: added ? metadata : null,
          },
        }),
      ],
    );
  }
}
