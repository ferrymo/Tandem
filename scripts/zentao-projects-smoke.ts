import assert from 'node:assert/strict';
import {
  ZentaoIdentityProvider,
  ZentaoProjectSystem,
} from '../adapters/zentao/src/index.js';

// Read-only, actual-user acceptance against the explicitly configured local fixture.
const url = new URL(process.env.TANDEM_IDENTITY_URL ?? '');
assert(
  url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash,
  '此验收只读取可信本机实例',
);
const provider = new ZentaoIdentityProvider({
  id: 'zentao-local-acceptance',
  label: '本地禅道验收',
  baseUrl: url.href,
  allowInsecureHttp: true,
  commanderAccounts: [],
});
assert(
  process.env.ZT_ACC && process.env.ZT_PWD,
  '请配置被忽略的 .env.zentao.local',
);
const login = await provider.authenticate(
  process.env.ZT_ACC,
  process.env.ZT_PWD,
);
const upstream = new ZentaoProjectSystem({
  connectionId: login.providerId,
  baseUrl: url.href,
  allowInsecureHttp: true,
  accessToken: login.accessToken,
  subject: login.subject,
});
const available = await upstream.projects();
const projectId = process.argv[2] ?? process.env.TANDEM_ACCEPTANCE_PROJECT_ID;
if (!projectId) {
  console.log(
    JSON.stringify({
      projects: available.items.length,
      total: available.total,
      readOnly: true,
      detail: '提供项目ID后验证执行、任务与权限',
    }),
  );
} else {
  const project = await upstream.project(projectId);
  assert.equal(project.id, projectId);
  const permission = await upstream.readAccessKey(projectId);
  assert.match(permission, /^[a-f0-9]{64}$/);
  const executions = await upstream.executions(projectId);
  let tasks = 0;
  let details = 0;
  for (const execution of executions) {
    assert.equal(execution.projectId, projectId);
    await upstream.readAccessKey(projectId, execution.id);
    const list = await upstream.tasks(projectId, execution.id);
    tasks += list.items.length;
    for (const task of list.items.slice(0, 3)) {
      const detail = await upstream.task(projectId, task.id);
      assert.equal(detail.projectId, projectId);
      assert.equal(detail.executionId, execution.id);
      assert.match(detail.version, /^[a-f0-9]{64}$/);
      details++;
    }
  }
  console.log(
    JSON.stringify({
      projectId,
      executions: executions.length,
      tasksRead: tasks,
      detailsVerified: details,
      readOnly: true,
      authorization: '实际账号的项目、执行、任务与权限读取通过',
    }),
  );
}
