import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProtocolModelConnection } from '../../adapters/model/src/connection';
import { WorkCredentialsService } from '../../packages/application/src/work-secrets';
import { createSessionCodec } from '../../packages/platform/src/session-crypto';
import type {
  StoredSession,
  WorkCredentialRepository,
  WorkModelChannel,
} from '../../packages/core/src/index';

const channel: WorkModelChannel = {
  id: randomUUID(),
  version: 1,
  name: '协议验证',
  baseUrl: '',
  protocol: 'openai',
  models: ['test-model'],
  credentialRef: '',
  enabled: true,
};

async function endpoint(
  response: unknown,
  work: (
    baseUrl: string,
    received: {
      path?: string;
      headers?: Record<string, string | string[] | undefined>;
      payload?: unknown;
    },
  ) => Promise<void>,
  status = 200,
) {
  const received: {
    path?: string;
    headers?: Record<string, string | string[] | undefined>;
    payload?: unknown;
  } = {};
  const server = createServer(async (request, reply) => {
    received.path = request.url ?? '';
    received.headers = request.headers;
    let payload = '';
    for await (const chunk of request) payload += chunk;
    received.payload = JSON.parse(payload);
    reply.writeHead(status, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('测试服务启动失败');
  try {
    await work(`http://127.0.0.1:${address.port}`, received);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('模型渠道实际HTTP协议验证（隔离替身）', () => {
  it.each([
    {
      protocol: 'openai' as const,
      response: { choices: [{ message: { content: 'OK' } }] },
      path: '/v1/chat/completions',
      base: '/v1',
      header: 'authorization',
      value: 'Bearer test-private-key',
    },
    {
      protocol: 'anthropic' as const,
      response: { content: [{ type: 'text', text: 'OK' }] },
      path: '/v1/messages',
      base: '/v1',
      header: 'x-api-key',
      value: 'test-private-key',
    },
    {
      protocol: 'ollama' as const,
      response: { message: { content: 'OK' } },
      path: '/api/chat',
      base: '',
      header: 'authorization',
      value: 'Bearer test-private-key',
    },
  ])('使用 $protocol 正确端点与认证且不返回凭证或模型原文', async (fixture) => {
    await endpoint(fixture.response, async (base, received) => {
      const result = await new ProtocolModelConnection().test(
        {
          ...channel,
          protocol: fixture.protocol,
          baseUrl: base + fixture.base,
        },
        'test-private-key',
        'test-model',
      );
      expect(received.path).toBe(fixture.path);
      expect(received.headers?.[fixture.header]).toBe(fixture.value);
      expect(received.payload).toMatchObject({ model: 'test-model' });
      const messages = (
        received.payload as { messages: { role: string; content: string }[] }
      ).messages;
      expect(messages.at(-1)).toEqual({
        role: 'user',
        content: 'Reply with OK.',
      });
      expect(result.protocol).toBe(fixture.protocol);
      expect(JSON.stringify(result)).not.toContain('test-private-key');
      expect(JSON.stringify(result)).not.toContain('OK');
    });
  });

  it('拒绝失败HTTP且不泄露上游响应正文', async () => {
    await endpoint(
      { error: 'test-private-key' },
      async (base) => {
        const work = new ProtocolModelConnection().test(
          { ...channel, baseUrl: base },
          'test-private-key',
          'test-model',
        );
        await expect(work).rejects.toMatchObject({
          code: 'UNAVAILABLE',
          message: expect.stringContaining('HTTP 401'),
        });
        await expect(work).rejects.not.toHaveProperty(
          'message',
          expect.stringContaining('test-private-key'),
        );
      },
      401,
    );
  });

  it.each([
    null,
    [],
    { choices: 'invalid' },
    { choices: [{ message: { content: '' } }] },
  ])('拒绝HTTP成功但协议内容无效 %j', async (response) => {
    await endpoint(response, async (base) => {
      await expect(
        new ProtocolModelConnection().test(
          { ...channel, baseUrl: base },
          'key',
          'test-model',
        ),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });
  });
});

describe('凭证加密应用服务', () => {
  it('部分更新保留旧字段，密文绑定目标范围，公开状态不包含值', async () => {
    const workspaceId = randomUUID(),
      actorId = randomUUID(),
      resourceId = randomUUID();
    const session: StoredSession = {
      id: randomUUID(),
      identity: {
        id: actorId,
        providerId: 'test',
        subject: 'test',
        displayName: '张三',
        canCreateWorkspace: true,
      },
      encryptedCredential: '',
      expiresAt: new Date().toISOString(),
    };
    const codec = createSessionCodec(randomBytes(32).toString('hex'));
    let stored: {
      encryptedValues: string;
      fields: string[];
      expectedEncryptedValues: string | null;
    } | null = null;
    const repo: WorkCredentialRepository = {
      states: vi.fn(),
      read: vi.fn(async () => stored),
      save: vi.fn(async (_scope, _kind, _id, input) => {
        stored = input;
      }),
      modelChannel: vi.fn(),
    };
    const service = new WorkCredentialsService(repo, codec, { test: vi.fn() });
    await service.save(session, workspaceId, {
      kind: 'connector',
      id: resourceId,
      values: { account: 'readonly-user', apiPassword: 'private-password' },
    });
    await service.save(session, workspaceId, {
      kind: 'connector',
      id: resourceId,
      values: { databasePassword: 'database-private' },
    });
    const saved = stored as unknown as {
      encryptedValues: string;
      fields: string[];
    };
    expect(saved.encryptedValues).not.toContain('private-password');
    expect(saved.encryptedValues).not.toContain('database-private');
    expect(
      JSON.parse(
        codec.open(
          saved.encryptedValues,
          `work-credential:${workspaceId}:connector:${resourceId}`,
        ),
      ),
    ).toEqual({
      account: 'readonly-user',
      apiPassword: 'private-password',
      databasePassword: 'database-private',
    });
    expect(() =>
      codec.open(
        saved.encryptedValues,
        `work-credential:${randomUUID()}:connector:${resourceId}`,
      ),
    ).toThrow();
    await expect(
      service.save(session, workspaceId, {
        kind: 'connector',
        id: resourceId,
        values: { databasePassword: '' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service.save(session, workspaceId, {
        kind: 'model-channel',
        id: resourceId,
        values: { databasePassword: 'wrong-kind' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
