import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DockerDeliveryExecution } from '../adapters/execution/src/index';
import type { DeliveryPackage } from '../packages/core/src/index';
const execution = new DockerDeliveryExecution({
  root: resolve('data/execution-smoke', randomUUID()),
  image:
    process.env.EXECUTION_IMAGE ??
    'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',
});
const projectId = randomUUID();
const runId = randomUUID();
const signal = new AbortController().signal;
const pkg = (label: string): DeliveryPackage => ({
  files: [
    {
      path: 'index.html',
      content: `<!doctype html><html lang="zh"><title>${label}</title><body><h1>${label}</h1></body></html>`,
    },
    {
      path: 'domain.mjs',
      content:
        'export function total(items){if(!Array.isArray(items)||items.some(n=>typeof n!=="number"||n<0))throw new Error("invalid");return items.reduce((a,b)=>a+b,0)}',
    },
    {
      path: 'domain.test.mjs',
      content: `import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {networkInterfaces} from 'node:os';import {total} from './domain.mjs';test('业务计算与错误边界',()=>{assert.equal(total([1,2,3]),6);assert.equal(total([]),0);assert.throws(()=>total([-1]));});test('执行隔离',()=>{assert.notEqual(process.getuid(),0);assert.equal(process.env.WORKER_DATABASE_URL,undefined);assert.equal(process.env.MODEL_API_KEY,undefined);assert.equal(existsSync('/var/run/docker.sock'),false);assert.equal(Object.keys(networkInterfaces()).some(n=>n!=='lo'),false)});`,
    },
  ],
  testCommands: [['node', '--test', 'domain.test.mjs']],
  buildCommands: [['node', '--check', 'domain.mjs']],
  previewPath: 'index.html',
  summary: label,
  limitations: ['仅供本地静态演示验收'],
});
const first = await execution.verify({
  runId,
  revision: 0,
  package: pkg('版本一'),
  signal,
});
if (!first.passed) console.error(first.commands);
assert.equal(first.passed, true);
assert.equal(
  (await execution.read(first.artifactRef, 'index.html')).contentType,
  'text/html; charset=utf-8',
);
await assert.rejects(execution.read(first.artifactRef, '../secret'));
await assert.rejects(
  execution.verify({
    runId,
    revision: 0,
    package: {
      ...pkg('非法'),
      files: [
        { path: '../escape', content: 'no' },
        { path: 'index.html', content: 'x' },
      ],
    },
    signal,
  }),
);
const deploy1 = await execution.deploy({
  runId,
  projectId,
  artifact: first,
  approvalId: randomUUID(),
  signal,
});
assert.equal(deploy1.status, 'healthy');
const second = await execution.verify({
  runId: randomUUID(),
  revision: 1,
  package: pkg('版本二'),
  signal,
});
assert.equal(second.passed, true);
const approvalId = randomUUID();
const deploy2 = await execution.deploy({
  runId,
  projectId,
  artifact: second,
  approvalId,
  signal,
});
assert.equal(deploy2.previousDeploymentId, deploy1.id);
assert.equal(
  (
    await execution.deploy({
      runId,
      projectId,
      artifact: second,
      approvalId,
      signal,
    })
  ).id,
  deploy2.id,
);
const rollbackApproval = randomUUID();
const rolled = await execution.rollback({
  runId,
  projectId,
  deploymentId: deploy2.id,
  approvalId: rollbackApproval,
  signal,
});
assert.equal(rolled.status, 'rolled_back');
assert.equal(
  (
    await execution.rollback({
      runId,
      projectId,
      deploymentId: deploy2.id,
      approvalId: rollbackApproval,
      signal,
    })
  ).id,
  rolled.id,
);
assert.equal(
  (await execution.inspectDeployment(projectId, rolled.id, signal)).healthy,
  true,
);
assert.equal(
  (await execution.inspectDeployment(projectId, randomUUID(), signal)).receipt,
  null,
);
const removed = await execution.verify({
  runId: randomUUID(),
  revision: 0,
  package: {
    ...pkg('删除入口测试'),
    buildCommands: [['node', '-e', "require('fs').unlinkSync('index.html')"]],
  },
  signal,
});
assert.equal(removed.passed, false);
assert.match(
  Buffer.from(
    (await execution.deploymentFile(rolled.id, 'index.html')).bytes,
  ).toString(),
  /版本一/,
);
console.log(
  '执行器真实验收通过：非root、无网络/宿主socket/模型与数据库凭证；构建后行为测试与入口校验；产物摘要；真实HTTP部署健康与核对；跨运行版本回滚；发布/回滚审批幂等；路径穿越拒绝。',
);
