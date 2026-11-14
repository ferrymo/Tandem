import { DomainError } from '@tandem/core';
import type {
  DeliveryDetail,
  DeliveryDocument,
  DeliveryEvent,
  DeliveryFence,
  DeliveryProfiles,
  DeliveryRepository,
  DeliveryRun,
  DeliveryStart,
  DeliveryWorkerContext,
  DeploymentReceipt,
  DraftFence,
  ResourceScope,
  StoredSession,
} from '@tandem/core';
import type pg from 'pg';
import { withScope as scopedTransaction } from './index';

async function withScope<T>(
  pool: pg.Pool,
  scope: ResourceScope,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await scopedTransaction(pool, scope, work);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const code = error instanceof Error && 'code' in error ? error.code : '';
    if (code === '42501')
      throw new DomainError('FORBIDDEN', '无权访问运行或执行此操作');
    if (code === '23505')
      throw new DomainError('CONFLICT', '运行状态、版本或幂等请求发生冲突');
    if (['22023', '22P02', '23514', '23503'].includes(String(code)))
      throw new DomainError('INVALID_INPUT', '运行、预算或角色配置无效');
    throw error;
  }
}

const defaults: DeliveryProfiles = {
  designer: { model: '', instructions: '' },
  architect: { model: '', instructions: '' },
  engineer: { model: '', instructions: '' },
};
function run(row: Record<string, unknown>): DeliveryRun {
  const value: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(row))
    value[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] =
      item instanceof Date ? item.toISOString() : item;
  for (const key of ['requestId', 'requestHash', 'jobId', 'eventSequence'])
    delete value[key];
  return value as DeliveryRun;
}
function document(row: Record<string, unknown>): DeliveryDocument {
  return {
    kind: row.kind,
    role: row.role,
    version: row.version,
    content: row.content,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? row.createdAt),
  } as DeliveryDocument;
}
export class PostgresDeliveryRepository implements DeliveryRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async one(client: pg.PoolClient, id: string) {
    const result = await client.query(
      'SELECT * FROM tandem.delivery_runs WHERE id=$1',
      [id],
    );
    if (!result.rows[0])
      throw new DomainError('FORBIDDEN', '运行不存在或无访问权限');
    return run(result.rows[0]);
  }
  start(session: StoredSession, input: DeliveryStart) {
    return withScope(
      this.pool,
      { workspaceId: input.workspaceId, actorId: session.identity.id },
      async (client) => {
        const result = await client.query(
          'SELECT tandem.start_delivery_run($1::jsonb,$2) AS id',
          [JSON.stringify(input), session.id],
        );
        return this.one(client, result.rows[0].id);
      },
    );
  }
  list(scope: ResourceScope, projectId?: string) {
    return withScope(this.pool, scope, async (client) => {
      const r = await client.query(
        'SELECT * FROM tandem.delivery_runs WHERE ($1::uuid IS NULL OR project_id=$1) ORDER BY created_at DESC LIMIT 200',
        [projectId ?? null],
      );
      return r.rows.map(run);
    });
  }
  detail(scope: ResourceScope, runId: string): Promise<DeliveryDetail> {
    return withScope(this.pool, scope, async (client) => {
      const result = await this.one(client, runId);
      const events = await client.query(
        'SELECT sequence,kind,phase,role,summary,created_at FROM tandem.delivery_events WHERE run_id=$1 ORDER BY sequence',
        [runId],
      );
      const docs = await client.query(
        'SELECT kind,role,version,content,created_at FROM tandem.delivery_documents WHERE run_id=$1 ORDER BY created_at,kind,version',
        [runId],
      );
      return {
        run: result,
        events: events.rows.map((r) => ({
          ...r,
          createdAt: r.created_at.toISOString(),
        })) as DeliveryEvent[],
        documents: docs.rows.map(document),
      };
    });
  }
  control(
    scope: ResourceScope,
    runId: string,
    command: 'pause' | 'resume' | 'cancel',
    sessionId: string,
  ) {
    return withScope(this.pool, scope, async (client) => {
      await client.query('SELECT tandem.control_delivery_run($1,$2,$3)', [
        runId,
        command,
        sessionId,
      ]);
      return this.one(client, runId);
    });
  }
  profiles(scope: ResourceScope) {
    return withScope(this.pool, scope, async (client) => {
      const membership = await client.query(
        'SELECT tandem.current_member_role($1) AS role',
        [scope.workspaceId],
      );
      if (!membership.rows[0]?.role)
        throw new DomainError('FORBIDDEN', '无空间权限');
      const r = await client.query(
        'SELECT profiles FROM tandem.delivery_profiles WHERE workspace_id=$1',
        [scope.workspaceId],
      );
      return r.rows[0]?.profiles ?? defaults;
    });
  }
  setProfiles(scope: ResourceScope, profiles: DeliveryProfiles) {
    return withScope(this.pool, scope, async (client) => {
      for (const profile of Object.values(profiles)) {
        if (profile.model.startsWith('channel:'))
          await client.query(
            'SELECT tandem.validate_delivery_channel_profile($1)',
            [profile.model],
          );
      }
      await client.query(
        'INSERT INTO tandem.delivery_profiles(workspace_id,profiles) VALUES($1,$2::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET profiles=EXCLUDED.profiles,updated_at=clock_timestamp()',
        [scope.workspaceId, JSON.stringify(profiles)],
      );
    });
  }
  extendBudget(
    scope: ResourceScope,
    runId: string,
    calls: number,
    tokens: number,
  ) {
    return withScope(this.pool, scope, async (client) => {
      await client.query('SELECT tandem.extend_delivery_budget($1,$2,$3)', [
        runId,
        calls,
        tokens,
      ]);
      return this.one(client, runId);
    });
  }
  async workerContext(
    fence: DeliveryFence,
  ): Promise<DeliveryWorkerContext | null> {
    const result = await this.pool.query(
      'SELECT tandem.delivery_worker_context($1,$2,$3) AS context',
      [fence.job.id, fence.job.token, fence.workerId],
    );
    const context = result.rows[0]?.context;
    if (!context) return null;
    const documents = context.documents.map(document) as DeliveryDocument[];
    const snapshot = [...documents]
      .reverse()
      .find((d) => d.kind === 'profiles');
    return {
      ...context,
      run: run(context.run),
      documents,
      profiles: snapshot
        ? JSON.parse(snapshot.content)
        : (context.profiles ?? defaults),
    };
  }
  async deploymentContext(
    fence: DraftFence,
  ): Promise<DeliveryWorkerContext | null> {
    const result = await this.pool.query(
      'SELECT tandem.deployment_worker_context($1,$2,$3) AS context',
      [fence.job.id, fence.job.token, fence.workerId],
    );
    const context = result.rows[0]?.context;
    return context
      ? {
          ...context,
          run: run(context.run),
          documents: context.documents.map(document),
          profiles: context.profiles ?? defaults,
        }
      : null;
  }
  async recordDeployment(
    fence: DraftFence,
    runId: string,
    receipt: DeploymentReceipt,
  ): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT tandem.record_delivery_deployment($1,$2,$3,$4,$5::jsonb) AS valid',
      [
        fence.job.id,
        fence.job.token,
        fence.workerId,
        runId,
        JSON.stringify(receipt),
      ],
    );
    return result.rows[0]?.valid === true;
  }
  async deploymentWriteAllowed(fence: DraftFence): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT tandem.delivery_deployment_write_allowed($1,$2,$3) AS allowed',
      [fence.job.id, fence.job.token, fence.workerId],
    );
    return result.rows[0]?.allowed === true;
  }
  async withDeploymentLock<T>(
    fence: DraftFence,
    work: () => Promise<T>,
  ): Promise<T> {
    const context = await this.deploymentContext(fence);
    if (!context)
      throw new DomainError('FORBIDDEN', '部署草案租约或原身份不可用');
    const key = 'delivery:' + context.run.projectId;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        key,
      ]);
      return await work();
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key])
        .catch(() => undefined);
      client.release();
    }
  }
  reconciliationContext(
    scope: ResourceScope,
    runId: string,
    draftId: string,
    sessionId: string,
  ) {
    return withScope(this.pool, scope, async (client) => {
      const result = await client.query(
        'SELECT tandem.delivery_reconciliation_context($1,$2,$3) AS context',
        [runId, draftId, sessionId],
      );
      const context = result.rows[0].context;
      return {
        ...context,
        delivery: {
          ...context.delivery,
          run: run(context.delivery.run),
          documents: [],
          profiles: defaults,
        },
      };
    });
  }
  recordReconciliation(
    scope: ResourceScope,
    runId: string,
    draftId: string,
    sessionId: string,
    receipt: DeploymentReceipt | null,
    confirmNotPublished: boolean,
  ) {
    return withScope(this.pool, scope, async (client) => {
      await client.query(
        'SELECT tandem.reconcile_delivery_deployment($1,$2,$3,$4::jsonb,$5)',
        [
          runId,
          draftId,
          sessionId,
          receipt ? JSON.stringify(receipt) : null,
          confirmNotPublished,
        ],
      );
    });
  }
  private async update(fence: DeliveryFence, patch: unknown): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT tandem.delivery_worker_update($1,$2,$3,$4::jsonb) AS valid',
      [fence.job.id, fence.job.token, fence.workerId, JSON.stringify(patch)],
    );
    return r.rows[0]?.valid === true;
  }
  reserveCall(fence: DeliveryFence, estimatedTokens: number) {
    return this.update(fence, { reserveTokens: estimatedTokens });
  }
  async settleCall(
    fence: DeliveryFence,
    reservedTokens: number,
    actualTokens: number,
  ) {
    if (
      !(await this.update(fence, { tokenDelta: actualTokens - reservedTokens }))
    )
      throw new DomainError('CONFLICT', '运行租约已失效');
  }
  checkpoint(
    fence: DeliveryFence,
    input: Parameters<DeliveryRepository['checkpoint']>[1],
  ) {
    return this.update(fence, input);
  }
}
