import type { Job, ResourceScope } from './index';
import type { StoredSession } from './collaboration';

export type ExternalProject = Readonly<{
  id: string;
  name: string;
  status: string;
}>;
export type ExternalExecution = Readonly<{
  id: string;
  projectId: string;
  name: string;
  status: string;
}>;
export type ExternalTask = Readonly<{
  id: string;
  projectId: string;
  executionId: string;
  name: string;
  status: string;
  description: string;
  assignedTo: string;
  priority: number | null;
  estimate: number | null;
  deadline: string;
  consumed: number | null;
  left: number | null;
  realStarted: string;
  updatedAt: string;
  version: string;
}>;
export type ProjectLink = Readonly<{
  id: string;
  workspaceId: string;
  connectionId: string;
  externalId: string;
  createdBy: string;
  cacheVersion: string;
  createdAt: string;
  canWrite?: boolean;
}>;
export type ProjectGrant = Readonly<{
  identityId: string;
  displayName: string;
  role: 'viewer' | 'editor';
}>;
export type TaskChanges = Readonly<{
  name?: string;
  description?: string;
  assignedTo?: string;
  priority?: number;
  estimate?: number;
  deadline?: string;
}>;
export type TaskDraftAction = Readonly<
  | {
      kind: 'task.create';
      executionId: string;
      name: string;
      description: string;
      assignedTo: string;
      startDate: string;
      deadline: string;
      priority: number;
      estimate: number;
    }
  | {
      kind: 'task.update';
      taskId: string;
      expectedVersion: string;
      changes: TaskChanges;
    }
  | {
      kind: 'task.status';
      taskId: string;
      expectedVersion: string;
      transition: 'start' | 'pause' | 'finish' | 'close';
      consumed: number;
      left: number;
      comment: string;
      realStarted?: string;
      finishedDate?: string;
    }
  | {
      kind: 'task.effort';
      taskId: string;
      expectedVersion: string;
      date: string;
      consumed: number;
      left: number;
      work: string;
    }
>;
export type ExtensionDraftAction = Readonly<
  | {
      kind: 'delivery.deploy';
      runId: string;
      artifactRef: string;
      contentHash: string;
      version: number;
    }
  | {
      kind: 'delivery.rollback';
      runId: string;
      deploymentId: string;
      contentHash: string;
      version: number;
    }
  | {
      kind: 'mcp.call';
      serverId: string;
      serverRevision: number;
      toolName: string;
      schemaHash: string;
      projectId: string;
      teamId: string;
      agentRole: 'designer' | 'architect' | 'engineer';
      arguments: Readonly<Record<string, unknown>>;
    }
>;
export type ProjectDraftAction = TaskDraftAction | ExtensionDraftAction;
export type DraftReceipt = Readonly<{
  taskId?: string;
  status: string;
  summary?: string;
  reference?: string;
}>;
export type ProjectDraft = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  sessionId: string;
  title: string;
  version: number;
  action: ProjectDraftAction;
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'unknown';
  reviewerId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  receipt: (DraftReceipt & { recordedAt: string }) | null;
  error: string | null;
}>;
export type TaskMessage = Readonly<{
  id: string;
  taskId: string;
  actorId: string;
  displayName: string;
  body: string;
  createdAt: string;
}>;
export type DraftFence = Readonly<{ job: Job; workerId: string }>;
export type DraftExecutionContext = Readonly<{
  draft: ProjectDraft;
  session: StoredSession;
  project: ProjectLink;
}>;
export interface DraftValidationExtension {
  validate(
    scope: ResourceScope,
    project: ProjectLink,
    action: ExtensionDraftAction,
  ): Promise<void>;
}
export interface DraftExecutionExtension {
  validate(
    context: DraftExecutionContext,
    action: ExtensionDraftAction,
  ): Promise<void>;
  execute(
    context: DraftExecutionContext,
    action: ExtensionDraftAction,
    fence: DraftFence,
  ): Promise<DraftReceipt>;
}

/** Construct per verified user credential; never share an administrator token. */
export interface ProjectSystem {
  readonly connectionId: string;
  projects(page?: number): Promise<{
    items: readonly ExternalProject[];
    total: number;
    page: number;
  }>;
  project(id: string): Promise<ExternalProject>;
  executions(projectId: string): Promise<readonly ExternalExecution[]>;
  tasks(
    projectId: string,
    executionId: string,
    page?: number,
  ): Promise<{ items: readonly ExternalTask[]; total: number; page: number }>;
  task(projectId: string, taskId: string): Promise<ExternalTask>;
  readAccessKey(projectId: string, executionId?: string): Promise<string>;
  assertWritable(projectId: string, action?: TaskDraftAction): Promise<void>;
  execute(
    projectId: string,
    action: TaskDraftAction,
  ): Promise<{ taskId: string; status: string }>;
}
export interface ProjectsRepository {
  links(scope: ResourceScope): Promise<readonly ProjectLink[]>;
  link(
    scope: ResourceScope,
    projectId: string,
    write?: boolean,
  ): Promise<ProjectLink>;
  bind(
    scope: ResourceScope,
    connectionId: string,
    externalId: string,
  ): Promise<ProjectLink>;
  grants(
    scope: ResourceScope,
    projectId: string,
  ): Promise<readonly ProjectGrant[]>;
  grant(
    scope: ResourceScope,
    projectId: string,
    identityId: string,
    role: 'viewer' | 'editor' | null,
  ): Promise<void>;
  messages(
    scope: ResourceScope,
    projectId: string,
    taskId: string,
  ): Promise<readonly TaskMessage[]>;
  addMessage(
    scope: ResourceScope,
    projectId: string,
    taskId: string,
    body: string,
  ): Promise<void>;
  drafts(
    scope: ResourceScope,
    projectId?: string,
  ): Promise<readonly ProjectDraft[]>;
  draft(scope: ResourceScope, draftId: string): Promise<ProjectDraft>;
  createDraft(
    scope: ResourceScope,
    sessionId: string,
    projectId: string,
    title: string,
    action: ProjectDraftAction,
    requestId: string,
  ): Promise<ProjectDraft>;
  createWorkerDraft(
    fence: DraftFence,
    title: string,
    action: ExtensionDraftAction,
    requestId: string,
  ): Promise<ProjectDraft>;
  reviseDraft(
    scope: ResourceScope,
    draftId: string,
    version: number,
    title: string,
    action: ProjectDraftAction,
  ): Promise<ProjectDraft>;
  reviewDraft(
    scope: ResourceScope,
    draftId: string,
    version: number,
    approve: boolean,
  ): Promise<ProjectDraft>;
  workerContext(fence: DraftFence): Promise<DraftExecutionContext | null>;
  beginAction(fence: DraftFence): Promise<boolean>;
  finishAction(
    fence: DraftFence,
    result: {
      status: 'succeeded' | 'failed' | 'unknown';
      receipt?: DraftReceipt;
      error?: string;
    },
  ): Promise<boolean>;
}
