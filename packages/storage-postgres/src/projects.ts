import type pg from 'pg';
import { DomainError } from '@tandem/core';
import type {
  DraftExecutionContext,
  DraftFence,
  DraftReceipt,
  ExtensionDraftAction,
  ProjectDraft,
  ProjectDraftAction,
  ProjectGrant,
  ProjectLink,
  ProjectsRepository,
  ResourceScope,
  TaskMessage,
} from '@tandem/core';
import { withScope } from './index';

function mappedError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = error instanceof Error && 'code' in error ? error.code : '';
  if (code === '42501')
    throw new DomainError('FORBIDDEN', '无权访问项目或执行此操作');
  if (code === '23505')
    throw new DomainError('CONFLICT', '草案版本、状态或请求内容发生冲突');
  if (['22023', '22P02', '23514', '23503'].includes(String(code)))
    throw new DomainError('INVALID_INPUT', '项目、账号或草案输入无效');
  throw error;
}
const linkFields = `id,workspace_id AS "workspaceId",connection_id AS "connectionId",external_id AS "externalId",created_by AS "createdBy",cache_version::text AS "cacheVersion",created_at::text AS "createdAt"`;
const draftFields = `d.id,d.workspace_id AS "workspaceId",d.project_id AS "projectId",d.actor_id AS "actorId",d.session_id AS "sessionId",d.version,d.status,d.reviewer_id AS "reviewerId",d.reviewed_at::text AS "reviewedAt",d.receipt,d.error,d.created_at::text AS "createdAt",d.updated_at::text AS "updatedAt",v.title,v.action`;
const draftJoin = `tandem.project_drafts d JOIN tandem.project_draft_versions v ON v.workspace_id=d.workspace_id AND v.draft_id=d.id AND v.version=d.version`;

export class PostgresProjectsRepository implements ProjectsRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(
    scope: ResourceScope,
    operation: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withScope(this.pool, scope, operation);
    } catch (error) {
      return mappedError(error);
    }
  }
  private async selectDraft(client: pg.PoolClient, draftId: string) {
    const row = (
      await client.query<ProjectDraft>(
        `SELECT ${draftFields} FROM ${draftJoin} WHERE d.id=$1`,
        [draftId],
      )
    ).rows[0];
    if (!row) throw new DomainError('FORBIDDEN', '草案不存在或无访问权限');
    return row;
  }
  async links(scope: ResourceScope) {
    return this.scoped(
      scope,
      async (client) =>
        (
          await client.query<ProjectLink>(
            `SELECT ${linkFields} FROM tandem.project_links ORDER BY created_at,id`,
          )
        ).rows,
    );
  }
  async link(scope: ResourceScope, projectId: string, write = false) {
    return this.scoped(scope, async (client) => {
      const row = (
        await client.query<ProjectLink>(
          `SELECT ${linkFields} FROM tandem.project_links WHERE id=$1 AND tandem.can_access_project(id,$2)`,
          [projectId, write],
        )
      ).rows[0];
      if (!row) throw new DomainError('FORBIDDEN', '项目不存在或无访问权限');
      return row;
    });
  }
  async bind(scope: ResourceScope, connectionId: string, externalId: string) {
    const projectId = await this.scoped(
      scope,
      async (client) =>
        (
          await client.query<{ id: string }>(
            'SELECT tandem.bind_project($1,$2) AS id',
            [connectionId, externalId],
          )
        ).rows[0]!.id,
    );
    return this.link(scope, projectId);
  }
  async grants(scope: ResourceScope, projectId: string) {
    return this.scoped(
      scope,
      async (client) =>
        (
          await client.query<ProjectGrant>(
            `SELECT g.identity_id AS "identityId",m.display_name AS "displayName",g.role FROM tandem.project_grants g JOIN tandem.visible_workspace_members($1) m ON m.identity_id=g.identity_id WHERE g.project_id=$2 ORDER BY m.display_name,g.identity_id`,
            [scope.workspaceId, projectId],
          )
        ).rows,
    );
  }
  async grant(
    scope: ResourceScope,
    projectId: string,
    identityId: string,
    role: 'viewer' | 'editor' | null,
  ) {
    await this.scoped(scope, async (client) => {
      await client.query('SELECT tandem.change_project_grant($1,$2,$3)', [
        projectId,
        identityId,
        role,
      ]);
    });
  }
  async messages(scope: ResourceScope, projectId: string, taskId: string) {
    return this.scoped(
      scope,
      async (client) =>
        (
          await client.query<TaskMessage>(
            `SELECT t.id,t.task_id AS "taskId",t.actor_id AS "actorId",coalesce(m.display_name,'已离开成员') AS "displayName",t.body,t.created_at::text AS "createdAt" FROM tandem.task_messages t LEFT JOIN tandem.visible_workspace_members($1) m ON m.identity_id=t.actor_id WHERE t.project_id=$2 AND t.task_id=$3 ORDER BY t.created_at,t.id LIMIT 500`,
            [scope.workspaceId, projectId, taskId],
          )
        ).rows,
    );
  }
  async addMessage(
    scope: ResourceScope,
    projectId: string,
    taskId: string,
    body: string,
  ) {
    await this.scoped(scope, async (client) => {
      await client.query('SELECT tandem.add_task_message($1,$2,$3)', [
        projectId,
        taskId,
        body,
      ]);
    });
  }
  async drafts(scope: ResourceScope, projectId?: string) {
    return this.scoped(
      scope,
      async (client) =>
        (
          await client.query<ProjectDraft>(
            `SELECT ${draftFields} FROM ${draftJoin} WHERE ($1::uuid IS NULL OR d.project_id=$1) ORDER BY d.created_at DESC,d.id DESC LIMIT 200`,
            [projectId ?? null],
          )
        ).rows,
    );
  }
  draft(scope: ResourceScope, draftId: string) {
    return this.scoped(scope, (client) => this.selectDraft(client, draftId));
  }
  async createDraft(
    scope: ResourceScope,
    sessionId: string,
    projectId: string,
    title: string,
    action: ProjectDraftAction,
    requestId: string,
  ) {
    return this.scoped(scope, async (client) => {
      const value = (
        await client.query<{ id: string }>(
          'SELECT tandem.save_project_draft($1,$2,$3,$4::jsonb,$5) AS id',
          [projectId, sessionId, title, JSON.stringify(action), requestId],
        )
      ).rows[0]!;
      return this.selectDraft(client, value.id);
    });
  }
  async reviseDraft(
    scope: ResourceScope,
    draftId: string,
    version: number,
    title: string,
    action: ProjectDraftAction,
  ) {
    return this.scoped(scope, async (client) => {
      await client.query(
        'SELECT tandem.revise_project_draft($1,$2,$3,$4::jsonb)',
        [draftId, version, title, JSON.stringify(action)],
      );
      return this.selectDraft(client, draftId);
    });
  }
  async createWorkerDraft(
    fence: DraftFence,
    title: string,
    action: ExtensionDraftAction,
    requestId: string,
  ) {
    try {
      const result = await this.pool.query<{ value: ProjectDraft }>(
        'SELECT tandem.delivery_worker_create_draft($1,$2,$3,$4,$5::jsonb,$6) AS value',
        [
          fence.job.id,
          fence.job.token,
          fence.workerId,
          title,
          JSON.stringify(action),
          requestId,
        ],
      );
      if (!result.rows[0]?.value)
        throw new DomainError('FORBIDDEN', '运行租约或草案范围已失效');
      return result.rows[0].value;
    } catch (error) {
      return mappedError(error);
    }
  }
  async reviewDraft(
    scope: ResourceScope,
    draftId: string,
    version: number,
    approve: boolean,
  ) {
    return this.scoped(scope, async (client) => {
      await client.query('SELECT tandem.review_project_draft($1,$2,$3)', [
        draftId,
        version,
        approve,
      ]);
      return this.selectDraft(client, draftId);
    });
  }
  async workerContext(
    fence: DraftFence,
  ): Promise<DraftExecutionContext | null> {
    const result = await this.pool.query<{
      value: DraftExecutionContext | null;
    }>('SELECT tandem.draft_worker_context($1,$2,$3) AS value', [
      fence.job.id,
      fence.job.token,
      fence.workerId,
    ]);
    return result.rows[0]?.value ?? null;
  }
  async beginAction(fence: DraftFence) {
    const result = await this.pool.query<{ value: boolean }>(
      'SELECT tandem.begin_draft_action($1,$2,$3) AS value',
      [fence.job.id, fence.job.token, fence.workerId],
    );
    return result.rows[0]?.value ?? false;
  }
  async finishAction(
    fence: DraftFence,
    result: {
      status: 'succeeded' | 'failed' | 'unknown';
      receipt?: DraftReceipt;
      error?: string;
    },
  ) {
    const value = await this.pool.query<{ value: boolean }>(
      'SELECT tandem.finish_draft_action($1,$2,$3,$4,$5::jsonb,$6) AS value',
      [
        fence.job.id,
        fence.job.token,
        fence.workerId,
        result.status,
        result.receipt ? JSON.stringify(result.receipt) : null,
        result.error ?? null,
      ],
    );
    return value.rows[0]?.value ?? false;
  }
}
