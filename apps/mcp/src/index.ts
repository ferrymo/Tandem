import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from '@tandem/platform';
const logger = createLogger('mcp');
const server = new McpServer(
  { name: 'tandem', version: '0.1.0' },
  { capabilities: { tools: {} } },
);
// No business tools are exposed until authenticated API use cases exist.
const transport = new StdioServerTransport();
await server.connect(transport);
const stop = async () => {
  await server.close();
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
logger.info('MCP stdio 就绪；业务工具尚未注册');
