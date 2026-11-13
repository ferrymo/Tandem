import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const prefix = ['compose', '-f', 'compose.yaml', '-f', 'compose.app.yaml'];
function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
const id = (service) => docker([...prefix, 'ps', '-q', service]);
const started = (service) =>
  docker(['inspect', '--format', '{{.State.StartedAt}}', id(service)]);
async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:3000/api/health/ready')).ok) return;
    } catch {
      /* startup */
    }
    await sleep(500);
  }
  throw new Error('主服务未恢复就绪');
}
const worker = started('worker');
docker([...prefix, 'restart', 'web']);
await ready();
assert.equal(started('worker'), worker);
const web = started('web');
docker([...prefix, 'restart', 'worker']);
await ready();
assert.equal(started('web'), web);
docker([
  ...prefix,
  'exec',
  '-T',
  'worker',
  'node',
  'scripts/worker-health.mjs',
]);
assert.equal(
  docker([
    'inspect',
    '--format',
    '{{json .NetworkSettings.Ports}}',
    id('worker'),
  ]),
  '{}',
);
console.log(
  '容器验证通过：Web/API 单端口、Worker 无端口、两类进程独立重启及 Worker 数据库心跳。',
);
