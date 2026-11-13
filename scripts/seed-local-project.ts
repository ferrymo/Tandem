import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const origin = new URL(
  process.env.TANDEM_IDENTITY_URL ?? 'http://127.0.0.1:8088',
);
assert(
  ['localhost', '127.0.0.1'].includes(origin.hostname),
  '验收数据仅允许写入本机协作系统',
);
assert(
  process.env.ZT_ACC && process.env.ZT_PWD,
  '请通过被忽略的.env.zentao.local注入验收账号',
);
const endpoint = origin.href.replace(/\/$/, '') + '/api.php/v1';
const tokenResponse = await fetch(endpoint + '/tokens', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    account: process.env.ZT_ACC,
    password: process.env.ZT_PWD,
  }),
});
assert(tokenResponse.ok, '本地验收账号登录失败');
const { token } = (await tokenResponse.json()) as { token: string };
async function request(path: string, input?: unknown) {
  const response = await fetch(endpoint + path, {
    method: input ? 'POST' : 'GET',
    headers: { Token: token, 'Content-Type': 'application/json' },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      `本地验收准备失败 HTTP ${response.status}: ${JSON.stringify(data)}`,
    );
  return data;
}
let projectId: string | undefined;
try {
  projectId = (
    JSON.parse(await readFile('data/acceptance/project.json', 'utf8')) as {
      projectId: string;
    }
  ).projectId;
  const existing = (await request('/projects/' + projectId)) as {
    executionID?: number | string;
  };
  if (existing.executionID) projectId = undefined;
} catch {
  projectId = undefined;
}
if (!projectId) {
  const begin = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const project = (await request('/projects', {
    name: 'Tandem 产品迭代验收',
    begin,
    end,
    products: [],
    multiple: 'on',
    model: 'scrum',
    acl: 'private',
    PM: process.env.ZT_ACC,
    code: 'tandem-acceptance-' + Date.now(),
  })) as { id: number | string };
  assert(project.id, '本地协作系统未返回项目ID');
  projectId = String(project.id);
  await mkdir('data/acceptance', { recursive: true });
  await writeFile(
    'data/acceptance/project.json',
    JSON.stringify({ projectId, createdAt: new Date().toISOString() }, null, 2),
  );
}
const project = (await request('/projects/' + projectId)) as {
  name: string;
  executionID: number | string;
};
const executions = (await request(
  `/projects/${projectId}/executions?status=all`,
)) as { executions: { id: number | string }[] };
let executionId = executions.executions[0]?.id;
if (!executionId) {
  const begin = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const execution = (await request(`/projects/${projectId}/executions`, {
    project: projectId,
    name: 'Tandem 验收迭代',
    begin,
    end,
    products: [],
    teamMembers: [process.env.ZT_ACC],
    PM: process.env.ZT_ACC,
    acl: 'private',
    code: 'tandem-acceptance-sprint-' + Date.now(),
  })) as { id: number | string };
  executionId = execution.id;
}
console.log(
  JSON.stringify({
    projectId,
    name: project.name,
    executionId,
  }),
);
