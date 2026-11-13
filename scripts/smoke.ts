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
});
try {
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools, []);
  console.log(
    '冒烟通过：Web/API 单端口、数据库就绪、MCP stdio 握手及空工具目录。',
  );
} finally {
  await client.close();
}
