import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Local external-system fixture: discovery is read-only; only write_note writes data. */
export async function startLocalMcpFixture() {
  const directory = resolve('data/acceptance');
  await mkdir(directory, { recursive: true });
  const calls: string[] = [];
  const notes: { key: string; note: string }[] = [];
  const tools = [
    {
      name: 'echo',
      description: 'Read-only acceptance echo; never writes data.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 1000 } },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'write_note',
      description: 'Write an acceptance note under data/acceptance only.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' },
          note: { type: 'string', minLength: 1, maxLength: 1000 },
        },
        required: ['key', 'note'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
  ];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ ready: true, calls, notes: notes.length }));
      return;
    }
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += String(chunk);
        assert(raw.length < 65536, 'request too large');
      }
      const message = JSON.parse(raw) as {
        id?: string | number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      calls.push(message.method);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'tandem-local-acceptance', version: '1.0.0' },
          capabilities: { tools: {} },
        };
      else if (message.method === 'tools/list') result = { tools };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/call') {
        const args = message.params?.arguments ?? {};
        if (message.params?.name === 'echo') {
          assert.equal(typeof args.text, 'string');
          result = { content: [{ type: 'text', text: `echo: ${args.text}` }] };
        } else if (message.params?.name === 'write_note') {
          assert.equal(typeof args.key, 'string');
          assert.match(args.key as string, /^[a-zA-Z0-9_-]{1,100}$/);
          assert.equal(typeof args.note, 'string');
          const note = { key: args.key as string, note: args.note as string };
          if (!notes.some((n) => n.key === note.key)) {
            await appendFile(
              resolve(directory, 'mcp-notes.jsonl'),
              JSON.stringify({ ...note, createdAt: new Date().toISOString() }) +
                '\n',
              'utf8',
            );
            notes.push(note);
          }
          result = { content: [{ type: 'text', text: `saved: ${note.key}` }] };
        } else throw new Error('unknown tool');
      } else throw new Error('unknown method');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch {
      response.writeHead(400).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32602, message: 'Invalid acceptance request' },
        }),
      );
    }
  });
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(4399, '127.0.0.1', yes);
  });
  return {
    calls,
    notes,
    close: () =>
      new Promise<void>((yes, no) => server.close((e) => (e ? no(e) : yes()))),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await startLocalMcpFixture();
  console.log('Local acceptance MCP listening on http://127.0.0.1:4399/mcp');
}
