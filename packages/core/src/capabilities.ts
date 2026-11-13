import type { AgentRole, ResourceScope } from './index';
import type { StoredSession } from './collaboration';

export type ToolEffect = 'read' | 'write' | 'unknown';
export type SkillSource =
  | { kind: 'upload'; label: string }
  | { kind: 'git'; repository: string; commit: string; path: string };
export type SkillBundle = {
  name: string;
  version: string;
  description: string;
  source: SkillSource;
  permissions: string[];
  dependencies: string[];
  files: Record<string, string>;
};
export type SkillVersion = SkillBundle & {
  id: string;
  skillId: string;
  contentHash: string;
  installedAt: string;
};
export type InstalledSkill = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  activeVersionId: string | null;
  removed: boolean;
  versions: SkillVersion[];
};
export type CapabilityBinding = {
  projectId: string;
  teamId: string;
  agentRole: AgentRole | null;
};
export type SkillBinding = CapabilityBinding & {
  id: string;
  skillId: string;
  versionId: string;
  enabled: boolean;
  permissions: string[];
};
export type McpConnection =
  | { type: 'http'; url: string }
  | { type: 'stdio'; image: string; command: string[] };
export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schemaHash: string;
};
export type McpServer = {
  id: string;
  name: string;
  connection: McpConnection;
  revision: number;
  enabled: boolean;
  status: 'untested' | 'ready' | 'unavailable' | 'changed';
  checkedAt: string | null;
  tools: McpTool[];
  credentialConfigured: boolean;
};
export type McpToolGrant = CapabilityBinding & {
  id: string;
  serverId: string;
  toolName: string;
  schemaHash: string;
  revision: number;
  effect: ToolEffect;
  enabled: boolean;
};
export type CapabilityUsage = {
  id: string;
  kind: 'skill' | 'mcp';
  resourceId: string;
  projectId: string;
  actorId: string;
  version: string;
  status: 'succeeded' | 'failed' | 'unknown';
  summary: string;
  createdAt: string;
};
export type McpWriteProposal = {
  kind: 'mcp.call';
  serverId: string;
  serverRevision: number;
  toolName: string;
  schemaHash: string;
  projectId: string;
  teamId: string;
  agentRole: AgentRole;
  arguments: Record<string, unknown>;
};
export interface CapabilityRepository {
  assertManage(scope: ResourceScope): Promise<void>;
  ownerSession(
    scope: ResourceScope,
    projectId: string,
    teamId: string,
    write?: boolean,
  ): Promise<StoredSession>;
  listSkills(scope: ResourceScope): Promise<InstalledSkill[]>;
  getSkill(scope: ResourceScope, skillId: string): Promise<InstalledSkill>;
  installSkill(
    scope: ResourceScope,
    bundle: SkillBundle,
    contentHash: string,
  ): Promise<InstalledSkill>;
  activateSkill(
    scope: ResourceScope,
    skillId: string,
    versionId: string,
  ): Promise<void>;
  setSkillEnabled(
    scope: ResourceScope,
    skillId: string,
    enabled: boolean,
  ): Promise<void>;
  uninstallSkill(scope: ResourceScope, skillId: string): Promise<void>;
  bindSkill(
    scope: ResourceScope,
    skillId: string,
    versionId: string,
    binding: CapabilityBinding,
    permissions: string[],
    enabled: boolean,
  ): Promise<SkillBinding>;
  skillBindings(
    scope: ResourceScope,
    projectId?: string,
  ): Promise<SkillBinding[]>;
  listServers(scope: ResourceScope): Promise<McpServer[]>;
  getServer(scope: ResourceScope, serverId: string): Promise<McpServer>;
  toolAuthorization(
    scope: ResourceScope,
    input: CapabilityBinding & {
      agentRole: AgentRole;
      serverId: string;
      toolName: string;
      expectedRevision?: number;
      expectedSchemaHash?: string;
    },
  ): Promise<{ server: McpServer; tool: McpTool; effect: ToolEffect }>;
  saveServer(
    scope: ResourceScope,
    input: {
      id?: string;
      name: string;
      connection: McpConnection;
      expectedRevision?: number;
    },
  ): Promise<McpServer>;
  setServerEnabled(
    scope: ResourceScope,
    serverId: string,
    enabled: boolean,
  ): Promise<void>;
  removeServer(scope: ResourceScope, serverId: string): Promise<void>;
  saveCatalog(
    scope: ResourceScope,
    serverId: string,
    revision: number,
    tools: McpTool[] | null,
  ): Promise<McpServer>;
  setCredential(
    scope: ResourceScope,
    serverId: string,
    ciphertext: string | null,
  ): Promise<void>;
  credential(
    scope: ResourceScope,
    serverId: string,
    revision?: number,
  ): Promise<string | null>;
  grantTool(
    scope: ResourceScope,
    serverId: string,
    tool: McpTool,
    revision: number,
    binding: CapabilityBinding,
    effect: ToolEffect,
    enabled: boolean,
  ): Promise<McpToolGrant>;
  toolGrants(scope: ResourceScope, projectId?: string): Promise<McpToolGrant[]>;
  recordUsage(
    scope: ResourceScope,
    input: Omit<CapabilityUsage, 'id' | 'createdAt' | 'actorId'>,
  ): Promise<void>;
  usage(scope: ResourceScope, projectId: string): Promise<CapabilityUsage[]>;
}
export interface McpTransportPort {
  catalog(
    connection: McpConnection,
    credential: string | null,
    signal: AbortSignal,
  ): Promise<McpTool[]>;
  invoke(
    connection: McpConnection,
    credential: string | null,
    tool: McpTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ isError: boolean; content: unknown[] }>;
}
export interface SkillSourcePort {
  load(
    source: Extract<SkillSource, { kind: 'git' }>,
    signal: AbortSignal,
  ): Promise<Record<string, string>>;
}
