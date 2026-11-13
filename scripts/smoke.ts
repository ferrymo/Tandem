import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const base = 'http://127.0.0.1:3000';
for (const [path, status] of [
  ['/api/health/live', 'alive'],
  ['/api/health/ready', 'ready'],
]) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  assert.deepEqual(await response.json(), { status });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
}
const page = await fetch(base);
assert.equal(page.status, 200);
assert.match(await page.text(), /Tandem/);
const client = new Client({ name: 'tandem-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['apps/mcp/dist/index.js'],
  stderr: 'inherit',
  env: { TANDEM_MCP_ACCOUNT: '', TANDEM_MCP_PASSWORD: '' },
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'tandem_workspaces',
      'tandem_projects',
      'tandem_executions',
      'tandem_tasks',
      'tandem_runs',
      'tandem_drafts',
      'tandem_propose_task_change',
    ].sort(),
  );
  assert.equal(
    tools.filter((tool) => tool.annotations?.readOnlyHint === true).length,
    6,
  );
  const unauthenticated = await client.callTool({
    name: 'tandem_workspaces',
    arguments: {},
  });
  assert.equal(unauthenticated.isError, true, '未配置本人账号不得读取数据');
  console.log(
    '冒烟通过：Web/API 单端口、数据库就绪、MCP stdio 七工具契约及未认证拒绝。',
  );
} finally {
  await client.close();
}
