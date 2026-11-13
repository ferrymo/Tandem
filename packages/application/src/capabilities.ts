import { DomainError } from '@tandem/core';
import type {
  AgentRole,
  CapabilityBinding,
  CapabilityRepository,
  McpConnection,
  McpTool,
  McpTransportPort,
  McpWriteProposal,
  ResourceScope,
  SkillBundle,
  SkillSourcePort,
  SkillVersion,
  StoredSession,
  ToolEffect,
} from '@tandem/core';
import { canonicalJson, validateSkillBundle } from '@tandem/capabilities';

export type CapabilityInvocation = CapabilityBinding & {
  agentRole: AgentRole;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  expectedRevision?: number;
  expectedSchemaHash?: string;
};
export type CapabilitiesOptions = {
  assertProject(
    scope: ResourceScope,
    projectId: string,
    write?: boolean,
  ): Promise<void>;
  assertOwner(
    scope: ResourceScope,
    binding: CapabilityBinding,
    ownerSession: StoredSession,
    write?: boolean,
  ): Promise<void>;
  hash(value: string): string;
  seal(value: string): string;
  open(value: string): string;
  skillSource?: SkillSourcePort;
  availableDependencies?: readonly string[];
};
const hasControl = (value: string) =>
  Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

export class CapabilitiesService {
  constructor(
    private readonly repository: CapabilityRepository,
    private readonly transport: McpTransportPort,
    private readonly options: CapabilitiesOptions,
  ) {}
  async overview(scope: ResourceScope) {
    const [skills, servers] = await Promise.all([
      this.repository.listSkills(scope),
      this.repository.listServers(scope),
    ]);
    return { skills, servers };
  }
  listSkills(scope: ResourceScope) {
    return this.repository.listSkills(scope);
  }
  skill(scope: ResourceScope, skillId: string) {
    return this.repository.getSkill(scope, skillId);
  }
  async installSkill(
    scope: ResourceScope,
    input: SkillBundle,
    signal: AbortSignal = AbortSignal.timeout(30000),
  ) {
    await this.repository.assertManage(scope);
    // Validate the declared fixed source before performing network IO.
    const declared = validateSkillBundle(
      input.source.kind === 'git'
        ? {
            ...input,
            files: {
              'SKILL.md': `---\nname: ${input.name}\ndescription: Fixed source installation\n---\n`,
            },
          }
        : input,
    );
    const files =
      declared.source.kind === 'git'
        ? await this.loadSource(declared.source, signal)
        : declared.files;
    const bundle = validateSkillBundle({ ...declared, files });
    return this.repository.installSkill(
      scope,
      bundle,
      this.options.hash(canonicalJson(bundle)),
    );
  }
  private loadSource(
    source: Extract<SkillBundle['source'], { kind: 'git' }>,
    signal: AbortSignal,
  ) {
    if (!this.options.skillSource)
      throw new DomainError('UNAVAILABLE', '仓库技能安装尚未配置');
    return this.options.skillSource.load(source, signal);
  }
  private async authorizeBinding(
    scope: ResourceScope,
    binding: CapabilityBinding,
    write = false,
  ) {
    await this.options.assertProject(scope, binding.projectId, write);
    const owner = await this.repository.ownerSession(
      scope,
      binding.projectId,
      binding.teamId,
      write,
    );
    await this.options.assertOwner(scope, binding, owner, write);
  }
  async activateSkill(
    scope: ResourceScope,
    skillId: string,
    versionId: string,
  ) {
    await this.repository.assertManage(scope);
    await this.repository.activateSkill(scope, skillId, versionId);
  }
  async setSkillEnabled(
    scope: ResourceScope,
    skillId: string,
    enabled: boolean,
  ) {
    await this.repository.assertManage(scope);
    await this.repository.setSkillEnabled(scope, skillId, enabled);
  }
  async uninstallSkill(scope: ResourceScope, skillId: string) {
    await this.repository.assertManage(scope);
    await this.repository.uninstallSkill(scope, skillId);
  }
  async bindSkill(
    scope: ResourceScope,
    input: CapabilityBinding & {
      skillId: string;
      versionId: string;
      permissions: string[];
      enabled: boolean;
    },
  ) {
    await this.repository.assertManage(scope);
    await this.options.assertProject(scope, input.projectId, true);
    const skill = await this.repository.getSkill(scope, input.skillId);
    const version = skill.versions.find((v) => v.id === input.versionId);
    if (!version || (input.enabled && (!skill.enabled || skill.removed)))
      throw new DomainError('FORBIDDEN', '技能不可用或版本不存在');
    if (input.permissions.some((p) => !version.permissions.includes(p)))
      throw new DomainError('FORBIDDEN', '绑定权限超出技能版本声明');
    return this.repository.bindSkill(
      scope,
      input.skillId,
      input.versionId,
      input,
      [...new Set(input.permissions)].sort(),
      input.enabled,
    );
  }
  async bindings(scope: ResourceScope, projectId: string) {
    await this.options.assertProject(scope, projectId);
    const [skills, tools] = await Promise.all([
      this.repository.skillBindings(scope, projectId),
      this.repository.toolGrants(scope, projectId),
    ]);
    return { skills, tools };
  }
  async resolveSkills(
    scope: ResourceScope,
    input: CapabilityBinding & {
      agentRole: AgentRole;
      versions?: { skillId: string; versionId: string }[];
    },
  ): Promise<SkillVersion[]> {
    await this.authorizeBinding(scope, input);
    const bindings = (
      await this.repository.skillBindings(scope, input.projectId)
    ).filter(
      (b) =>
        b.enabled &&
        b.teamId === input.teamId &&
        (b.agentRole === null || b.agentRole === input.agentRole),
    );
    const selected =
      input.versions ??
      bindings.map((b) => ({ skillId: b.skillId, versionId: b.versionId }));
    const output: SkillVersion[] = [];
    for (const snapshot of selected) {
      const binding = bindings.find(
        (b) =>
          b.skillId === snapshot.skillId && b.versionId === snapshot.versionId,
      );
      const skill = await this.repository.getSkill(scope, snapshot.skillId);
      const version = skill.versions.find((v) => v.id === snapshot.versionId);
      if (
        !binding ||
        !skill.enabled ||
        skill.removed ||
        !version ||
        version.permissions.some((p) => !binding.permissions.includes(p))
      )
        throw new DomainError(
          'FORBIDDEN',
          '技能版本已停用、授权已撤销或所需权限未获批准',
        );
      const missing = version.dependencies.filter(
        (dependency) =>
          !this.options.availableDependencies?.includes(dependency),
      );
      if (missing.length)
        throw new DomainError(
          'UNAVAILABLE',
          `隔离执行环境未提供已声明的技能依赖：${missing.join('、')}`,
        );
      if (output.some((v) => v.skillId === skill.id)) continue;
      output.push(version);
      await this.repository.recordUsage(scope, {
        kind: 'skill',
        resourceId: skill.id,
        projectId: input.projectId,
        version: version.version,
        status: 'succeeded',
        summary: '加载固定技能版本与资源',
      });
    }
    return output;
  }
  listServers(scope: ResourceScope) {
    return this.repository.listServers(scope);
  }
  async saveServer(
    scope: ResourceScope,
    input: {
      id?: string;
      name: string;
      connection: McpConnection;
      expectedRevision?: number;
    },
  ) {
    await this.repository.assertManage(scope);
    if (!input.name.trim() || input.name.length > 120)
      throw new DomainError('INVALID_INPUT', 'MCP Server 名称须为 1–120 字符');
    const connection = input.connection;
    if (connection.type === 'http') {
      let url: URL;
      try {
        url = new URL(connection.url);
      } catch {
        throw new DomainError('INVALID_INPUT', 'MCP 地址无效');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new DomainError(
          'INVALID_INPUT',
          'MCP 地址须为不包含凭证和查询参数的 HTTP(S) 地址',
        );
    } else if (
      connection.type !== 'stdio' ||
      !connection.image ||
      connection.image.length > 300 ||
      !Array.isArray(connection.command) ||
      !connection.command.length ||
      connection.command.length > 32 ||
      connection.command.some((p) => !p || p.length > 1000 || hasControl(p))
    ) {
      throw new DomainError(
        'INVALID_INPUT',
        'stdio MCP 须提供允许的隔离镜像和容器内命令',
      );
    }
    return this.repository.saveServer(scope, {
      ...input,
      name: input.name.trim(),
    });
  }
  async setServerEnabled(
    scope: ResourceScope,
    serverId: string,
    enabled: boolean,
  ) {
    await this.repository.assertManage(scope);
    await this.repository.setServerEnabled(scope, serverId, enabled);
  }
  async removeServer(scope: ResourceScope, serverId: string) {
    await this.repository.assertManage(scope);
    await this.repository.removeServer(scope, serverId);
  }
  async setCredential(
    scope: ResourceScope,
    serverId: string,
    credential: string | null,
  ) {
    await this.repository.getServer(scope, serverId);
    if (
      credential !== null &&
      (!credential.trim() || credential.length > 8192 || hasControl(credential))
    )
      throw new DomainError('INVALID_INPUT', 'MCP 凭证格式无效');
    await this.repository.setCredential(
      scope,
      serverId,
      credential === null ? null : this.options.seal(credential),
    );
  }
  async testServer(
    scope: ResourceScope,
    serverId: string,
    signal: AbortSignal = AbortSignal.timeout(15000),
  ) {
    await this.repository.assertManage(scope);
    const server = await this.repository.getServer(scope, serverId);
    try {
      const tools = this.normalizeTools(
        await this.transport.catalog(
          server.connection,
          await this.credential(scope, serverId, server.revision),
          signal,
        ),
      );
      return await this.repository.saveCatalog(
        scope,
        serverId,
        server.revision,
        tools,
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CONFLICT')
        throw error;
      await this.repository.saveCatalog(scope, serverId, server.revision, null);
      throw new DomainError(
        'UNAVAILABLE',
        'MCP 连接或工具发现失败；请检查地址、本人凭证和隔离配置',
      );
    }
  }
  private normalizeTools(tools: McpTool[]): McpTool[] {
    if (tools.length > 128)
      throw new DomainError('INVALID_INPUT', 'MCP 工具数量超出上限');
    const seen = new Set<string>();
    return tools
      .map((tool) => {
        if (
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name) ||
          seen.has(tool.name) ||
          tool.description.length > 8000 ||
          canonicalJson(tool.inputSchema).length > 65536
        )
          throw new DomainError('INVALID_INPUT', 'MCP 工具元信息无效或过大');
        seen.add(tool.name);
        return {
          ...tool,
          schemaHash: this.options.hash(
            canonicalJson({ name: tool.name, inputSchema: tool.inputSchema }),
          ),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async grantTool(
    scope: ResourceScope,
    input: CapabilityBinding & {
      serverId: string;
      toolName: string;
      effect: ToolEffect;
      enabled: boolean;
    },
  ) {
    await this.repository.assertManage(scope);
    await this.options.assertProject(scope, input.projectId, true);
    if (!['read', 'write', 'unknown'].includes(input.effect))
      throw new DomainError('INVALID_INPUT', '须明确分类工具副作用');
    if (!input.enabled) {
      const previous = (
        await this.repository.toolGrants(scope, input.projectId)
      ).find(
        (grant) =>
          grant.serverId === input.serverId &&
          grant.toolName === input.toolName &&
          grant.teamId === input.teamId &&
          grant.agentRole === input.agentRole,
      );
      if (!previous)
        throw new DomainError('FORBIDDEN', '工具授权不存在或无权访问');
      return this.repository.grantTool(
        scope,
        input.serverId,
        {
          name: previous.toolName,
          schemaHash: previous.schemaHash,
          inputSchema: {},
          description: '',
        },
        previous.revision,
        input,
        previous.effect,
        false,
      );
    }
    const server = await this.repository.getServer(scope, input.serverId);
    const tool = server.tools.find((t) => t.name === input.toolName);
    if (
      !tool ||
      !server.enabled ||
      server.status === 'untested' ||
      server.status === 'unavailable'
    )
      throw new DomainError('FORBIDDEN', '请先成功测试已启用的 MCP Server');
    return this.repository.grantTool(
      scope,
      server.id,
      tool,
      server.revision,
      input,
      input.effect,
      input.enabled,
    );
  }
  async listRuntimeTools(scope: ResourceScope, binding: CapabilityBinding) {
    await this.authorizeBinding(scope, binding);
    const grants = (
      await this.repository.toolGrants(scope, binding.projectId)
    ).filter(
      (g) =>
        g.enabled &&
        g.effect !== 'unknown' &&
        g.teamId === binding.teamId &&
        (g.agentRole === null || g.agentRole === binding.agentRole),
    );
    const servers = await this.repository.listServers(scope);
    return grants.flatMap((grant) => {
      const server = servers.find(
        (s) =>
          s.id === grant.serverId &&
          s.enabled &&
          s.revision === grant.revision &&
          (s.status === 'ready' || s.status === 'changed'),
      );
      const tool = server?.tools.find(
        (t) => t.name === grant.toolName && t.schemaHash === grant.schemaHash,
      );
      return tool
        ? [
            {
              serverId: server!.id,
              revision: server!.revision,
              effect: grant.effect,
              ...tool,
            },
          ]
        : [];
    });
  }
  async callTool(
    scope: ResourceScope,
    input: CapabilityInvocation,
    signal: AbortSignal = AbortSignal.timeout(30000),
  ) {
    const { server, tool, effect } = await this.authorizeTool(scope, input);
    if (effect === 'write')
      return {
        kind: 'proposal' as const,
        proposal: {
          kind: 'mcp.call' as const,
          serverId: server.id,
          serverRevision: server.revision,
          toolName: tool.name,
          schemaHash: tool.schemaHash,
          projectId: input.projectId,
          teamId: input.teamId,
          agentRole: input.agentRole,
          arguments: input.arguments,
        },
      };
    return {
      kind: 'result' as const,
      ...(await this.invoke(
        scope,
        input,
        server.connection,
        server.revision,
        tool,
        signal,
        false,
      )),
    };
  }
  async validateWriteProposal(
    scope: ResourceScope,
    proposal: McpWriteProposal,
  ) {
    const result = await this.authorizeTool(scope, {
      ...proposal,
      expectedRevision: proposal.serverRevision,
      expectedSchemaHash: proposal.schemaHash,
    });
    if (
      result.effect !== 'write' ||
      result.server.revision !== proposal.serverRevision ||
      result.tool.schemaHash !== proposal.schemaHash
    )
      throw new DomainError(
        'CONFLICT',
        'MCP 配置、工具定义或授权已变更，请重新提案并审批',
      );
    return result;
  }
  /** Only the unified draft executor invokes this after its immutable approval/fence checks. */
  async executeApprovedTool(
    scope: ResourceScope,
    proposal: McpWriteProposal,
    signal: AbortSignal = AbortSignal.timeout(30000),
  ) {
    const { server, tool } = await this.validateWriteProposal(scope, proposal);
    return this.invoke(
      scope,
      proposal,
      server.connection,
      server.revision,
      tool,
      signal,
      true,
    );
  }
  private async authorizeTool(
    scope: ResourceScope,
    input: CapabilityInvocation,
  ) {
    if (
      !['designer', 'architect', 'engineer'].includes(input.agentRole) ||
      !input.arguments ||
      Array.isArray(input.arguments) ||
      typeof input.arguments !== 'object' ||
      canonicalJson(input.arguments).length > 65536 ||
      (input.expectedRevision === undefined) !==
        (input.expectedSchemaHash === undefined) ||
      (input.expectedRevision !== undefined &&
        (!Number.isInteger(input.expectedRevision) ||
          input.expectedRevision < 1 ||
          typeof input.expectedSchemaHash !== 'string' ||
          !input.expectedSchemaHash ||
          input.expectedSchemaHash.length > 200))
    )
      throw new DomainError('INVALID_INPUT', '工具调用角色或参数无效');
    const authorization = await this.repository.toolAuthorization(scope, input);
    await this.authorizeBinding(scope, input, authorization.effect === 'write');
    return authorization;
  }
  private async credential(
    scope: ResourceScope,
    serverId: string,
    revision: number,
  ) {
    const ciphertext = await this.repository.credential(
      scope,
      serverId,
      revision,
    );
    return ciphertext === null ? null : this.options.open(ciphertext);
  }
  private async invoke(
    scope: ResourceScope,
    input: CapabilityInvocation,
    connection: McpConnection,
    revision: number,
    tool: McpTool,
    signal: AbortSignal,
    write: boolean,
  ) {
    let status: 'succeeded' | 'failed' | 'unknown' = write
      ? 'unknown'
      : 'failed';
    try {
      const credential = await this.credential(scope, input.serverId, revision);
      const expected = {
        ...input,
        expectedRevision: revision,
        expectedSchemaHash: tool.schemaHash,
      };
      await this.authorizeTool(scope, expected);
      // Fresh actor/owner checks may perform network IO. Admit the dispatch only
      // after one final database snapshot, then use that exact connection/tool.
      const current = await this.repository.toolAuthorization(scope, expected);
      if (
        current.effect !== (write ? 'write' : 'read') ||
        canonicalJson(current.server.connection) !== canonicalJson(connection)
      )
        throw new DomainError(
          'CONFLICT',
          'MCP 连接或工具副作用授权已变化，当前调用不能继续',
        );
      const result = await this.transport.invoke(
        current.server.connection,
        credential,
        current.tool,
        input.arguments,
        signal,
      );
      status = result.isError ? 'failed' : 'succeeded';
      return result;
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === 'CONFLICT' ||
          error.code === 'INVALID_INPUT' ||
          error.code === 'FORBIDDEN')
      ) {
        status = 'failed';
        throw error;
      }
      throw new DomainError(
        'UNAVAILABLE',
        write
          ? 'MCP 请求结果未知，请人工核对，禁止盲目重试'
          : 'MCP 工具调用失败',
      );
    } finally {
      await this.repository.recordUsage(scope, {
        kind: 'mcp',
        resourceId: input.serverId,
        projectId: input.projectId,
        version: tool.schemaHash,
        status,
        summary: tool.name,
      });
    }
  }
  async usage(scope: ResourceScope, projectId: string) {
    await this.options.assertProject(scope, projectId);
    return this.repository.usage(scope, projectId);
  }
}
