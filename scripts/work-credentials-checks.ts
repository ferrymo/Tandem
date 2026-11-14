import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { StoredSession } from '../packages/core/src/index';
import { WorkCredentialsService } from '../packages/application/src/work-secrets';
import type { WorkManagementService } from '../packages/application/src/work-management';
import {
  PostgresWorkCredentialRepository,
  withScope,
} from '../packages/storage-postgres/src/index';
import { createSessionCodec } from '../packages/platform/src/session-crypto';

export async function checkWorkCredentials(input: {
  app: pg.Pool;
  service: WorkManagementService;
  owner: StoredSession;
  member: StoredSession;
  outsider: StoredSession;
  workspaceId: string;
  otherWorkspaceId: string;
  modelId: string;
}) {
  const {
    app,
    service,
    owner,
    member,
    outsider,
    workspaceId,
    otherWorkspaceId,
    modelId,
  } = input;
  const repo = new PostgresWorkCredentialRepository(app);
  const codec = createSessionCodec(randomBytes(32).toString('hex'));
  let calls = 0;
  const credentials = new WorkCredentialsService(repo, codec, {
    test: async (channel, key, model) => {
      calls++;
      assert.equal(key, 'isolated-model-private');
      assert.equal(model, 'model');
      return {
        checkedAt: new Date().toISOString(),
        latencyMs: 1,
        model,
        protocol: channel.protocol,
      };
    },
  });
  await credentials.save(owner, workspaceId, {
    kind: 'model-channel',
    id: modelId,
    values: { apiKey: 'isolated-model-private' },
  });
  const scope = { workspaceId, actorId: owner.identity.id };
  const saved = await repo.read(scope, 'model-channel', modelId);
  assert(saved);
  assert(!saved.encryptedValues.includes('isolated-model-private'));
  assert.equal(
    JSON.parse(
      codec.open(
        saved.encryptedValues,
        `work-credential:${workspaceId}:model-channel:${modelId}`,
      ),
    ).apiKey,
    'isolated-model-private',
  );
  assert.throws(() =>
    codec.open(
      saved.encryptedValues,
      `work-credential:${otherWorkspaceId}:model-channel:${modelId}`,
    ),
  );
  const states = await credentials.states(owner, workspaceId);
  assert(
    states.some(
      (state) => state.id === modelId && state.fields.includes('apiKey'),
    ),
  );
  assert(!JSON.stringify(states).includes('isolated-model-private'));
  assert(!JSON.stringify(states).includes('encrypted'));
  assert.deepEqual(await credentials.states(member, workspaceId), []);
  assert.equal(
    await withScope(
      app,
      { workspaceId, actorId: member.identity.id },
      async (client) =>
        (await client.query('SELECT * FROM tandem.wm_credentials')).rowCount,
    ),
    0,
  );
  await assert.rejects(
    credentials.save(member, workspaceId, {
      kind: 'model-channel',
      id: modelId,
      values: { apiKey: 'steal' },
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(credentials.testModel(member, workspaceId, modelId), {
    code: 'FORBIDDEN',
  });
  assert.equal(calls, 0);
  await assert.rejects(
    credentials.save(outsider, otherWorkspaceId, {
      kind: 'model-channel',
      id: modelId,
      values: { apiKey: 'cross-space' },
    }),
    { code: 'FORBIDDEN' },
  );
  await credentials.testModel(owner, workspaceId, modelId);
  assert.equal(calls, 1);

  const connector = await service.execute(owner, workspaceId, {
    command: 'save-connector',
    name: '隔离只读连接',
    baseUrl: 'https://zentao.example.com',
    databaseUser: 'readonly',
    enabled: false,
  });
  assert(connector.id);
  await credentials.save(owner, workspaceId, {
    kind: 'connector',
    id: connector.id,
    values: {
      account: 'readonly-user',
      apiPassword: 'isolated-account-private',
    },
  });
  await credentials.save(owner, workspaceId, {
    kind: 'connector',
    id: connector.id,
    values: { databasePassword: 'isolated-database-private' },
  });
  const connectorSecret = await repo.read(scope, 'connector', connector.id);
  assert(connectorSecret);
  const decoded = JSON.parse(
    codec.open(
      connectorSecret.encryptedValues,
      `work-credential:${workspaceId}:connector:${connector.id}`,
    ),
  );
  assert.deepEqual(decoded, {
    account: 'readonly-user',
    apiPassword: 'isolated-account-private',
    databasePassword: 'isolated-database-private',
  });
  await credentials.save(owner, workspaceId, {
    kind: 'connector',
    id: connector.id,
    values: { databasePassword: 'updated-private' },
  });
  await assert.rejects(
    repo.save(scope, 'connector', connector.id, {
      encryptedValues: connectorSecret.encryptedValues,
      fields: connectorSecret.fields,
      expectedEncryptedValues: connectorSecret.encryptedValues,
    }),
    { code: 'CONFLICT' },
  );
  const snapshot = await service.snapshot(owner, workspaceId);
  for (const secret of [
    'isolated-model-private',
    'isolated-account-private',
    'isolated-database-private',
    'updated-private',
  ])
    assert(!JSON.stringify(snapshot).includes(secret));
  await service.execute(owner, workspaceId, {
    command: 'remove-configuration',
    kind: 'connector',
    id: connector.id,
    version: connector.version,
  });
  assert(
    !(await credentials.states(owner, workspaceId)).some(
      (state) => state.id === connector.id,
    ),
  );
  assert.equal(
    await withScope(
      app,
      scope,
      async (client) =>
        (
          await client.query(
            'SELECT * FROM tandem.wm_credentials WHERE resource_id=$1',
            [connector.id],
          )
        ).rowCount,
    ),
    0,
  );
  await assert.rejects(repo.read(scope, 'connector', connector.id), {
    code: 'FORBIDDEN',
  });
  console.log(
    '凭证集成通过：AES-GCM密文/范围绑定、普通成员与跨空间隔离、模型调用前授权、部分更新合并、并发版本保护、配置删除级联。模型协议使用隔离HTTP替身另行验证。',
  );
}
