import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { CapabilitiesService } from '../../packages/application/src/capabilities';
import { validateSkillBundle } from '../../packages/capabilities/src/management';
import { SdkMcpTransport } from '../../adapters/mcp-client/src/transport';
import { DomainError } from '../../packages/core/src/index';
import type {
  CapabilityRepository,
  InstalledSkill,
  McpServer,
  McpTool,
  McpToolGrant,
  McpTransportPort,
  SkillBinding,
  SkillBundle,
} from '../../packages/core/src/index';

const scope = { workspaceId: 'space', actorId: 'actor' };
const binding = {
  projectId: 'project',
  teamId: 'team',
  agentRole: 'engineer' as const,
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const bundle = (): SkillBundle => ({
  name: 'test-skill',
  version: '1.0.0',
  description: 'Bounded test skill',
  source: { kind: 'upload', label: 'unit fixture' },
  permissions: ['execution.script'],
  dependencies: [],
  files: {
    'SKILL.md':
      '---\nname: test-skill\ndescription: Bounded test skill\n---\nRun the verification script.',
    'scripts/check.mjs': 'console.log("verified")',
  },
});
function fixture() {
  const skill: InstalledSkill = {
    id: 'skill',
    name: 'test-skill',
    description: 'Skill',
    activeVersionId: 'v1',
    enabled: true,
    removed: false,
    versions: [
      {
        ...bundle(),
        id: 'v1',
        skillId: 'skill',
        contentHash: hash('version1'),
        installedAt: new Date().toISOString(),
      },
    ],
  };
  const skills: SkillBinding[] = [
    {
      ...binding,
      id: 'binding',
      skillId: 'skill',
      versionId: 'v1',
      permissions: ['execution.script'],
      enabled: true,
    },
  ];
  const tool: McpTool = {
    name: 'echo',
    description: 'Test echo',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    schemaHash: 'schema',
  };
  const server: McpServer = {
    id: 'server',
    name: 'Test',
    connection: { type: 'http', url: 'https://example.test/mcp' },
    revision: 1,
    status: 'ready',
    enabled: true,
    checkedAt: null,
    tools: [tool],
    credentialConfigured: false,
  };
  const grants: McpToolGrant[] = [
    {
      ...binding,
      id: 'grant',
      serverId: server.id,
      toolName: tool.name,
      schemaHash: tool.schemaHash,
      revision: 1,
      effect: 'read',
      enabled: true,
    },
  ];
  const repository: CapabilityRepository = {
    assertManage: vi.fn(async () => undefined),
    ownerSession: vi.fn(async () => ({
      id: 'owner-session',
      identity: {
        id: 'owner',
        providerId: 'test',
        subject: 'owner',
        displayName: '张三',
        canCreateWorkspace: true,
      },
      encryptedCredential: 'owner-token-reference',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })),
    listSkills: vi.fn(async () => [skill]),
    getSkill: vi.fn(async () => skill),
    installSkill: vi.fn(async () => skill),
    activateSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    uninstallSkill: vi.fn(),
    bindSkill: vi.fn(),
    skillBindings: vi.fn(async () => skills),
    listServers: vi.fn(async () => [server]),
    getServer: vi.fn(async () => server),
    toolAuthorization: vi.fn(async (_scope, input) => {
      const selected = server.tools.find((t) => t.name === input.toolName);
      if (
        (input.expectedRevision !== undefined &&
          server.revision !== input.expectedRevision) ||
        (input.expectedSchemaHash !== undefined &&
          selected?.schemaHash !== input.expectedSchemaHash)
      )
        throw new DomainError('CONFLICT', '工具版本变化');
      const grant = grants.find(
        (g) =>
          g.serverId === server.id &&
          g.toolName === selected?.name &&
          g.projectId === input.projectId &&
          g.teamId === input.teamId &&
          (g.agentRole === null || g.agentRole === input.agentRole) &&
          g.enabled &&
          g.revision === server.revision &&
          g.schemaHash === selected?.schemaHash &&
          g.effect !== 'unknown',
      );
      if (
        !server.enabled ||
        !['ready', 'changed'].includes(server.status) ||
        !selected ||
        !grant
      )
        throw new DomainError('FORBIDDEN', '工具授权无效');
      return structuredClone({ server, tool: selected, effect: grant.effect });
    }),
    saveServer: vi.fn(),
    setServerEnabled: vi.fn(),
    removeServer: vi.fn(),
    saveCatalog: vi.fn(async () => server),
    setCredential: vi.fn(),
    credential: vi.fn(async () => 'encrypted-personal'),
    grantTool: vi.fn(),
    toolGrants: vi.fn(async () => grants),
    recordUsage: vi.fn(),
    usage: vi.fn(async () => []),
  };
  const transport: McpTransportPort = {
    catalog: vi.fn(async () => [tool]),
    invoke: vi.fn(async () => ({
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    })),
  };
  const assertProject = vi.fn(async () => undefined);
  const assertOwner = vi.fn(async () => undefined);
  const service = new CapabilitiesService(repository, transport, {
    assertProject,
    assertOwner,
    hash,
    seal: (value) => 'encrypted:' + value,
    open: (value) => value.replace('encrypted-', ''),
  });
  return {
    service,
    repository,
    transport,
    skill,
    skills,
    server,
    grants,
    assertProject,
    assertOwner,
  };
}
describe('Skills 来源、版本与使用授权', () => {
  it('安装保留完整有界资源，拒绝穿越、凭证与版本元信息错配', () => {
    expect(validateSkillBundle(bundle()).files['scripts/check.mjs']).toContain(
      'verified',
    );
    for (const path of [
      '../secret',
      '/absolute',
      'folder/../../secret',
      'C:/secret',
      'dir\\secret',
      '.env.local',
      'con.txt',
    ])
      expect(() =>
        validateSkillBundle({
          ...bundle(),
          files: { ...bundle().files, [path]: 'secret' },
        }),
      ).toThrow();
    expect(() =>
      validateSkillBundle({
        ...bundle(),
        files: { ...bundle().files, 'key.pem': '-----BEGIN PRIVATE KEY-----' },
      }),
    ).toThrow();
    expect(() =>
      validateSkillBundle({ ...bundle(), name: 'different' }),
    ).toThrow();
    expect(() =>
      validateSkillBundle({
        ...bundle(),
        source: {
          kind: 'git',
          repository: 'https://github.com/example/repo',
          commit: 'main',
          path: 'skill',
        },
      }),
    ).toThrow();
  });
  it('未授权所需权限不能加载，新增版本不替换运行快照', async () => {
    const f = fixture();
    f.skill.versions.push({
      ...f.skill.versions[0]!,
      id: 'v2',
      version: '2.0.0',
      permissions: ['execution.script', 'mcp.write'],
    });
    f.skill.activeVersionId = 'v2';
    const versions = await f.service.resolveSkills(scope, {
      ...binding,
      versions: [{ skillId: 'skill', versionId: 'v1' }],
    });
    expect(versions[0]!.version).toBe('1.0.0');
    f.skills[0]!.versionId = 'v2';
    await expect(f.service.resolveSkills(scope, binding)).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(
      f.service.resolveSkills(scope, {
        ...binding,
        versions: [{ skillId: 'skill', versionId: 'v1' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('停用、撤权及项目撤权阻止后续加载', async () => {
    const f = fixture();
    f.skill.enabled = false;
    await expect(f.service.resolveSkills(scope, binding)).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    f.skill.enabled = true;
    f.skills[0]!.enabled = false;
    await expect(
      f.service.resolveSkills(scope, {
        ...binding,
        versions: [{ skillId: 'skill', versionId: 'v1' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.assertProject.mockRejectedValueOnce(new Error('upstream access revoked'));
    await expect(f.service.resolveSkills(scope, binding)).rejects.toThrow(
      'upstream access revoked',
    );
  });
  it('技能绑定不能授权声明之外的权限', async () => {
    const f = fixture();
    await expect(
      f.service.bindSkill(scope, {
        ...binding,
        skillId: 'skill',
        versionId: 'v1',
        permissions: ['host.admin'],
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.repository.bindSkill).not.toHaveBeenCalled();
  });
  it('缺少显式环境依赖时不加载技能', async () => {
    const f = fixture();
    f.skill.versions[0]!.dependencies = ['python:3'];
    await expect(f.service.resolveSkills(scope, binding)).rejects.toMatchObject(
      { code: 'UNAVAILABLE' },
    );
    expect(f.repository.recordUsage).not.toHaveBeenCalled();
  });
});
describe('MCP 分类、草案及执行状态', () => {
  const call = {
    ...binding,
    serverId: 'server',
    toolName: 'echo',
    arguments: { value: 'hello' },
  };
  it('挂靠人本地或上游授权撤回后不能调用，也不替换发起人凭证', async () => {
    const f = fixture();
    f.assertOwner.mockRejectedValueOnce(
      new Error('owner upstream access revoked'),
    );
    await expect(f.service.callTool(scope, call)).rejects.toThrow(
      'owner upstream access revoked',
    );
    expect(f.transport.invoke).not.toHaveBeenCalled();
    vi.mocked(f.repository.ownerSession).mockRejectedValueOnce(
      new Error('owner session expired'),
    );
    await expect(f.service.callTool(scope, call)).rejects.toThrow(
      'owner session expired',
    );
    expect(f.transport.invoke).not.toHaveBeenCalled();
  });
  it('连接测试只发现工具，绝不调用业务工具', async () => {
    const f = fixture();
    await f.service.testServer(scope, 'server');
    expect(f.transport.catalog).toHaveBeenCalledOnce();
    expect(f.transport.invoke).not.toHaveBeenCalled();
  });
  it('未知分类、撤权和配置版本变化均不能执行', async () => {
    const f = fixture();
    f.grants[0]!.effect = 'unknown';
    await expect(f.service.callTool(scope, call)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    f.grants[0]!.effect = 'read';
    f.server.revision = 2;
    await expect(f.service.callTool(scope, call)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    f.server.revision = 1;
    f.grants[0]!.enabled = false;
    await expect(f.service.callTool(scope, call)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.transport.invoke).not.toHaveBeenCalled();
  });
  it('写工具仅产草案，审批执行仍重新核验固定版本', async () => {
    const f = fixture();
    f.grants[0]!.effect = 'write';
    const output = await f.service.callTool(scope, call);
    expect(f.repository.ownerSession).toHaveBeenLastCalledWith(
      scope,
      binding.projectId,
      binding.teamId,
      true,
    );
    expect(f.assertOwner).toHaveBeenLastCalledWith(
      scope,
      expect.objectContaining(binding),
      expect.objectContaining({ id: 'owner-session' }),
      true,
    );
    expect(f.transport.invoke).not.toHaveBeenCalled();
    expect(output.kind).toBe('proposal');
    if (output.kind !== 'proposal') throw new Error('Expected proposal');
    await f.service.executeApprovedTool(scope, output.proposal);
    expect(f.transport.invoke).toHaveBeenCalledOnce();
    f.server.revision = 2;
    f.grants[0]!.revision = 2;
    await expect(
      f.service.executeApprovedTool(scope, output.proposal),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.transport.invoke).toHaveBeenCalledOnce();
  });
  it('只使用本人凭证，写请求失联记录未知且不重试', async () => {
    const f = fixture();
    f.grants[0]!.effect = 'write';
    const output = await f.service.callTool(scope, call);
    if (output.kind !== 'proposal') throw new Error('Expected proposal');
    vi.mocked(f.transport.invoke).mockRejectedValueOnce(
      new Error('private token must never surface'),
    );
    await expect(
      f.service.executeApprovedTool(scope, output.proposal),
    ).rejects.toThrow('结果未知');
    expect(f.transport.invoke).toHaveBeenCalledOnce();
    expect(f.transport.invoke).toHaveBeenCalledWith(
      f.server.connection,
      'personal',
      f.server.tools[0],
      call.arguments,
      expect.any(AbortSignal),
    );
    expect(f.repository.recordUsage).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ status: 'unknown', summary: 'echo' }),
    );
    expect(
      JSON.stringify(vi.mocked(f.repository.recordUsage).mock.calls),
    ).not.toContain('private token');
  });
  it('运行固定版本不能被同名工具升级与重新授权替换', async () => {
    const f = fixture();
    f.server.revision = 2;
    f.grants[0]!.revision = 2;
    await expect(
      f.service.callTool(scope, {
        ...call,
        expectedRevision: 1,
        expectedSchemaHash: 'schema',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.transport.invoke).not.toHaveBeenCalled();
  });
  it('发送前重新核对配置和授权，阻止授权检查期间升级或撤权', async () => {
    const f = fixture();
    vi.mocked(f.repository.credential).mockImplementationOnce(async () => {
      f.server.revision = 2;
      f.grants[0]!.revision = 2;
      return 'encrypted-personal';
    });
    await expect(
      f.service.callTool(scope, {
        ...call,
        expectedRevision: 1,
        expectedSchemaHash: 'schema',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.transport.invoke).not.toHaveBeenCalled();
    const g = fixture();
    vi.mocked(g.repository.credential).mockImplementationOnce(async () => {
      g.grants[0]!.enabled = false;
      return 'encrypted-personal';
    });
    await expect(g.service.callTool(scope, call)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(g.transport.invoke).not.toHaveBeenCalled();
    const h = fixture();
    h.assertOwner
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        h.server.revision = 2;
        h.grants[0]!.revision = 2;
      });
    await expect(
      h.service.callTool(scope, {
        ...call,
        expectedRevision: 1,
        expectedSchemaHash: 'schema',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.transport.invoke).not.toHaveBeenCalled();
  });
});

describe('真实 MCP HTTP 协议', () => {
  it('初始化/工具发现无副作用，调用验证 schema 且阻止漂移和重定向', async () => {
    let calls = 0;
    let drift = false;
    const authorizations: (string | undefined)[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/redirect') {
        response
          .writeHead(302, { Location: 'http://127.0.0.1:9/secret' })
          .end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      authorizations.push(request.headers.authorization);
      let body = '';
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: unknown;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'test-fixture', version: '1.0.0' },
        };
      else if (message.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'echo',
              description: 'Echo fixture',
              inputSchema: {
                type: 'object',
                properties: { value: { type: drift ? 'number' : 'string' } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          ],
        };
      else if (message.method === 'tools/call') {
        calls++;
        result = {
          content: [{ type: 'text', text: 'actual protocol result' }],
        };
      } else {
        response.writeHead(400).end();
        return;
      }
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const adapter = new SdkMcpTransport({
      allowedOrigins: [origin],
      allowedImages: [],
    });
    const connection = { type: 'http' as const, url: origin + '/mcp' };
    const signal = AbortSignal.timeout(10000);
    try {
      const tools = await adapter.catalog(connection, 'user-token', signal);
      expect(tools).toHaveLength(1);
      expect(calls).toBe(0);
      const result = await adapter.invoke(
        connection,
        'user-token',
        tools[0]!,
        { value: 'hello' },
        signal,
      );
      expect(result.content).toEqual([
        { type: 'text', text: 'actual protocol result' },
      ]);
      expect(calls).toBe(1);
      await expect(
        adapter.invoke(
          connection,
          'user-token',
          tools[0]!,
          { value: 12 },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(calls).toBe(1);
      drift = true;
      await expect(
        adapter.invoke(
          connection,
          'user-token',
          tools[0]!,
          { value: 'hello' },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(calls).toBe(1);
      expect(
        authorizations.every((value) => value === 'Bearer user-token'),
      ).toBe(true);
      await expect(
        adapter.catalog(
          { ...connection, url: origin + '/redirect' },
          null,
          signal,
        ),
      ).rejects.toThrow();
      await expect(
        new SdkMcpTransport({ allowedOrigins: [], allowedImages: [] }).catalog(
          connection,
          null,
          signal,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        adapter.catalog(
          { type: 'stdio', image: 'node:latest', command: ['node'] },
          null,
          signal,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
