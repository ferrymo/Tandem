import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

assert(
  process.env.ZT_ACC && process.env.ZT_PWD,
  '请用.env.zentao.local注入本人验收账号',
);
const client = new Client({
  name: 'tandem-local-acceptance',
  version: '1.0.0',
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['apps/mcp/dist/index.js'],
  cwd: process.cwd(),
  env: {
    TANDEM_MCP_BASE_URL:
      process.env.TANDEM_PUBLIC_URL ?? 'http://127.0.0.1:3000',
    TANDEM_MCP_ACCOUNT: process.env.ZT_ACC,
    TANDEM_MCP_PASSWORD: process.env.ZT_PWD,
  },
  stderr: 'ignore',
});
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, 7);
  assert(
    !catalog.tools.some((tool) => /approve|execute|deploy/.test(tool.name)),
    '对外MCP不可提供自动审批或直接执行工具',
  );
  const workspaces = await client.callTool({
    name: 'tandem_workspaces',
    arguments: {},
  });
  assert(!workspaces.isError);
  const content = workspaces.content as { type: string; text?: string }[];
  const parsed = JSON.parse(
    content.find((item) => item.type === 'text')!.text!,
  ) as { workspaces: { id: string }[] };
  assert(parsed.workspaces.length > 0, '请先在产品中创建工作空间');
  const result = await client.callTool({
    name: 'tandem_projects',
    arguments: { workspaceId: parsed.workspaces[0]!.id },
  });
  assert(!result.isError);
  console.log(
    '对外 MCP stdio：本人账号认证、7个工具发现、工作空间与项目读取通过；未产生业务写入。',
  );
} finally {
  await client.close();
}
