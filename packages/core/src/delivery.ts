import type { AgentRole, StoredSession } from './collaboration';
import type { DraftFence, ProjectLink, ProjectDraft } from './projects';
import type { Job, ResourceScope } from './index';

export type DeliveryStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'needs_auth'
  | 'needs_configuration'
  | 'needs_decision'
  | 'awaiting_deployment'
  | 'delivered'
  | 'failed'
  | 'cancelled';
export type DeliveryPhase =
  | 'design'
  | 'architecture'
  | 'implementation'
  | 'test'
  | 'design_review'
  | 'technical_review'
  | 'delivery';
export type DeliveryFile = Readonly<{ path: string; content: string }>;
export type DeliveryPackage = Readonly<{
  files: readonly DeliveryFile[];
  testCommands: readonly (readonly string[])[];
  buildCommands: readonly (readonly string[])[];
  previewPath: string;
  summary: string;
  limitations: readonly string[];
}>;
export type DeliveryEvidence = Readonly<{
  artifactRef: string;
  contentHash: string;
  files: readonly { path: string; hash: string; size: number }[];
  commands: readonly {
    command: readonly string[];
    exitCode: number;
    output: string;
  }[];
  passed: boolean;
  verifiedAt: string;
}>;
export type DeliveryEvent = Readonly<{
  sequence: number;
  kind: string;
  phase: DeliveryPhase;
  summary: string;
  role: AgentRole | null;
  createdAt: string;
}>;
export type DeliveryDocument = Readonly<{
  kind: string;
  role: AgentRole;
  version: number;
  content: string;
  createdAt: string;
}>;
export type DeliveryRun = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  teamId: string;
  actorId: string;
  ownerId: string;
  sessionId: string;
  goal: string;
  acceptance: string;
  mode: 'demo' | 'deploy';
  assignedRole: AgentRole | null;
  status: DeliveryStatus;
  phase: DeliveryPhase;
  revision: number;
  generation: number;
  budgetCalls: number;
  usedCalls: number;
  budgetTokens: number;
  usedTokens: number;
  maxRevisions: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  artifact: DeliveryEvidence | null;
  deployment: DeploymentReceipt | null;
}>;
export type DeliveryDetail = Readonly<{
  run: DeliveryRun;
  events: readonly DeliveryEvent[];
  documents: readonly DeliveryDocument[];
}>;
export type DeliveryStart = Readonly<{
  workspaceId: string;
  projectId: string;
  goal: string;
  acceptance: string;
  mode: 'demo' | 'deploy';
  assignedRole?: AgentRole;
  budgetCalls: number;
  budgetTokens: number;
  maxRevisions: number;
  requestId: string;
}>;
export type DeliveryProfiles = Readonly<
  Record<
    AgentRole,
    {
      model: string;
      instructions: string;
    }
  >
>;
export type DeliveryWorkerContext = Readonly<{
  run: DeliveryRun;
  session: StoredSession;
  ownerSession: StoredSession;
  profiles: DeliveryProfiles;
  documents: readonly DeliveryDocument[];
  project: ProjectLink;
}>;
export type DeliveryFence = Readonly<{ job: Job; workerId: string }>;

export interface DeliveryRepository {
  start(session: StoredSession, input: DeliveryStart): Promise<DeliveryRun>;
  list(
    scope: ResourceScope,
    projectId?: string,
  ): Promise<readonly DeliveryRun[]>;
  detail(scope: ResourceScope, runId: string): Promise<DeliveryDetail>;
  control(
    scope: ResourceScope,
    runId: string,
    command: 'pause' | 'resume' | 'cancel',
    sessionId: string,
  ): Promise<DeliveryRun>;
  profiles(scope: ResourceScope): Promise<DeliveryProfiles>;
  setProfiles(scope: ResourceScope, profiles: DeliveryProfiles): Promise<void>;
  extendBudget(
    scope: ResourceScope,
    runId: string,
    calls: number,
    tokens: number,
  ): Promise<DeliveryRun>;
  workerContext(fence: DeliveryFence): Promise<DeliveryWorkerContext | null>;
  deploymentContext(fence: DraftFence): Promise<DeliveryWorkerContext | null>;
  deploymentWriteAllowed(fence: DraftFence): Promise<boolean>;
  recordDeployment(
    fence: DraftFence,
    runId: string,
    receipt: DeploymentReceipt,
  ): Promise<boolean>;
  withDeploymentLock<T>(fence: DraftFence, work: () => Promise<T>): Promise<T>;
  reconciliationContext(
    scope: ResourceScope,
    runId: string,
    draftId: string,
    sessionId: string,
  ): Promise<{ delivery: DeliveryWorkerContext; draft: ProjectDraft }>;
  recordReconciliation(
    scope: ResourceScope,
    runId: string,
    draftId: string,
    sessionId: string,
    receipt: DeploymentReceipt | null,
    confirmNotPublished: boolean,
  ): Promise<void>;
  reserveCall(fence: DeliveryFence, estimatedTokens: number): Promise<boolean>;
  settleCall(
    fence: DeliveryFence,
    reservedTokens: number,
    actualTokens: number,
  ): Promise<void>;
  checkpoint(
    fence: DeliveryFence,
    input: {
      status?: DeliveryStatus;
      phase?: DeliveryPhase;
      revision?: number;
      error?: string | null;
      event: { kind: string; summary: string; role?: AgentRole };
      document?: { kind: string; role: AgentRole; content: string };
      artifact?: DeliveryEvidence;
      deployment?: DeploymentReceipt;
    },
  ): Promise<boolean>;
}
export interface DeliveryAuthorization {
  assertProject(
    session: StoredSession,
    workspaceId: string,
    projectId: string,
    write?: boolean,
  ): Promise<void>;
}
export interface DeliveryModel {
  readonly configured: boolean;
  readonly defaultModel: string;
  generate(input: {
    model: string;
    system: string;
    prompt: string;
    maxTokens: number;
    signal: AbortSignal;
  }): Promise<{ text: string; totalTokens: number }>;
}
export type DeploymentReceipt = Readonly<{
  id: string;
  artifactRef: string;
  contentHash: string;
  version: number;
  status: 'healthy' | 'failed' | 'rolled_back';
  environment: 'local-demo';
  healthCheckedAt: string;
  previousDeploymentId: string | null;
}>;
export interface DeliveryExecution {
  readonly configured: boolean;
  verify(input: {
    runId: string;
    revision: number;
    package: DeliveryPackage;
    supportFiles?: readonly DeliveryFile[];
    signal: AbortSignal;
  }): Promise<DeliveryEvidence>;
  read(
    artifactRef: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  deploy(input: {
    runId: string;
    projectId: string;
    artifact: DeliveryEvidence;
    approvalId: string;
    signal: AbortSignal;
  }): Promise<DeploymentReceipt>;
  rollback(input: {
    runId: string;
    projectId: string;
    deploymentId: string;
    approvalId: string;
    signal: AbortSignal;
  }): Promise<DeploymentReceipt>;
  deploymentFile(
    deploymentId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  inspectDeployment(
    projectId: string,
    deploymentId: string,
    signal: AbortSignal,
  ): Promise<{
    receipt: DeploymentReceipt | null;
    healthy: boolean;
    verifiedAt: string;
  }>;
}
