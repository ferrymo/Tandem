import type pg from 'pg';
import { DomainError } from '@tandem/core';
import type {
  ConnectorAuthorization,
  ConnectorAuthorizationRepository,
  ResourceScope,
  WorkConnector,
  WorkCredentialState,
} from '@tandem/core';
import { withScope } from './index';

export class PostgresConnectorAuthorizationRepository implements ConnectorAuthorizationRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async scoped<T>(
    scope: ResourceScope,
    work: (client: pg.PoolClient) => Promise<T>,
  ) {
    try {
      return await withScope(this.pool, scope, async (client) => {
        await client.query('SELECT tandem.wm_lock_scope()');
        return work(client);
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '42501'
      )
        throw new DomainError('FORBIDDEN', '当前空间或连接授权已撤销');
      throw error;
    }
  }
  configuration(scope: ResourceScope, id: string): Promise<WorkConnector> {
    return this.scoped(scope, async (client) => {
      const result = await client.query(
        'SELECT tandem.wm_connector_configuration($1) AS value',
        [id],
      );
      return result.rows[0].value;
    });
  }
  authorization(
    scope: ResourceScope,
    id: string,
  ): Promise<ConnectorAuthorization | null> {
    return this.scoped(scope, async (client) => {
      await client.query('SELECT tandem.wm_connector_configuration($1)', [id]);
      const result = await client.query(
        'SELECT encrypted_values,configuration_version,version FROM tandem.wm_connector_authorizations WHERE workspace_id=$1 AND connector_id=$2 AND actor_id=$3',
        [scope.workspaceId, id, scope.actorId],
      );
      const row = result.rows[0];
      return row
        ? {
            encryptedValues: row.encrypted_values,
            configurationVersion: row.configuration_version,
            version: row.version,
          }
        : null;
    });
  }
  save(
    scope: ResourceScope,
    id: string,
    value: {
      encryptedValues: string;
      configurationVersion: number;
      expectedVersion: number | null;
    },
  ) {
    return this.scoped(scope, async (client) => {
      const config = (
        await client.query(
          'SELECT tandem.wm_connector_configuration($1) AS value',
          [id],
        )
      ).rows[0].value;
      if (config.version !== value.configurationVersion)
        throw new DomainError('CONFLICT', '连接配置已更改，请重新读取后授权');
      const result = await client.query(
        `INSERT INTO tandem.wm_connector_authorizations(workspace_id,connector_id,actor_id,configuration_version,encrypted_values) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(workspace_id,connector_id,actor_id) DO UPDATE SET configuration_version=EXCLUDED.configuration_version,encrypted_values=EXCLUDED.encrypted_values,version=wm_connector_authorizations.version+1,updated_at=now() WHERE wm_connector_authorizations.version=$6 RETURNING version`,
        [
          scope.workspaceId,
          id,
          scope.actorId,
          value.configurationVersion,
          value.encryptedValues,
          value.expectedVersion,
        ],
      );
      if (!result.rowCount)
        throw new DomainError(
          'CONFLICT',
          '本人授权已被其他操作修改，请重新读取',
        );
    });
  }
  states(scope: ResourceScope): Promise<WorkCredentialState[]> {
    return this.scoped(scope, async (client) => {
      const result = await client.query(
        `SELECT connector_id,configuration_version,updated_at,tandem.wm_connector_configuration(connector_id) AS config FROM tandem.wm_connector_authorizations WHERE workspace_id=$1 AND actor_id=$2`,
        [scope.workspaceId, scope.actorId],
      );
      return result.rows.map((row) => ({
        kind: 'connector',
        id: row.connector_id,
        configured: row.configuration_version === row.config.version,
        fields:
          row.configuration_version === row.config.version
            ? ['account', 'apiPassword', 'databasePassword']
            : [],
        updatedAt: new Date(row.updated_at).toISOString(),
      }));
    });
  }
}
