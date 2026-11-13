import { z } from 'zod';
import { uuid } from './collaboration-http';

const text = z.string().max(20000);
const role = z.enum(['designer', 'architect', 'engineer']);
const binding = { projectId: uuid, teamId: uuid, agentRole: role.nullable() };
const taskChanges = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: text.optional(),
    assignedTo: z.string().min(1).max(120).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    estimate: z.number().min(0).max(100000).optional(),
    deadline: z.string().max(40).optional(),
  })
  .strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const numericId = z.string().regex(/^[1-9]\d{0,19}$/);
export const draftAction = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task.create'),
      executionId: numericId,
      name: z.string().min(1).max(200),
      description: text,
      assignedTo: z.string().min(1).max(120),
      startDate: z.string().max(40),
      deadline: z.string().max(40),
      priority: z.number().int().min(0).max(4),
      estimate: z.number().min(0).max(100000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task.update'),
      taskId: numericId,
      expectedVersion: hash,
      changes: taskChanges,
    })
    .strict(),
  z
    .object({
      kind: z.literal('task.status'),
      taskId: numericId,
      expectedVersion: hash,
      transition: z.enum(['start', 'pause', 'finish', 'close']),
      consumed: z.number().min(0),
      left: z.number().min(0),
      comment: text,
      realStarted: z.string().max(40).optional(),
      finishedDate: z.string().max(40).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('task.effort'),
      taskId: numericId,
      expectedVersion: hash,
      date: z.string().max(40),
      consumed: z.number().positive(),
      left: z.number().min(0),
      work: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal('delivery.deploy'),
      runId: uuid,
      artifactRef: z.string().max(250),
      contentHash: hash,
      version: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('delivery.rollback'),
      runId: uuid,
      deploymentId: uuid,
      contentHash: hash,
      version: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp.call'),
      serverId: uuid,
      serverRevision: z.number().int().positive(),
      toolName: z.string().max(128),
      schemaHash: hash,
      ...binding,
      agentRole: role,
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
const profile = z
  .object({ model: z.string().max(200), instructions: z.string().max(6000) })
  .strict();
const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), label: z.string().max(200) }).strict(),
  z
    .object({
      kind: z.literal('git'),
      repository: z.string().max(500),
      commit: z.string().max(40),
      path: z.string().max(200),
    })
    .strict(),
]);
const connection = z.discriminatedUnion('type', [
  z.object({ type: z.literal('http'), url: z.string().max(2000) }).strict(),
  z
    .object({
      type: z.literal('stdio'),
      image: z.string().max(300),
      command: z.array(z.string().max(1000)).max(32),
    })
    .strict(),
]);
const command = <T extends string, S extends z.ZodRawShape>(
  name: T,
  shape: S,
) => z.object({ command: z.literal(name), ...shape }).strict();
export const productCommand = z.discriminatedUnion('command', [
  command('bind-project', { externalId: numericId }),
  command('grant-project', {
    projectId: uuid,
    identityId: uuid,
    canWrite: z.boolean(),
  }),
  command('revoke-project', { projectId: uuid, identityId: uuid }),
  command('add-message', { projectId: uuid, taskId: numericId, message: text }),
  command('create-draft', {
    projectId: uuid,
    title: z.string().min(1).max(200),
    action: draftAction,
    requestId: uuid,
  }),
  command('revise-draft', {
    draftId: uuid,
    version: z.number().int().positive(),
    title: z.string().min(1).max(200),
    action: draftAction,
    projectId: uuid.optional(),
    requestId: uuid.optional(),
  }),
  command('review-draft', {
    draftId: uuid,
    version: z.number().int().positive(),
    approve: z.boolean(),
  }),
  command('start-run', {
    projectId: uuid,
    goal: z.string().min(1).max(6000),
    acceptance: z.string().min(1).max(6000),
    mode: z.enum(['demo', 'deploy']),
    assignedRole: role.optional(),
    budgetCalls: z.number().int(),
    budgetTokens: z.number().int(),
    maxRevisions: z.number().int(),
    requestId: uuid,
  }),
  command('control-run', {
    runId: uuid,
    action: z.enum(['pause', 'resume', 'cancel']),
  }),
  command('extend-budget', {
    runId: uuid,
    calls: z.number().int(),
    tokens: z.number().int(),
  }),
  command('reconcile-deployment', {
    runId: uuid,
    draftId: uuid,
    confirmNotPublished: z.boolean().default(false),
  }),
  command('configure-team', {
    profiles: z
      .object({ designer: profile, architect: profile, engineer: profile })
      .strict(),
  }),
  command('install-skill', {
    bundle: z
      .object({
        name: z.string().max(80),
        version: z.string().max(80),
        description: z.string().max(2000),
        source,
        permissions: z.array(z.string().max(100)).max(32),
        dependencies: z.array(z.string().max(100)).max(32),
        files: z.record(z.string(), z.string().max(131072)),
      })
      .strict(),
  }),
  command('activate-skill', { skillId: uuid, versionId: uuid }),
  command('toggle-skill', { skillId: uuid, enabled: z.boolean() }),
  command('uninstall-skill', { skillId: uuid }),
  command('bind-skill', {
    skillId: uuid,
    versionId: uuid,
    ...binding,
    permissions: z.array(z.string().max(100)).max(32),
    enabled: z.boolean(),
    id: uuid.optional(),
  }),
  command('save-server', {
    id: uuid.optional(),
    name: z.string().min(1).max(120),
    connection,
    expectedRevision: z.number().int().positive().optional(),
  }),
  command('toggle-server', { serverId: uuid, enabled: z.boolean() }),
  command('remove-server', { serverId: uuid }),
  command('test-server', { serverId: uuid }),
  command('server-credential', {
    serverId: uuid,
    credential: z.string().max(8192).nullable(),
  }),
  command('grant-tool', {
    serverId: uuid,
    toolName: z.string().max(128),
    ...binding,
    effect: z.enum(['read', 'write', 'unknown']),
    enabled: z.boolean(),
    id: uuid.optional(),
    schemaHash: hash.optional(),
    revision: z.number().optional(),
  }),
  command('call-tool', {
    serverId: uuid,
    toolName: z.string().max(128),
    ...binding,
    agentRole: role,
    arguments: z.record(z.string(), z.unknown()),
    requestId: uuid,
  }),
]);
