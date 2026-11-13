import type pg from 'pg';
import { DomainError } from '@tandem/core';
import type {
  CollaborationRepository,
  StoredSession,
  TeamOverview,
  VerifiedLogin,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSummary,
} from '@tandem/core';
import { withScope } from './index';

const actorOnlyWorkspace = '00000000-0000-0000-0000-000000000000';
function storageError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code =
    error instanceof Error && 'code' in error ? error.code : undefined;
  if (code === '42501')
    throw new DomainError('FORBIDDEN', '无权访问或管理此工作空间');
  if (code === '23505')
    throw new DomainError('CONFLICT', '请求标识已用于其他内容');
  if (code === '22023' || code === '22P02' || code === '23514')
    throw new DomainError('INVALID_INPUT', '输入内容不符合要求');
  throw error;
}

export class PostgresCollaborationRepository implements CollaborationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createSession(input: {
    login: Omit<VerifiedLogin, 'accessToken'>;
    tokenHash: string;
    encryptedCredential: string;
    expiresAt: string;
  }): Promise<StoredSession> {
    const { login } = input;
    const result = await this.pool.query<{ value: StoredSession }>(
      'SELECT tandem.create_identity_session($1,$2,$3,$4,$5,$6,$7) AS value',
      [
        login.providerId,
        login.subject,
        login.displayName,
        login.canCreateWorkspace,
        input.tokenHash,
        input.encryptedCredential,
        input.expiresAt,
      ],
    );
    return result.rows[0]!.value;
  }

  async session(tokenHash: string): Promise<StoredSession | null> {
    const result = await this.pool.query<{ value: StoredSession | null }>(
      'SELECT tandem.find_identity_session($1) AS value',
      [tokenHash],
    );
    return result.rows[0]?.value ?? null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query('SELECT tandem.revoke_identity_session($1)', [
      tokenHash,
    ]);
  }

  async refreshIdentity(
    identityId: string,
    login: Omit<VerifiedLogin, 'accessToken'>,
  ): Promise<void> {
    try {
      await this.pool.query('SELECT tandem.refresh_identity($1,$2,$3,$4,$5)', [
        identityId,
        login.providerId,
        login.subject,
        login.displayName,
        login.canCreateWorkspace,
      ]);
    } catch (error) {
      storageError(error);
    }
  }

  private async scoped<T>(
    actorId: string,
    workspaceId: string,
    operation: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withScope(this.pool, { actorId, workspaceId }, operation);
    } catch (error) {
      return storageError(error);
    }
  }

  async listWorkspaces(actorId: string): Promise<readonly WorkspaceSummary[]> {
    return this.scoped(
      actorId,
      actorOnlyWorkspace,
      async (client) =>
        (
          await client.query<WorkspaceSummary>(
            'SELECT * FROM tandem.actor_workspaces()',
          )
        ).rows,
    );
  }

  async createWorkspace(
    actorId: string,
    name: string,
    requestId: string,
  ): Promise<WorkspaceSummary> {
    return this.scoped(
      actorId,
      actorOnlyWorkspace,
      async (client) =>
        (
          await client.query<WorkspaceSummary>(
            'SELECT * FROM tandem.initialize_workspace($1,$2)',
            [name, requestId],
          )
        ).rows[0]!,
    );
  }

  async overview(
    actorId: string,
    workspaceId: string,
  ): Promise<{ workspace: WorkspaceSummary; team: TeamOverview }> {
    return this.scoped(actorId, workspaceId, async (client) => {
      const workspace = (
        await client.query<{ id: string; name: string; role: WorkspaceRole }>(
          'SELECT id,name,tandem.current_member_role(id) AS role FROM tandem.workspaces WHERE id=$1',
          [workspaceId],
        )
      ).rows[0];
      if (!workspace)
        throw new DomainError('FORBIDDEN', '工作空间不存在或无访问权限');
      const team = (
        await client.query<{
          id: string;
          name: string;
          template_version: number;
          owner_id: string;
        }>(
          "SELECT id,name,template_version,owner_id FROM tandem.agent_teams WHERE workspace_id=$1 AND template_key='default-t'",
          [workspaceId],
        )
      ).rows[0];
      if (!team) throw new DomainError('UNAVAILABLE', '默认团队尚未初始化');
      const agents = (
        await client.query<TeamOverview['agents'][number]>(
          `SELECT id,role,name,description FROM tandem.agents WHERE workspace_id=$1 AND team_id=$2
        ORDER BY CASE role WHEN 'designer' THEN 0 WHEN 'architect' THEN 1 ELSE 2 END`,
          [workspaceId, team.id],
        )
      ).rows;
      const members = (
        await client.query<{ identity_id: string; display_name: string }>(
          'SELECT * FROM tandem.visible_workspace_members($1)',
          [workspaceId],
        )
      ).rows;
      const owner = members.find(
        (member) => member.identity_id === team.owner_id,
      );
      if (!owner || agents.length !== 3)
        throw new DomainError('UNAVAILABLE', '默认团队配置不完整');
      return {
        workspace,
        team: {
          id: team.id,
          name: team.name,
          templateVersion: team.template_version,
          ownerId: team.owner_id,
          ownerDisplayName: owner.display_name,
          agents,
        },
      };
    });
  }

  async members(
    actorId: string,
    workspaceId: string,
  ): Promise<readonly WorkspaceMember[]> {
    return this.scoped(
      actorId,
      workspaceId,
      async (client) =>
        (
          await client.query<WorkspaceMember>(
            'SELECT identity_id AS "identityId", display_name AS "displayName", role FROM tandem.visible_workspace_members($1)',
            [workspaceId],
          )
        ).rows,
    );
  }

  async setMember(
    actorId: string,
    workspaceId: string,
    identityId: string,
    role: 'admin' | 'member',
  ): Promise<void> {
    await this.scoped(actorId, workspaceId, async (client) => {
      await client.query('SELECT tandem.change_workspace_member($1,$2,$3)', [
        workspaceId,
        identityId,
        role,
      ]);
    });
  }

  async removeMember(
    actorId: string,
    workspaceId: string,
    identityId: string,
  ): Promise<void> {
    await this.scoped(actorId, workspaceId, async (client) => {
      await client.query('SELECT tandem.change_workspace_member($1,$2,NULL)', [
        workspaceId,
        identityId,
      ]);
    });
  }
}
