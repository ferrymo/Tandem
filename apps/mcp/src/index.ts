import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from '@tandem/platform';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
const logger = createLogger('mcp');
const server = new McpServer(
  { name: 'tandem', version: '0.1.0' },
  { capabilities: { tools: {} } },
);
const address = new URL(
  process.env.TANDEM_MCP_BASE_URL ??
    process.env.TANDEM_PUBLIC_URL ??
    'http://127.0.0.1:3000',
);
if (
  address.username ||
  address.password ||
  address.search ||
  address.hash ||
  address.pathname !== '/' ||
  !(
    address.protocol === 'https:' ||
    (address.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))
  )
)
  throw new Error('Tandem MCP 需要 HTTPS 或本机 HTTP 服务地址');
let cookie: string | null = null;
let authentication: Promise<void> | null = null;
async function authenticate() {
  if (cookie) return;
  if (!authentication)
    authentication = (async () => {
      const account = process.env.TANDEM_MCP_ACCOUNT;
      const password = process.env.TANDEM_MCP_PASSWORD;
      if (!account || !password)
        throw new Error(
          '请通过 MCP 客户端的私密环境配置 TANDEM_MCP_ACCOUNT 和 TANDEM_MCP_PASSWORD',
        );
      const response = await fetch(new URL('/api/session', address), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: address.origin },
        body: JSON.stringify({ account, password }),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new Error('协作账号认证失败，请在产品登录页核对账号与连接状态');
      const session = response.headers
        .getSetCookie()
        .find((value) => /^(?:__Host-)?tandem_session=/.test(value));
      if (!session) throw new Error('主服务未返回有效会话');
      cookie = session.split(';')[0]!;
    })();
  await authentication;
}
async function api(path: string, input?: unknown) {
  await authenticate();
  const response = await fetch(new URL(path, address), {
    method: input ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Origin: address.origin,
      Cookie: cookie!,
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(45000),
  });
  const data = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message ?? 'Tandem 请求失败');
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}
async function result(work: () => ReturnType<typeof api>) {
  try {
    return await work();
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error instanceof Error ? error.message : 'Tandem 服务暂不可用',
        },
      ],
    };
  }
}
const workspaceId = z.uuid();
const projectId = z.uuid();
const resource = (
  space: string,
  name: string,
  params: Record<string, string> = {},
) =>
  `/api/workspaces/${space}/product?` +
  new URLSearchParams({ resource: name, ...params });
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};
server.registerTool(
  'tandem_workspaces',
  {
    description: '列出当前协作账号的工作空间，不扩大下游权限。',
    inputSchema: {},
    annotations: readOnly,
  },
  () => result(() => api('/api/workspaces')),
);
server.registerTool(
  'tandem_projects',
  {
    description: '读取工作空间内当前账号有权访问的项目。',
    inputSchema: { workspaceId },
    annotations: readOnly,
  },
  (input) => result(() => api(resource(input.workspaceId, 'projects'))),
);
server.registerTool(
  'tandem_executions',
  {
    description: '读取已授权项目的执行范围，用于选择任务上下文。',
    inputSchema: { workspaceId, projectId },
    annotations: readOnly,
  },
  (input) =>
    result(() =>
      api(
        resource(input.workspaceId, 'executions', { project: input.projectId }),
      ),
    ),
);
server.registerTool(
  'tandem_tasks',
  {
    description: '读取任务列表或单个任务与协作线程。',
    inputSchema: {
      workspaceId,
      projectId,
      executionId: z.string().regex(/^[1-9]\d*$/),
      taskId: z
        .string()
        .regex(/^[1-9]\d*$/)
        .optional(),
      page: z.number().int().positive().default(1),
    },
    annotations: readOnly,
  },
  (input) =>
    result(() =>
      api(
        resource(input.workspaceId, input.taskId ? 'task' : 'tasks', {
          project: input.projectId,
          execution: input.executionId,
          page: String(input.page),
          ...(input.taskId ? { task: input.taskId } : {}),
        }),
      ),
    ),
);
server.registerTool(
  'tandem_runs',
  {
    description: '查看当前项目的T组运行、阶段、预算和交付证据。',
    inputSchema: { workspaceId, projectId, runId: z.uuid().optional() },
    annotations: readOnly,
  },
  (input) =>
    result(() =>
      api(
        resource(input.workspaceId, input.runId ? 'run' : 'runs', {
          project: input.projectId,
          ...(input.runId ? { run: input.runId } : {}),
        }),
      ),
    ),
);
server.registerTool(
  'tandem_drafts',
  {
    description: '读取项目草案及执行回执。批准操作须由人在产品中完成。',
    inputSchema: { workspaceId, projectId },
    annotations: readOnly,
  },
  (input) =>
    result(() =>
      api(resource(input.workspaceId, 'drafts', { project: input.projectId })),
    ),
);
server.registerTool(
  'tandem_propose_task_change',
  {
    description:
      '提交任务创建、修改、状态或工时草案；不写入外部系统。人须在Tandem中审阅批准当前版本，随后以原账号执行。action必须符合产品API的任务动作契约。',
    inputSchema: {
      workspaceId,
      projectId,
      title: z.string().min(1).max(200),
      action: z.record(z.string(), z.unknown()),
      requestId: z.uuid().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  (input) =>
    result(() => {
      if (
        !['task.create', 'task.update', 'task.status', 'task.effort'].includes(
          String(input.action.kind),
        )
      )
        throw new Error(
          '此工具仅接受任务草案，不接受批准、任意工具调用或部署执行',
        );
      return api(resource(input.workspaceId, 'command'), {
        command: 'create-draft',
        projectId: input.projectId,
        title: input.title,
        action: input.action,
        requestId: input.requestId ?? randomUUID(),
      });
    }),
);
const transport = new StdioServerTransport();
await server.connect(transport);
const stop = async () => {
  if (cookie)
    await fetch(new URL('/api/session', address), {
      method: 'DELETE',
      headers: { Cookie: cookie, Origin: address.origin },
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  await server.close();
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
logger.info('MCP stdio 就绪；任务写入仅创建待人工审阅草案');
