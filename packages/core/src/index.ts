export type ExternalRef = Readonly<{
  connectionId: string;
  resourceType: 'project' | 'task' | 'execution';
  externalId: string;
}>;
export * from './collaboration';
export * from './projects';
export * from './capabilities';
export * from './work-management';
export * from './work-secrets';
export * from './delivery-model-routing';
export * from './connector-read';
export type ResourceScope = Readonly<{ workspaceId: string; actorId: string }>;
export class DomainError extends Error {
  constructor(
    public readonly code:
      | 'FORBIDDEN'
      | 'UNAVAILABLE'
      | 'INVALID_INPUT'
      | 'CONFLICT'
      | 'UNAUTHENTICATED'
      | 'RATE_LIMITED',
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export interface AuthorizationPort {
  assertAllowed(
    scope: ResourceScope,
    resource: ExternalRef,
    action: 'read' | 'write',
  ): Promise<void>;
}
export interface ReadinessPort {
  check(): Promise<boolean>;
}
export interface Job {
  id: string;
  workspaceId: string;
  kind: string;
  token: string;
  attempts: number;
  maxAttempts: number;
  reference: string;
  checkpoint: Readonly<Record<string, unknown>>;
}
export interface JobQueue {
  claim(workerId: string, leaseMs: number): Promise<Job | null>;
  renew(job: Job, workerId: string, leaseMs: number): Promise<boolean>;
  complete(job: Job, workerId: string): Promise<boolean>;
  fail(job: Job, workerId: string, code: string): Promise<boolean>;
  checkpoint(
    job: Job,
    workerId: string,
    value: Record<string, unknown>,
  ): Promise<boolean>;
}
export interface CollabAdapter {
  readonly kind: string;
  read(scope: ResourceScope, ref: ExternalRef): Promise<unknown>;
}
export interface ModelProvider {
  readonly id: string;
  generate(input: {
    messages: readonly {
      role: 'user' | 'assistant' | 'system';
      content: string;
    }[];
    signal: AbortSignal;
  }): Promise<{ text: string }>;
}
export interface ExecutionProvider {
  execute(input: {
    scope: ResourceScope;
    artifactRef: string;
    signal: AbortSignal;
  }): Promise<{
    status: 'succeeded' | 'failed';
    evidenceRefs: readonly string[];
  }>;
}
export interface McpClientProvider {
  discover(
    scope: ResourceScope,
    serverId: string,
  ): Promise<readonly { name: string; schemaHash: string }[]>;
}
export * from './delivery';
