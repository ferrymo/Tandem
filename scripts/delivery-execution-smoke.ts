import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  deliveryPreviewIssues,
  DockerDeliveryExecution,
} from '../adapters/execution/src/index';
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
      // Source may be modular; only the post-build preview must be standalone.
      content: `<!doctype html><html lang="zh"><title>${label}</title><body><h1>${label}</h1><script type="module" src="./domain.mjs"></script></body></html>`,
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
    {
      path: 'build.mjs',
      content: `import {readFileSync,writeFileSync} from 'node:fs';
const domain=readFileSync('domain.mjs','utf8').replaceAll('export function','function');
const html=${JSON.stringify(`<!doctype html><html lang="zh"><title>${label}</title><style>body{font-family:system-ui}</style><body><h1>${label}</h1><button id="calculate">计算</button><output id="result"></output><script>__DOMAIN__;document.querySelector('#calculate').addEventListener('click',()=>{document.querySelector('#result').textContent=String(total([1,2,3]))});</script></body></html>`)};
writeFileSync('index.html',html.replace('__DOMAIN__',domain));`,
    },
  ],
  testCommands: [['node', '--test', 'domain.test.mjs']],
  buildCommands: [['node', 'build.mjs']],
  previewPath: 'index.html',
  summary: label,
  limitations: ['仅供本地静态演示验收'],
});
assert.notEqual(
  deliveryPreviewIssues(pkg('源码入口').files[0]!.content).length,
  0,
);
const first = await execution.verify({
  runId,
  revision: 0,
  package: pkg('版本一'),
  signal,
});
if (!first.passed) console.error(first.commands);
assert.equal(first.passed, true);
assert.deepEqual(first.execution, {
  kind: 'docker',
  image:
    process.env.EXECUTION_IMAGE ??
    'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',
  network: 'none',
  user: '1000:1000',
  browserValidation: 'not_performed',
});
assert.deepEqual(first.commands.at(-1)?.command, [
  'verify-preview',
  'index.html',
]);
const builtEntry = Buffer.from(
  (await execution.read(first.artifactRef, 'index.html')).bytes,
).toString();
assert.deepEqual(deliveryPreviewIssues(builtEntry), []);
assert.match(builtEntry, /function total\(items\)/);
assert.doesNotMatch(builtEntry, /type="module"|src="\.\/domain/);
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
const generatedEntry = pkg('版本二');
const buildOnlyEntry = {
  ...generatedEntry,
  files: generatedEntry.files.filter(
    (file) => file.path !== generatedEntry.previewPath,
  ),
};
assert.equal(
  buildOnlyEntry.files.some((file) => file.path === buildOnlyEntry.previewPath),
  false,
);
const second = await execution.verify({
  runId: randomUUID(),
  revision: 1,
  package: buildOnlyEntry,
  signal,
});
assert.equal(second.passed, true);
assert.equal(
  second.files.some((file) => file.path === buildOnlyEntry.previewPath),
  true,
);
await assert.rejects(
  execution.verify({
    runId: randomUUID(),
    revision: 0,
    package: { ...buildOnlyEntry, buildCommands: [] },
    signal,
  }),
  (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'INVALID_INPUT',
);
await assert.rejects(
  execution.verify({
    runId: randomUUID(),
    revision: 0,
    package: { ...buildOnlyEntry, previewPath: '.tandem-skills/preview.html' },
    signal,
  }),
  (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'INVALID_INPUT',
);
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
assert.match(removed.commands.at(-1)!.output, /入口不存在或为空/);
const missingEntry = await execution.verify({
  runId: randomUUID(),
  revision: 0,
  package: {
    ...buildOnlyEntry,
    buildCommands: [['node', '-e', 'process.stdout.write("build ok")']],
  },
  signal,
});
assert.equal(missingEntry.passed, false);
assert.equal(
  missingEntry.commands.slice(0, -1).every((command) => command.exitCode === 0),
  true,
);
assert.deepEqual(missingEntry.commands.at(-1)?.command, [
  'verify-preview',
  'index.html',
]);
assert.match(missingEntry.commands.at(-1)!.output, /入口不存在或为空/);
const brokenPreview = await execution.verify({
  runId: randomUUID(),
  revision: 0,
  package: {
    ...pkg('构建后不支持的入口'),
    buildCommands: [
      ['node', 'build.mjs'],
      [
        'node',
        '-e',
        'require("fs").appendFileSync("index.html", "<script type=module src=./domain.mjs></script>")',
      ],
    ],
  },
  signal,
});
assert.equal(brokenPreview.passed, false);
assert.equal(
  brokenPreview.commands
    .slice(0, -1)
    .every((command) => command.exitCode === 0),
  true,
);
assert.deepEqual(brokenPreview.commands.at(-1)?.command, [
  'verify-preview',
  'index.html',
]);
assert.match(brokenPreview.commands.at(-1)!.output, /外链script|模块/);
assert.match(
  Buffer.from(
    (await execution.deploymentFile(rolled.id, 'index.html')).bytes,
  ).toString(),
  /版本一/,
);
console.log(
  '执行器真实验收通过：非root、无网络/宿主socket/模型与数据库凭证；共享模块行为测试、构建生成/内联入口及最终预览静态契约，构建未生成入口或引入不兼容资源明确失败；无构建缺入口及保留入口路径拒绝；产物摘要；真实HTTP部署健康与核对；跨运行版本回滚；发布/回滚审批幂等；路径穿越拒绝。静态契约不替代真实浏览器交互验收。',
);
