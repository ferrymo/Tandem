import type pg from 'pg';
import { DomainError } from '@tandem/core';
import type {
  ResourceScope,
  WorkCredentialKind,
  WorkCredentialRepository,
  WorkCredentialState,
  WorkModelChannel,
} from '@tandem/core';
import { withScope } from './index';

export class PostgresWorkCredentialRepository implements WorkCredentialRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async assertAdmin(client: pg.PoolClient) {
    const result = await client.query('SELECT tandem.wm_lock_scope() AS role');
    if (!['owner', 'admin'].includes(result.rows[0]?.role))
      throw new DomainError('FORBIDDEN', '仅空间管理员可以管理或验证凭证');
  }

  private async assertTarget(
    client: pg.PoolClient,
    scope: ResourceScope,
    kind: WorkCredentialKind,
    id: string,
  ) {
    await this.assertAdmin(client);
    const table =
      kind === 'model-channel' ? 'wm_model_channels' : 'wm_connectors';
    const target = await client.query(
      `SELECT id FROM tandem.${table} WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, id],
    );
    if (!target.rowCount)
      throw new DomainError('FORBIDDEN', '配置不可用或无访问权限');
  }

  states(scope: ResourceScope): Promise<WorkCredentialState[]> {
    return withScope(this.pool, scope, async (client) => {
      const member = await client.query(
        'SELECT tandem.wm_lock_scope() AS role',
      );
      if (!member.rows[0]?.role)
        throw new DomainError('FORBIDDEN', '工作空间不可访问');
      if (!['owner', 'admin'].includes(member.rows[0].role)) return [];
      const result = await client.query(
        'SELECT kind,resource_id,fields,updated_at FROM tandem.wm_credentials WHERE workspace_id=$1 ORDER BY kind,resource_id',
        [scope.workspaceId],
      );
      return result.rows.map((row) => ({
        kind: row.kind,
        id: row.resource_id,
        configured: true,
        fields: row.fields,
        updatedAt: new Date(row.updated_at).toISOString(),
      }));
    });
  }

  read(scope: ResourceScope, kind: WorkCredentialKind, id: string) {
    return withScope(this.pool, scope, async (client) => {
      await this.assertTarget(client, scope, kind, id);
      const result = await client.query(
        'SELECT encrypted_values,fields FROM tandem.wm_credentials WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3',
        [scope.workspaceId, kind, id],
      );
      return result.rows[0]
        ? {
            encryptedValues: result.rows[0].encrypted_values as string,
            fields: result.rows[0].fields as string[],
          }
        : null;
    });
  }

  save(
    scope: ResourceScope,
    kind: WorkCredentialKind,
    id: string,
    input: {
      encryptedValues: string;
      fields: string[];
      expectedEncryptedValues: string | null;
    },
  ) {
    return withScope(this.pool, scope, async (client) => {
      await this.assertTarget(client, scope, kind, id);
      const result = await client.query(
        `INSERT INTO tandem.wm_credentials(workspace_id,kind,resource_id,model_channel_id,connector_id,encrypted_values,fields,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,kind,resource_id) DO UPDATE SET encrypted_values=EXCLUDED.encrypted_values,fields=EXCLUDED.fields,updated_by=EXCLUDED.updated_by,updated_at=now()
      WHERE tandem.wm_credentials.encrypted_values IS NOT DISTINCT FROM $9 RETURNING resource_id`,
        [
          scope.workspaceId,
          kind,
          id,
          kind === 'model-channel' ? id : null,
          kind === 'connector' ? id : null,
          input.encryptedValues,
          input.fields,
          scope.actorId,
          input.expectedEncryptedValues,
        ],
      );
      if (!result.rowCount)
        throw new DomainError('CONFLICT', '凭证已被其他操作修改，请重新保存');
    });
  }

  modelChannel(scope: ResourceScope, id: string): Promise<WorkModelChannel> {
    return withScope(this.pool, scope, async (client) => {
      await this.assertTarget(client, scope, 'model-channel', id);
      const result = await client.query(
        'SELECT * FROM tandem.wm_model_channels WHERE workspace_id=$1 AND id=$2',
        [scope.workspaceId, id],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError('FORBIDDEN', '模型渠道不可访问');
      return {
        id: row.id,
        version: row.version,
        name: row.name,
        baseUrl: row.base_url,
        protocol: row.protocol,
        models: row.models,
        credentialRef: row.credential_ref,
        enabled: row.enabled,
      };
    });
  }
}
