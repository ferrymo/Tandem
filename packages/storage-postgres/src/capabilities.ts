import type pg from 'pg';
import { DomainError } from '@tandem/core';
import type {
  CapabilityBinding,
  CapabilityRepository,
  CapabilityUsage,
  DraftFence,
  InstalledSkill,
  McpConnection,
  McpServer,
  McpTool,
  McpToolGrant,
  ResourceScope,
  SkillBinding,
  SkillBundle,
  StoredSession,
  ToolEffect,
} from '@tandem/core';
import { withScope } from './index';

const skillSelect = `SELECT jsonb_build_object('id',s.id,'name',s.name,'description',s.description,'enabled',s.enabled,'removed',s.removed,'activeVersionId',s.active_version_id,
 'versions',coalesce((SELECT jsonb_agg(v.bundle || jsonb_build_object('id',v.id,'skillId',v.skill_id,'contentHash',v.content_hash,'installedAt',v.installed_at) ORDER BY v.installed_at,v.id)
 FROM tandem.skill_versions v WHERE v.workspace_id=s.workspace_id AND v.skill_id=s.id),'[]'::jsonb)) AS value FROM tandem.skills s`;
const serverSelect = `SELECT jsonb_build_object('id',s.id,'name',s.name,'connection',s.connection,'revision',s.revision,'enabled',s.enabled,'status',s.status,'checkedAt',s.checked_at,'tools',s.tools,
 'credentialConfigured',EXISTS(SELECT 1 FROM tandem.mcp_credentials c WHERE c.workspace_id=s.workspace_id AND c.server_id=s.id AND c.server_revision=s.revision AND c.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid)) AS value FROM tandem.mcp_servers s`;
const skillBindingSelect = `SELECT id,skill_id AS "skillId",version_id AS "versionId",project_id AS "projectId",team_id AS "teamId",nullif(agent_role,'*') AS "agentRole",permissions,enabled FROM tandem.skill_bindings`;
const grantSelect = `SELECT id,server_id AS "serverId",tool_name AS "toolName",schema_hash AS "schemaHash",revision,project_id AS "projectId",team_id AS "teamId",nullif(agent_role,'*') AS "agentRole",effect,enabled FROM tandem.mcp_tool_grants`;

export class PostgresCapabilityRepository implements CapabilityRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly fence?: DraftFence,
  ) {}
  private async scoped<T>(
    scope: ResourceScope,
    operation: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withScope(this.pool, scope, async (client) => {
        if (this.fence) {
          await client.query(
            `SELECT set_config('app.job_id',$1,true),set_config('app.job_token',$2,true),set_config('app.worker_id',$3,true)`,
            [this.fence.job.id, this.fence.job.token, this.fence.workerId],
          );
          const access = await client.query<{ allowed: boolean }>(
            'SELECT tandem.capability_worker_scope($1) AS allowed',
            [scope.workspaceId],
          );
          if (!access.rows[0]?.allowed)
            throw new DomainError(
              'FORBIDDEN',
              '后台能力执行租约、身份或项目授权已失效',
            );
        }
        return operation(client);
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code =
        error instanceof Error && 'code' in error ? error.code : null;
      if (code === '42501' || code === '23503')
        throw new DomainError('FORBIDDEN', '无权访问此能力、项目或团队');
      if (code === '23505')
        throw new DomainError('CONFLICT', '能力名称、版本或授权已存在');
      if (code === '23514' || code === '22P02')
        throw new DomainError('INVALID_INPUT', '能力配置不符合要求');
      throw error;
    }
  }
  async assertManage(scope: ResourceScope) {
    return this.scoped(scope, async (client) => {
      const result = await client.query<{ allowed: boolean }>(
        `SELECT tandem.current_member_role($1) IN ('owner','admin') AS allowed`,
        [scope.workspaceId],
      );
      if (!result.rows[0]?.allowed)
        throw new DomainError('FORBIDDEN', '仅工作空间管理员可管理能力');
    });
  }
  ownerSession(
    scope: ResourceScope,
    projectId: string,
    teamId: string,
    write = false,
  ) {
    return this.scoped(scope, async (c) => {
      const owner = (
        await c.query<{ value: StoredSession | null }>(
          'SELECT tandem.capability_owner_session($1,$2,$3) AS value',
          [projectId, teamId, write],
        )
      ).rows[0]?.value;
      if (!owner)
        throw new DomainError('FORBIDDEN', '团队挂靠人的项目授权或会话已失效');
      return owner;
    });
  }
  listSkills(scope: ResourceScope) {
    return this.scoped(scope, async (c) =>
      (
        await c.query<{ value: InstalledSkill }>(
          skillSelect +
            ' WHERE s.workspace_id=$1 AND NOT s.removed ORDER BY s.name',
          [scope.workspaceId],
        )
      ).rows.map((r) => r.value),
    );
  }
  private async readSkill(
    c: pg.PoolClient,
    scope: ResourceScope,
    skillId: string,
  ) {
    const value = (
      await c.query<{ value: InstalledSkill }>(
        skillSelect + ' WHERE s.workspace_id=$1 AND s.id=$2',
        [scope.workspaceId, skillId],
      )
    ).rows[0]?.value;
    if (!value) throw new DomainError('FORBIDDEN', '技能不存在或无权访问');
    return value;
  }
  getSkill(scope: ResourceScope, skillId: string) {
    return this.scoped(scope, (c) => this.readSkill(c, scope, skillId));
  }
  installSkill(scope: ResourceScope, bundle: SkillBundle, contentHash: string) {
    return this.scoped(scope, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        scope.workspaceId + ':skill:' + bundle.name,
      ]);
      const skill =
        (
          await c.query<{ id: string }>(
            'SELECT id FROM tandem.skills WHERE workspace_id=$1 AND name=$2 FOR UPDATE',
            [scope.workspaceId, bundle.name],
          )
        ).rows[0] ??
        (
          await c.query<{ id: string }>(
            'INSERT INTO tandem.skills(workspace_id,name,description) VALUES($1,$2,$3) RETURNING id',
            [scope.workspaceId, bundle.name, bundle.description],
          )
        ).rows[0]!;
      let version = (
        await c.query<{ id: string; content_hash: string }>(
          'SELECT id,content_hash FROM tandem.skill_versions WHERE workspace_id=$1 AND skill_id=$2 AND version=$3',
          [scope.workspaceId, skill.id, bundle.version],
        )
      ).rows[0];
      if (version && version.content_hash !== contentHash)
        throw new DomainError(
          'CONFLICT',
          '同一技能版本内容不可修改，请使用新版本号',
        );
      if (!version)
        version = (
          await c.query<{ id: string; content_hash: string }>(
            'INSERT INTO tandem.skill_versions(workspace_id,skill_id,version,content_hash,bundle) VALUES($1,$2,$3,$4,$5) RETURNING id,content_hash',
            [
              scope.workspaceId,
              skill.id,
              bundle.version,
              contentHash,
              JSON.stringify(bundle),
            ],
          )
        ).rows[0]!;
      await c.query(
        'UPDATE tandem.skills SET active_version_id=$3,description=$4,enabled=true,removed=false WHERE workspace_id=$1 AND id=$2',
        [scope.workspaceId, skill.id, version.id, bundle.description],
      );
      return this.readSkill(c, scope, skill.id);
    });
  }
  activateSkill(scope: ResourceScope, skillId: string, versionId: string) {
    return this.scoped(scope, async (c) => {
      const result = await c.query(
        `UPDATE tandem.skills s SET active_version_id=$3 WHERE workspace_id=$1 AND id=$2 AND NOT removed AND EXISTS(SELECT 1 FROM tandem.skill_versions v WHERE v.workspace_id=$1 AND v.skill_id=$2 AND v.id=$3)`,
        [scope.workspaceId, skillId, versionId],
      );
      if (!result.rowCount)
        throw new DomainError('FORBIDDEN', '技能或版本不存在');
    });
  }
  setSkillEnabled(scope: ResourceScope, skillId: string, enabled: boolean) {
    return this.scoped(scope, async (c) => {
      if (
        !(
          await c.query(
            'UPDATE tandem.skills SET enabled=$3 WHERE workspace_id=$1 AND id=$2 AND NOT removed',
            [scope.workspaceId, skillId, enabled],
          )
        ).rowCount
      )
        throw new DomainError('FORBIDDEN', '技能不存在或已卸载');
    });
  }
  uninstallSkill(scope: ResourceScope, skillId: string) {
    return this.scoped(scope, async (c) => {
      if (
        !(
          await c.query(
            'UPDATE tandem.skills SET enabled=false,removed=true,active_version_id=NULL WHERE workspace_id=$1 AND id=$2',
            [scope.workspaceId, skillId],
          )
        ).rowCount
      )
        throw new DomainError('FORBIDDEN', '技能不存在');
    });
  }
  bindSkill(
    scope: ResourceScope,
    skillId: string,
    versionId: string,
    binding: CapabilityBinding,
    permissions: string[],
    enabled: boolean,
  ) {
    return this.scoped(scope, async (c) => {
      const result = await c.query<{ id: string }>(
        `INSERT INTO tandem.skill_bindings(workspace_id,project_id,team_id,agent_role,skill_id,version_id,permissions,enabled)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8 FROM tandem.skill_versions v JOIN tandem.skills s ON s.workspace_id=v.workspace_id AND s.id=v.skill_id
 WHERE v.workspace_id=$1 AND v.skill_id=$5 AND v.id=$6 AND (NOT $8::boolean OR (s.enabled AND NOT s.removed)) AND (v.bundle->'permissions') @> $7::jsonb
 ON CONFLICT(workspace_id,project_id,team_id,agent_role,skill_id) DO UPDATE SET version_id=EXCLUDED.version_id,permissions=EXCLUDED.permissions,enabled=EXCLUDED.enabled RETURNING id`,
        [
          scope.workspaceId,
          binding.projectId,
          binding.teamId,
          binding.agentRole ?? '*',
          skillId,
          versionId,
          JSON.stringify(permissions),
          enabled,
        ],
      );
      if (!result.rows[0])
        throw new DomainError('FORBIDDEN', '技能版本不可用或权限超出声明');
      return (
        await c.query<SkillBinding>(skillBindingSelect + ' WHERE id=$1', [
          result.rows[0].id,
        ])
      ).rows[0]!;
    });
  }
  skillBindings(scope: ResourceScope, projectId?: string) {
    return this.scoped(
      scope,
      async (c) =>
        (
          await c.query<SkillBinding>(
            skillBindingSelect +
              ' WHERE workspace_id=$1' +
              (projectId ? ' AND project_id=$2' : '') +
              ' ORDER BY id',
            projectId ? [scope.workspaceId, projectId] : [scope.workspaceId],
          )
        ).rows,
    );
  }
  listServers(scope: ResourceScope) {
    return this.scoped(scope, async (c) =>
      (
        await c.query<{ value: McpServer }>(
          serverSelect +
            ' WHERE s.workspace_id=$1 AND NOT s.removed ORDER BY s.created_at,s.id',
          [scope.workspaceId],
        )
      ).rows.map((r) => r.value),
    );
  }
  private async readServer(
    c: pg.PoolClient,
    scope: ResourceScope,
    serverId: string,
  ) {
    const server = (
      await c.query<{ value: McpServer }>(
        serverSelect + ' WHERE s.workspace_id=$1 AND s.id=$2 AND NOT s.removed',
        [scope.workspaceId, serverId],
      )
    ).rows[0]?.value;
    if (!server)
      throw new DomainError('FORBIDDEN', 'MCP Server 不存在或无权访问');
    return server;
  }
  getServer(scope: ResourceScope, serverId: string) {
    return this.scoped(scope, (c) => this.readServer(c, scope, serverId));
  }
  toolAuthorization(
    scope: ResourceScope,
    input: Parameters<CapabilityRepository['toolAuthorization']>[1],
  ) {
    return this.scoped(scope, async (client) => {
      const row = (
        await client.query<{
          server: McpServer;
          tool: McpTool;
          effect: ToolEffect;
        }>(
          `SELECT snapshot.value AS server,tool.item AS tool,g.effect FROM (${serverSelect} WHERE s.workspace_id=$1 AND s.id=$2 AND NOT s.removed) snapshot
         CROSS JOIN LATERAL jsonb_array_elements(snapshot.value->'tools') AS tool(item)
         JOIN tandem.mcp_tool_grants g ON g.workspace_id=$1 AND g.server_id=$2 AND g.project_id=$3 AND g.team_id=$4 AND g.agent_role IN('*',$5)
          AND g.tool_name=tool.item->>'name' AND g.schema_hash=tool.item->>'schemaHash' AND g.revision=(snapshot.value->>'revision')::integer
         WHERE tool.item->>'name'=$6 AND g.enabled AND g.effect IN('read','write') AND (snapshot.value->>'enabled')::boolean
          AND snapshot.value->>'status' IN('ready','changed') AND ($7::integer IS NULL OR (snapshot.value->>'revision')::integer=$7)
          AND ($8::text IS NULL OR tool.item->>'schemaHash'=$8) ORDER BY (g.agent_role=$5) DESC LIMIT 1`,
          [
            scope.workspaceId,
            input.serverId,
            input.projectId,
            input.teamId,
            input.agentRole,
            input.toolName,
            input.expectedRevision ?? null,
            input.expectedSchemaHash ?? null,
          ],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          input.expectedRevision === undefined ? 'FORBIDDEN' : 'CONFLICT',
          'MCP Server、工具版本或授权已变化，当前调用不能继续',
        );
      return row;
    });
  }
  saveServer(
    scope: ResourceScope,
    input: {
      id?: string;
      name: string;
      connection: McpConnection;
      expectedRevision?: number;
    },
  ) {
    return this.scoped(scope, async (c) => {
      let serverId: string;
      if (input.id) {
        if (!Number.isInteger(input.expectedRevision))
          throw new DomainError(
            'INVALID_INPUT',
            '更新 MCP Server 须提供当前版本',
          );
        const result = await c.query<{ id: string }>(
          `UPDATE tandem.mcp_servers SET name=$3,connection=$4,revision=revision+1,status='untested',tools='[]',checked_at=NULL WHERE workspace_id=$1 AND id=$2 AND revision=$5 AND NOT removed RETURNING id`,
          [
            scope.workspaceId,
            input.id,
            input.name,
            JSON.stringify(input.connection),
            input.expectedRevision,
          ],
        );
        if (!result.rows[0])
          throw new DomainError('CONFLICT', 'MCP Server 已被修改或无权访问');
        serverId = result.rows[0].id;
      } else
        serverId = (
          await c.query<{ id: string }>(
            'INSERT INTO tandem.mcp_servers(workspace_id,name,connection) VALUES($1,$2,$3) RETURNING id',
            [scope.workspaceId, input.name, JSON.stringify(input.connection)],
          )
        ).rows[0]!.id;
      return this.readServer(c, scope, serverId);
    });
  }
  setServerEnabled(scope: ResourceScope, serverId: string, enabled: boolean) {
    return this.scoped(scope, async (c) => {
      if (
        !(
          await c.query(
            'UPDATE tandem.mcp_servers SET enabled=$3 WHERE workspace_id=$1 AND id=$2 AND NOT removed',
            [scope.workspaceId, serverId, enabled],
          )
        ).rowCount
      )
        throw new DomainError('FORBIDDEN', 'MCP Server 不存在');
    });
  }
  removeServer(scope: ResourceScope, serverId: string) {
    return this.scoped(scope, async (c) => {
      if (
        !(
          await c.query(
            `UPDATE tandem.mcp_servers SET enabled=false,removed=true,revision=revision+1,status='unavailable' WHERE workspace_id=$1 AND id=$2 AND NOT removed`,
            [scope.workspaceId, serverId],
          )
        ).rowCount
      )
        throw new DomainError('FORBIDDEN', 'MCP Server 不存在');
      // Version bump invalidates every immutable grant and credential without deleting audit evidence.
    });
  }
  saveCatalog(
    scope: ResourceScope,
    serverId: string,
    revision: number,
    tools: McpTool[] | null,
  ) {
    return this.scoped(scope, async (c) => {
      const result = await c.query(
        `UPDATE tandem.mcp_servers SET status=CASE WHEN $4::jsonb IS NULL THEN 'unavailable' WHEN checked_at IS NOT NULL AND tools <> $4::jsonb THEN 'changed' ELSE 'ready' END,tools=coalesce($4::jsonb,tools),checked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND revision=$3`,
        [
          scope.workspaceId,
          serverId,
          revision,
          tools === null ? null : JSON.stringify(tools),
        ],
      );
      if (!result.rowCount)
        throw new DomainError('CONFLICT', 'MCP Server 配置已更新，请重新测试');
      return this.readServer(c, scope, serverId);
    });
  }
  setCredential(
    scope: ResourceScope,
    serverId: string,
    ciphertext: string | null,
  ) {
    return this.scoped(scope, async (c) => {
      if (ciphertext === null) {
        await c.query(
          'DELETE FROM tandem.mcp_credentials WHERE workspace_id=$1 AND server_id=$2 AND actor_id=$3',
          [scope.workspaceId, serverId, scope.actorId],
        );
        return;
      }
      const result = await c.query(
        `INSERT INTO tandem.mcp_credentials(workspace_id,server_id,actor_id,server_revision,ciphertext) SELECT $1,id,$3,revision,$4 FROM tandem.mcp_servers WHERE workspace_id=$1 AND id=$2 ON CONFLICT(workspace_id,server_id,actor_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,server_revision=EXCLUDED.server_revision`,
        [scope.workspaceId, serverId, scope.actorId, ciphertext],
      );
      if (!result.rowCount)
        throw new DomainError('FORBIDDEN', 'MCP Server 不存在');
    });
  }
  credential(scope: ResourceScope, serverId: string, revision?: number) {
    return this.scoped(
      scope,
      async (c) =>
        (
          await c.query<{ ciphertext: string }>(
            `SELECT c.ciphertext FROM tandem.mcp_credentials c JOIN tandem.mcp_servers s ON s.workspace_id=c.workspace_id AND s.id=c.server_id AND s.revision=c.server_revision WHERE c.workspace_id=$1 AND c.server_id=$2 AND c.actor_id=$3 AND ($4::integer IS NULL OR s.revision=$4)`,
            [scope.workspaceId, serverId, scope.actorId, revision ?? null],
          )
        ).rows[0]?.ciphertext ?? null,
    );
  }
  grantTool(
    scope: ResourceScope,
    serverId: string,
    tool: McpTool,
    revision: number,
    binding: CapabilityBinding,
    effect: ToolEffect,
    enabled: boolean,
  ) {
    return this.scoped(scope, async (c) => {
      if (!enabled) {
        const updated = await c.query<{ id: string }>(
          `UPDATE tandem.mcp_tool_grants SET enabled=false WHERE workspace_id=$1 AND project_id=$2 AND team_id=$3 AND agent_role=$4 AND server_id=$5 AND tool_name=$6 RETURNING id`,
          [
            scope.workspaceId,
            binding.projectId,
            binding.teamId,
            binding.agentRole ?? '*',
            serverId,
            tool.name,
          ],
        );
        if (!updated.rows[0])
          throw new DomainError('FORBIDDEN', '工具授权不存在或无权访问');
        return (
          await c.query<McpToolGrant>(grantSelect + ' WHERE id=$1', [
            updated.rows[0].id,
          ])
        ).rows[0]!;
      }
      const result = await c.query<{ id: string }>(
        `INSERT INTO tandem.mcp_tool_grants(workspace_id,project_id,team_id,agent_role,server_id,tool_name,schema_hash,revision,effect,enabled)
 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM tandem.mcp_servers WHERE workspace_id=$1 AND id=$5 AND revision=$8 AND enabled AND status IN ('ready','changed') AND tools @> $11::jsonb
 ON CONFLICT(workspace_id,project_id,team_id,agent_role,server_id,tool_name) DO UPDATE SET schema_hash=EXCLUDED.schema_hash,revision=EXCLUDED.revision,effect=EXCLUDED.effect,enabled=EXCLUDED.enabled RETURNING id`,
        [
          scope.workspaceId,
          binding.projectId,
          binding.teamId,
          binding.agentRole ?? '*',
          serverId,
          tool.name,
          tool.schemaHash,
          revision,
          effect,
          enabled,
          JSON.stringify([{ name: tool.name, schemaHash: tool.schemaHash }]),
        ],
      );
      if (!result.rows[0])
        throw new DomainError('CONFLICT', 'MCP 工具定义或配置已变更');
      return (
        await c.query<McpToolGrant>(grantSelect + ' WHERE id=$1', [
          result.rows[0].id,
        ])
      ).rows[0]!;
    });
  }
  toolGrants(scope: ResourceScope, projectId?: string) {
    return this.scoped(
      scope,
      async (c) =>
        (
          await c.query<McpToolGrant>(
            grantSelect +
              ' WHERE workspace_id=$1' +
              (projectId ? ' AND project_id=$2' : '') +
              ' ORDER BY id',
            projectId ? [scope.workspaceId, projectId] : [scope.workspaceId],
          )
        ).rows,
    );
  }
  recordUsage(
    scope: ResourceScope,
    input: Omit<CapabilityUsage, 'id' | 'createdAt' | 'actorId'>,
  ) {
    return this.scoped(scope, async (c) => {
      await c.query(
        'INSERT INTO tandem.capability_usage(workspace_id,project_id,actor_id,kind,resource_id,version,status,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          scope.workspaceId,
          input.projectId,
          scope.actorId,
          input.kind,
          input.resourceId,
          input.version,
          input.status,
          input.summary,
        ],
      );
    });
  }
  usage(scope: ResourceScope, projectId: string) {
    return this.scoped(
      scope,
      async (c) =>
        (
          await c.query<CapabilityUsage>(
            `SELECT id,kind,resource_id AS "resourceId",project_id AS "projectId",actor_id AS "actorId",version,status,summary,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt" FROM tandem.capability_usage WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100`,
            [scope.workspaceId, projectId],
          )
        ).rows,
    );
  }
}
