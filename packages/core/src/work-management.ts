import type { ResourceScope } from './index';

export const projectStages = [
  'presales',
  'initiated',
  'executing',
  'launched',
  'maintenance',
  'closed',
  'frozen',
  'cancelled',
] as const;
export const taskStatuses = [
  'not_started',
  'in_progress',
  'completed',
  'closed',
  'paused',
  'cancelled',
] as const;
export type ProjectStage = (typeof projectStages)[number];
export type WorkTaskStatus = (typeof taskStatuses)[number];
export type WorkProtocol = 'openai' | 'anthropic' | 'ollama';
export const workPermissions = [
  'project.create',
  'project.manage',
  'document.manage',
  'team.manage',
  'agent.manage',
  'config.manage',
] as const;
export type WorkPermission = (typeof workPermissions)[number];
export type Versioned = { id: string; version: number };
export type WorkGroup = Versioned & {
  name: string;
  parentId: string | null;
  sortOrder: number;
};
export type WorkProject = Versioned & {
  canWrite?: boolean;
  name: string;
  description: string;
  groupId: string | null;
  stage: ProjectStage;
  ownerId: string;
  initiatedOn: string | null;
  launchOn: string | null;
  acceptanceOn: string | null;
  maintenanceUntil: string | null;
  plannedDays: number | null;
  plannedAmount: number | null;
  repositoryUrl: string;
  deploymentTarget: string;
  deploymentBranch: string;
  deploymentCommand: string;
  createdAt: string;
  updatedAt: string;
};
export type WorkParticipant = {
  id: string;
  name: string;
  kind: 'human' | 'agent';
};
export type WorkTeam = Versioned & {
  name: string;
  description: string;
  memberIds: string[];
  ownerId: string;
};
export type WorkProjectMember = Versioned & {
  projectId: string;
  participantId: string;
  role: string;
  canWrite: boolean;
};
export type WorkModule = Versioned & {
  projectId: string;
  name: string;
  description: string;
};
export type WorkDocument = Versioned & {
  title: string;
  body: string;
  scope: 'project' | 'team' | 'personal';
  projectId: string | null;
  teamId: string | null;
  visibility: 'space' | 'private';
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};
export type WorkTask = Versioned & {
  projectId: string;
  moduleId: string | null;
  name: string;
  description: string;
  assigneeId: string | null;
  collaboratorIds: string[];
  plannedStart: string | null;
  plannedEnd: string | null;
  plannedHours: number | null;
  actualStart: string | null;
  actualEnd: string | null;
  actualHours: number;
  status: WorkTaskStatus;
  cancellationReason: string;
  createdAt: string;
  updatedAt: string;
};
export type WorkTaskEvent = {
  id: string;
  taskId: string;
  actorId: string;
  kind:
    | 'created'
    | 'updated'
    | 'comment'
    | 'effort'
    | 'attachment_added'
    | 'attachment_removed';
  body: string;
  changes: Record<string, { before: unknown; after: unknown }>;
  createdAt: string;
};
export type WorkEffort = {
  id: string;
  taskId: string;
  projectId: string;
  actorId: string;
  date: string;
  hours: number;
  note: string;
  createdAt: string;
};
export type WorkAgent = Versioned & {
  name: string;
  description: string;
  avatar: string;
  teamId: string | null;
  modelChannelId: string | null;
  model: string;
  protocol: WorkProtocol;
  sandboxId: string | null;
  skillIds: string[];
  mcpServerIds: string[];
  enabled: boolean;
};
export type WorkSandbox = Versioned & {
  name: string;
  image: string;
  workdir: string;
  networkPolicy: 'none' | 'restricted';
  cpu: number;
  memoryMb: number;
  enabled: boolean;
};
export type WorkModelChannel = Versioned & {
  name: string;
  baseUrl: string;
  protocol: WorkProtocol;
  models: string[];
  credentialRef: string;
  enabled: boolean;
};
export type WorkRole = Versioned & {
  name: string;
  description: string;
  permissions: string[];
  memberIds: string[];
  enabled: boolean;
};
export type WorkMenu = Versioned & {
  key: string;
  label: string;
  visible: boolean;
  sortOrder: number;
};
export type WorkPlugin = Versioned & {
  name: string;
  description: string;
  source: string;
  pinnedVersion: string;
  enabled: boolean;
};
export type WorkConnector = Versioned & {
  name: string;
  kind: 'zentao';
  baseUrl: string;
  databaseHost: string;
  databasePort: number;
  databaseName: string;
  databaseUser: string;
  credentialRef: string;
  enabled: boolean;
};
export type WorkAttachment = {
  id: string;
  projectId: string | null;
  taskId: string | null;
  documentId: string | null;
  ownerId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
};
export type WorkAttachmentInput = {
  projectId?: string | null;
  taskId?: string | null;
  documentId?: string | null;
  name: string;
  mime: string;
  size: number;
  storageKey: string;
};
export type WorkSnapshot = {
  groups: WorkGroup[];
  projects: WorkProject[];
  participants: WorkParticipant[];
  teams: WorkTeam[];
  projectMembers: WorkProjectMember[];
  modules: WorkModule[];
  documents: WorkDocument[];
  tasks: WorkTask[];
  taskEvents: WorkTaskEvent[];
  efforts: WorkEffort[];
  agents: WorkAgent[];
  sandboxes: WorkSandbox[];
  modelChannels: WorkModelChannel[];
  roles: WorkRole[];
  menus: WorkMenu[];
  plugins: WorkPlugin[];
  connectors: WorkConnector[];
  attachments: WorkAttachment[];
  canAdmin: boolean;
  permissions: string[];
  actorId: string;
};
type Save<T extends Versioned> = Omit<
  T,
  'id' | 'version' | 'createdAt' | 'updatedAt' | 'actualHours' | 'ownerId'
> & { id?: string; version?: number };
export type WorkCommand =
  | ({ command: 'save-project-group' } & Save<WorkGroup>)
  | { command: 'remove-project-group'; id: string; version: number }
  | ({ command: 'save-project'; ownerId: string } & Save<WorkProject>)
  | ({ command: 'save-team' } & Save<WorkTeam>)
  | ({ command: 'save-project-member' } & Save<WorkProjectMember>)
  | { command: 'remove-project-member'; id: string; version: number }
  | ({ command: 'save-module' } & Save<WorkModule>)
  | { command: 'remove-module'; id: string; version: number; projectId: string }
  | ({ command: 'save-document' } & Save<WorkDocument>)
  | ({ command: 'save-task' } & Save<WorkTask>)
  | { command: 'add-task-comment'; taskId: string; body: string }
  | {
      command: 'log-efforts';
      requestId: string;
      entries: { taskId: string; date: string; hours: number; note: string }[];
    }
  | ({ command: 'save-agent' } & Save<WorkAgent>)
  | ({ command: 'save-sandbox' } & Save<WorkSandbox>)
  | ({ command: 'save-model-channel' } & Save<WorkModelChannel>)
  | ({ command: 'save-role' } & Save<WorkRole>)
  | ({ command: 'save-menu' } & Save<WorkMenu>)
  | ({ command: 'save-plugin' } & Save<WorkPlugin>)
  | ({ command: 'save-connector' } & Save<WorkConnector>)
  | {
      command: 'remove-configuration';
      kind:
        | 'agent'
        | 'sandbox'
        | 'model-channel'
        | 'role'
        | 'menu'
        | 'plugin'
        | 'connector';
      id: string;
      version: number;
    };
export type WorkResult = { id?: string; version?: number };
export interface WorkManagementRepository {
  snapshot(scope: ResourceScope): Promise<WorkSnapshot>;
  execute(scope: ResourceScope, command: WorkCommand): Promise<WorkResult>;
  createAttachment(
    scope: ResourceScope,
    input: WorkAttachmentInput,
  ): Promise<WorkAttachment>;
  attachment(
    scope: ResourceScope,
    id: string,
  ): Promise<WorkAttachment & { storageKey: string }>;
  deleteAttachment(scope: ResourceScope, id: string): Promise<void>;
}
