import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { DomainError } from '@tandem/core';
import type { McpConnection, McpTool, McpTransportPort } from '@tandem/core';

const exec = promisify(execFile);
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ':' +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}
function toolHash(tool: Pick<McpTool, 'name' | 'inputSchema'>) {
  return createHash('sha256')
    .update(canonical({ name: tool.name, inputSchema: tool.inputSchema }))
    .digest('hex');
}

export class SdkMcpTransport implements McpTransportPort {
  private readonly validator = new AjvJsonSchemaValidator();
  constructor(
    private readonly options: {
      allowedOrigins: string[];
      allowedImages: string[];
    },
  ) {}
  private allowedUrl(raw: string) {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !this.options.allowedOrigins.includes(url.origin) ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new DomainError(
        'FORBIDDEN',
        'MCP 地址未在部署允许来源中，或包含不安全配置',
      );
    return url;
  }
  private async client<T>(
    connection: McpConnection,
    credential: string | null,
    signal: AbortSignal,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    const client = new Client({ name: 'tandem', version: '0.1.0' });
    let container: string | null = null;
    try {
      if (connection.type === 'http') {
        const url = this.allowedUrl(connection.url);
        const transport = new StreamableHTTPClientTransport(url, {
          redirectPolicy: 'same-origin',
          reconnectionOptions: {
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 0,
          },
          requestInit: {
            redirect: 'error',
            headers: credential
              ? { Authorization: 'Bearer ' + credential }
              : {},
          },
          fetch: async (input, init) => {
            const target = new URL(
              input instanceof Request ? input.url : input.toString(),
            );
            this.allowedUrl(target.href);
            if (target.origin !== url.origin)
              throw new DomainError('FORBIDDEN', '禁止 MCP 请求离开配置来源');
            const response = await fetch(input, {
              ...init,
              redirect: 'error',
              signal: boundedSignal,
            });
            const declared = Number(response.headers.get('content-length'));
            if (declared > 1024 * 1024) {
              await response.body?.cancel();
              throw new DomainError('INVALID_INPUT', 'MCP 响应过大');
            }
            if (!response.body) return response;
            let bytes = 0;
            const body = response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  bytes += chunk.byteLength;
                  if (bytes > 1024 * 1024)
                    throw new DomainError(
                      'INVALID_INPUT',
                      'MCP 响应超过 1 MiB',
                    );
                  controller.enqueue(chunk);
                },
              }),
            );
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          },
        });
        await client.connect(transport, {
          signal: boundedSignal,
          timeout: 15000,
        });
      } else {
        if (
          !this.options.allowedImages.includes(connection.image) ||
          !/(?:^sha256:[a-f0-9]{64}$|@sha256:[a-f0-9]{64}$)/.test(
            connection.image,
          )
        )
          throw new DomainError(
            'FORBIDDEN',
            'stdio MCP 只能运行部署允许且固定摘要的隔离镜像',
          );
        if (
          !connection.command.length ||
          connection.command.some((v) => !v || v.includes('\u0000'))
        )
          throw new DomainError('INVALID_INPUT', 'MCP 容器内命令无效');
        container = 'tandem-mcp-' + randomUUID();
        const args = [
          'run',
          '--rm',
          '-i',
          '--name',
          container,
          '--pull',
          'never',
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--user',
          '65534:65534',
          '--memory',
          '256m',
          '--cpus',
          '0.5',
          '--pids-limit',
          '64',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,nodev,size=32m',
        ];
        if (credential) args.push('-e', 'TANDEM_MCP_TOKEN');
        args.push(connection.image, ...connection.command);
        const transport = new StdioClientTransport({
          command: 'docker',
          args,
          env: credential ? { TANDEM_MCP_TOKEN: credential } : {},
          stderr: 'ignore',
          maxBufferSize: 1024 * 1024,
        });
        await client.connect(transport, {
          signal: boundedSignal,
          timeout: 15000,
        });
      }
      return await action(client);
    } finally {
      await client.close().catch(() => undefined);
      if (container)
        await exec('docker', ['rm', '--force', container], {
          timeout: 5000,
          windowsHide: true,
          maxBuffer: 4096,
        }).catch(() => undefined);
    }
  }
  private async tools(client: Client, signal: AbortSignal) {
    const all: McpTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: 15000,
      });
      for (const entry of page.tools) {
        const tool = {
          name: entry.name,
          description: entry.description ?? '',
          inputSchema: entry.inputSchema,
          schemaHash: '',
        };
        all.push({ ...tool, schemaHash: toolHash(tool) });
      }
      if (all.length > 128 || (page.nextCursor && cursors.has(page.nextCursor)))
        throw new DomainError(
          'INVALID_INPUT',
          'MCP 工具目录超出限制或分页无进展',
        );
      cursor = page.nextCursor;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return all;
  }
  catalog(
    connection: McpConnection,
    credential: string | null,
    signal: AbortSignal,
  ) {
    return this.client(connection, credential, signal, (client) =>
      this.tools(client, signal),
    );
  }
  invoke(
    connection: McpConnection,
    credential: string | null,
    tool: McpTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    return this.client(connection, credential, signal, async (client) => {
      // Re-check the actual authenticated catalog in this very session before side effects.
      const current = (await this.tools(client, signal)).find(
        (t) => t.name === tool.name,
      );
      if (!current || current.schemaHash !== tool.schemaHash)
        throw new DomainError(
          'CONFLICT',
          '实际 MCP 工具定义已改变，请重新测试、授权及审批',
        );
      let valid: boolean;
      try {
        valid = this.validator.getValidator(tool.inputSchema as JsonSchemaType)(
          args,
        ).valid;
      } catch {
        throw new DomainError('INVALID_INPUT', 'MCP 工具参数定义不受支持');
      }
      if (!valid)
        throw new DomainError(
          'INVALID_INPUT',
          'MCP 工具参数不符合已批准的输入定义',
        );
      const result = await client.callTool(
        { name: tool.name, arguments: args },
        undefined,
        { signal, timeout: 30000 },
      );
      if (
        !Array.isArray(result.content) ||
        canonical(result.content).length > 1024 * 1024
      )
        throw new DomainError('UNAVAILABLE', 'MCP 返回数据无效或过大');
      return {
        isError: result.isError === true,
        content: result.content as unknown[],
      };
    });
  }
}
