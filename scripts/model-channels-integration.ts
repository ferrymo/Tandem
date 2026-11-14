import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { WorkManagementService } from '../packages/application/src/work-management';
import { WorkCredentialsService } from '../packages/application/src/work-secrets';
import { createSessionCodec } from '../packages/platform/src/session-crypto';
import {
  CompatibleDeliveryModel,
  ProtocolModelConnection,
  RoutedDeliveryModel,
} from '../adapters/model/src/index';
import { formatDeliveryChannelModel } from '../packages/core/src/index';
import {
  createPool,
  PostgresCollaborationRepository,
  PostgresProjectsRepository,
  PostgresDeliveryRepository,
  PostgresDeliveryModelChannels,
  PostgresJobQueue,
  PostgresWorkManagementRepository,
  PostgresWorkCredentialRepository,
} from '../packages/storage-postgres/src/index';

const name = 'tandem_models_' + randomUUID().replaceAll('-', '');
const env = { ...process.env };
for (const key of [
  'DATABASE_ADMIN_URL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'WORKER_DATABASE_URL',
]) {
  if (!env[key]) throw new Error('请先初始化 .env');
  const address = new URL(env[key]);
  address.pathname = '/' + name;
  env[key] = address.href;
}
const admin = new pg.Client({
  connectionString: process.env.DATABASE_ADMIN_URL,
});
await admin.connect();
await admin.query('CREATE DATABASE ' + name);
const app = createPool(env.DATABASE_URL!),
  worker = createPool(env.WORKER_DATABASE_URL!);
const codec = createSessionCodec(randomBytes(32).toString('hex'));
const collab = new PostgresCollaborationRepository(app);
const work = new WorkManagementService(
  new PostgresWorkManagementRepository(app),
);
const credentials = new WorkCredentialsService(
  new PostgresWorkCredentialRepository(app),
  codec,
  new ProtocolModelConnection(),
);
const delivery = new PostgresDeliveryRepository(app),
  workerDelivery = new PostgresDeliveryRepository(worker);
const source = new PostgresDeliveryModelChannels(worker),
  catalog = new PostgresDeliveryModelChannels(app);
const queue = new PostgresJobQueue(worker);
let requests = 0;
const server = createServer(async (request, response) => {
  requests++;
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer isolated-runtime-key');
  let content = '';
  for await (const chunk of request) content += chunk;
  const body = JSON.parse(content);
  assert.equal(body.model, 'runtime-model');
  assert(!content.includes('isolated-runtime-key'));
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      choices: [{ message: { content: 'runtime-ok' }, finish_reason: 'stop' }],
      usage: { total_tokens: 7 },
    }),
  );
});
const runScript = (path: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path], {
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(path + ' failed: ' + output)),
    );
  });
try {
  await runScript('scripts/db-bootstrap.ts');
  await runScript('scripts/db-migrate.ts');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('模型替身启动失败');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const session = await collab.createSession({
    login: {
      providerId: 'isolated-models',
      subject: '张三',
      displayName: '张三',
      canCreateWorkspace: true,
    },
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    encryptedCredential: 'isolated-only',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const workspace = await collab.createWorkspace(
    session.identity.id,
    '模型路由隔离测试',
    randomUUID(),
  );
  const scope = { workspaceId: workspace.id, actorId: session.identity.id };
  const project = await new PostgresProjectsRepository(app).bind(
    scope,
    'isolated-models',
    '1',
  );
  const channel = await work.execute(session, workspace.id, {
    command: 'save-model-channel',
    name: '运行渠道',
    baseUrl,
    models: ['runtime-model'],
  });
  assert(channel.id);
  assert(channel.version);
  await credentials.save(session, workspace.id, {
    kind: 'model-channel',
    id: channel.id,
    values: { apiKey: 'isolated-runtime-key' },
  });
  const reference = formatDeliveryChannelModel(
    channel.id,
    channel.version,
    'runtime-model',
  );
  const profiles = {
    designer: { model: reference, instructions: '' },
    architect: { model: reference, instructions: '' },
    engineer: { model: reference, instructions: '' },
  };
  await delivery.setProfiles(scope, profiles);
  const publicChannels = await catalog.available(scope);
  assert.equal(publicChannels[0]?.configured, true);
  assert(!JSON.stringify(publicChannels).includes('isolated-runtime-key'));
  assert(!JSON.stringify(publicChannels).includes('baseUrl'));
  const run = await delivery.start(session, {
    workspaceId: workspace.id,
    projectId: project.id,
    goal: '验证渠道运行',
    acceptance: '授权、版本、租约、真实HTTP请求一致',
    mode: 'demo',
    budgetCalls: 5,
    budgetTokens: 20000,
    maxRevisions: 1,
    requestId: randomUUID(),
  });
  const workerId = randomUUID(),
    job = await queue.claim(workerId, 30000);
  assert(job);
  assert.equal(job.reference, run.id);
  const fence = { job, workerId };
  assert(
    await workerDelivery.checkpoint(fence, {
      status: 'running',
      event: { kind: 'profiles_bound', summary: '固定模型引用' },
      document: {
        kind: 'profiles',
        role: 'architect',
        content: JSON.stringify(profiles),
      },
    }),
  );
  const resolved = await source.resolve(fence, reference);
  assert.equal(resolved.workspaceId, workspace.id);
  assert.equal(resolved.channel.id, channel.id);
  assert(resolved.encryptedValues);
  assert(!resolved.encryptedValues.includes('isolated-runtime-key'));
  await assert.rejects(
    source.resolve({ ...fence, job: { ...job, token: '999999' } }, reference),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    worker.query('SELECT encrypted_values FROM tandem.wm_credentials'),
    { code: '42501' },
  );
  const routed = new RoutedDeliveryModel({
    fallback: new CompatibleDeliveryModel({}),
    models: [reference, reference, reference],
    resolve: (ref) => source.resolve(fence, ref),
    open: (value, context) => codec.open(value, context),
  });
  assert.equal(routed.configured, true);
  const output = await routed.generate({
    model: reference,
    system: 'test system',
    prompt: 'test prompt',
    maxTokens: 128,
    signal: new AbortController().signal,
  });
  assert.equal(output.text, 'runtime-ok');
  assert.equal(output.totalTokens, 7);
  assert.equal(requests, 1);
  const unbound = await work.execute(session, workspace.id, {
    command: 'save-model-channel',
    name: '未绑定渠道',
    baseUrl,
    models: ['runtime-model'],
    protocol: 'ollama',
  });
  await assert.rejects(
    source.resolve(
      fence,
      formatDeliveryChannelModel(
        unbound.id!,
        unbound.version!,
        'runtime-model',
      ),
    ),
    { code: 'FORBIDDEN' },
  );
  const other = await collab.createWorkspace(
    session.identity.id,
    '模型隔离空间',
    randomUUID(),
  );
  const foreign = await work.execute(session, other.id, {
    command: 'save-model-channel',
    name: '其他空间',
    baseUrl,
    models: ['runtime-model'],
    protocol: 'ollama',
  });
  const foreignRef = formatDeliveryChannelModel(
    foreign.id!,
    foreign.version!,
    'runtime-model',
  );
  await assert.rejects(
    delivery.setProfiles(scope, {
      ...profiles,
      designer: { model: foreignRef, instructions: '' },
    }),
  );
  await assert.rejects(source.resolve(fence, foreignRef), {
    code: 'FORBIDDEN',
  });
  const latest = await work.snapshot(session, workspace.id);
  const current = latest.modelChannels.find((item) => item.id === channel.id);
  assert(current);
  const changed = await work.execute(session, workspace.id, {
    command: 'save-model-channel',
    ...current,
    name: '已修改渠道',
  });
  await assert.rejects(
    routed.generate({
      model: reference,
      system: 'test',
      prompt: 'test',
      maxTokens: 128,
      signal: new AbortController().signal,
    }),
    { code: 'UNAVAILABLE' },
  );
  assert.equal(requests, 1);
  const newRef = formatDeliveryChannelModel(
    channel.id,
    changed.version!,
    'runtime-model',
  );
  await assert.rejects(source.resolve(fence, newRef), { code: 'FORBIDDEN' });
  await delivery.control(scope, run.id, 'pause', session.id);
  await assert.rejects(source.resolve(fence, reference), { code: 'FORBIDDEN' });
  console.log(
    '模型渠道集成通过：界面配置→加密key→固定T组profile→受租约与授权约束的Worker解析→真实本机HTTP替身调用；跨空间、未绑定渠道、过期租约、渠道版本变更及暂停均阻止调用。未调用用户真实模型服务。',
  );
} finally {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.end();
  await worker.end();
  await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await admin.end();
}
