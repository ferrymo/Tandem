import { createHash } from 'node:crypto';
import {
  CapabilitiesService,
  DeliveryService,
  DraftWorker,
} from '@tandem/application';
import { runDeliveryJob } from '@tandem/agent-runtime';
import { DomainError } from '@tandem/core';
import type { DraftFence, Job, ProjectLink, StoredSession } from '@tandem/core';
import { createSessionCodec, readCollaborationEnv } from '@tandem/platform';
import {
  PostgresCapabilityRepository,
  PostgresDeliveryRepository,
  PostgresProjectsRepository,
} from '@tandem/storage-postgres';
import { ZentaoIdentityProvider, ZentaoProjectSystem } from '@tandem/zentao';
import { CompatibleDeliveryModel } from '@tandem/model';
import { DockerDeliveryExecution } from '@tandem/execution';
import { SdkMcpTransport } from '@tandem/mcp-client';
import type pg from 'pg';

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;
function requestId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function productHandlers(
  pool: pg.Pool,
  workerId: string,
  signal: AbortSignal,
): Map<string, JobHandler> {
  const config = readCollaborationEnv();
  const codec = config.SESSION_ENCRYPTION_KEY
    ? createSessionCodec(config.SESSION_ENCRYPTION_KEY)
    : null;
  const projects = new PostgresProjectsRepository(pool);
  const deliveryRepo = new PostgresDeliveryRepository(pool);
  const model = new CompatibleDeliveryModel({
    ...(process.env.MODEL_BASE_URL
      ? { baseUrl: process.env.MODEL_BASE_URL }
      : {}),
    ...(process.env.MODEL_NAME ? { model: process.env.MODEL_NAME } : {}),
    ...(process.env.MODEL_API_KEY ? { apiKey: process.env.MODEL_API_KEY } : {}),
    allowHttp: process.env.MODEL_ALLOW_HTTP === 'true',
  });
  const execution =
    process.env.TANDEM_ARTIFACT_ROOT && process.env.TANDEM_EXECUTION_IMAGE
      ? new DockerDeliveryExecution({
          root: process.env.TANDEM_ARTIFACT_ROOT,
          image: process.env.TANDEM_EXECUTION_IMAGE,
        })
      : null;
  async function systemFor(session: StoredSession) {
    if (!codec || !config.TANDEM_IDENTITY_URL)
      throw new DomainError('UNAVAILABLE', '原身份连接尚未配置');
    const url = new URL(config.TANDEM_IDENTITY_URL);
    url.pathname =
      url.pathname.replace(/\/+$/, '').replace(/\/api\.php\/v1$/, '') || '/';
    const id =
      config.TANDEM_IDENTITY_ID +
      ':' +
      createHash('sha256').update(url.toString()).digest('hex').slice(0, 32);
    if (
      session.identity.providerId !== id ||
      Date.parse(session.expiresAt) <= Date.now()
    )
      throw new DomainError('UNAUTHENTICATED', '原账号连接或会话已失效');
    const accessToken = codec.open(
      session.encryptedCredential,
      id + ':' + session.identity.subject,
    );
    await new ZentaoIdentityProvider({
      id,
      label: config.TANDEM_IDENTITY_LABEL,
      baseUrl: config.TANDEM_IDENTITY_URL,
      commanderAccounts: config.TANDEM_COMMANDER_ACCOUNTS,
      allowInsecureHttp: config.TANDEM_IDENTITY_ALLOW_HTTP,
    }).verify(accessToken, session.identity.subject);
    return new ZentaoProjectSystem({
      connectionId: id,
      baseUrl: config.TANDEM_IDENTITY_URL,
      accessToken,
      subject: session.identity.subject,
      allowInsecureHttp: config.TANDEM_IDENTITY_ALLOW_HTTP,
    });
  }
  async function authorize(session: StoredSession, project: ProjectLink) {
    const upstream = await systemFor(session);
    if (upstream.connectionId !== project.connectionId)
      throw new DomainError('FORBIDDEN', '原执行连接已变化');
    await upstream.project(project.externalId);
  }
  function capabilities(
    session: StoredSession,
    project: ProjectLink,
    fence: DraftFence,
  ) {
    if (!codec) throw new DomainError('UNAVAILABLE', '凭证加密未配置');
    const scope = {
      workspaceId: project.workspaceId,
      actorId: session.identity.id,
    };
    const aad = `mcp:${scope.workspaceId}:${scope.actorId}`;
    return new CapabilitiesService(
      new PostgresCapabilityRepository(pool, fence),
      new SdkMcpTransport({
        allowedOrigins: list(process.env.MCP_ALLOWED_ORIGINS),
        allowedImages: list(process.env.MCP_ALLOWED_IMAGES),
      }),
      {
        assertOwner: async (scope, binding, owner, write) => {
          if (
            scope.workspaceId !== project.workspaceId ||
            binding.projectId !== project.id
          )
            throw new DomainError('FORBIDDEN', '挂靠人授权超出原项目');
          await authorize(owner, project);
          if (write)
            await (await systemFor(owner)).assertWritable(project.externalId);
        },
        assertProject: async (request, projectId, write) => {
          if (
            request.actorId !== scope.actorId ||
            request.workspaceId !== scope.workspaceId ||
            projectId !== project.id
          )
            throw new DomainError('FORBIDDEN', '能力调用超出当前运行范围');
          const upstream = await systemFor(session);
          await upstream.project(project.externalId);
          if (write) await upstream.assertWritable(project.externalId);
        },
        hash: (value) => createHash('sha256').update(value).digest('hex'),
        seal: (value) => codec.seal(value, aad),
        open: (value) => codec.open(value, aad),
        availableDependencies: ['node:24', 'npm'],
      },
    );
  }
  return new Map<string, JobHandler>([
    [
      'delivery.run',
      async (job: Job) => {
        if (!execution) {
          await deliveryRepo.checkpoint(
            { job, workerId },
            {
              status: 'needs_configuration',
              error: '隔离执行环境未配置',
              event: {
                kind: 'configuration_required',
                summary: '配置隔离执行镜像与产物存储后可继续',
              },
            },
          );
          return;
        }
        const fence = { job, workerId };
        await runDeliveryJob(
          job,
          workerId,
          {
            repository: deliveryRepo,
            model,
            execution,
            authorize: async (context) => {
              await authorize(context.session, context.project);
              await authorize(context.ownerSession, context.project);
            },
            capabilities: {
              resolveSkills: async (context, role, versions) =>
                capabilities(
                  context.session,
                  context.project,
                  fence,
                ).resolveSkills(
                  {
                    workspaceId: context.run.workspaceId,
                    actorId: context.run.actorId,
                  },
                  {
                    projectId: context.run.projectId,
                    teamId: context.run.teamId,
                    agentRole: role,
                    ...(versions ? { versions } : {}),
                  },
                ),
              listTools: async (context, role) =>
                capabilities(
                  context.session,
                  context.project,
                  fence,
                ).listRuntimeTools(
                  {
                    workspaceId: context.run.workspaceId,
                    actorId: context.run.actorId,
                  },
                  {
                    projectId: context.run.projectId,
                    teamId: context.run.teamId,
                    agentRole: role,
                  },
                ),
              callTool: async (context, role, input, callSignal) => {
                const output = await capabilities(
                  context.session,
                  context.project,
                  fence,
                ).callTool(
                  {
                    workspaceId: context.run.workspaceId,
                    actorId: context.run.actorId,
                  },
                  {
                    ...input,
                    projectId: context.run.projectId,
                    teamId: context.run.teamId,
                    agentRole: role,
                  },
                  callSignal,
                );
                if (output.kind === 'result') return output;
                const draft = await projects.createWorkerDraft(
                  fence,
                  `工具写入：${input.toolName}`,
                  output.proposal,
                  requestId(
                    `${context.run.id}:${role}:${JSON.stringify(output.proposal)}`,
                  ),
                );
                if (draft.status === 'succeeded')
                  return {
                    kind: 'result',
                    isError: false,
                    content: [
                      { type: 'text', text: JSON.stringify(draft.receipt) },
                    ],
                  };
                if (['failed', 'unknown', 'rejected'].includes(draft.status))
                  throw new DomainError(
                    'CONFLICT',
                    `工具草案${draft.status === 'unknown' ? '结果未知，须核对外部记录' : draft.status === 'rejected' ? '已退回，请调整方案' : '执行失败，请核对后处理'}`,
                  );
                return { kind: 'proposal', draftId: draft.id };
              },
            },
            proposeDeployment: async (context, artifact) =>
              projects.createWorkerDraft(
                fence,
                '部署已验证交付物',
                {
                  kind: 'delivery.deploy',
                  runId: context.run.id,
                  artifactRef: artifact.artifactRef,
                  contentHash: artifact.contentHash,
                  version: context.run.revision,
                },
                requestId(
                  `${context.run.id}:deploy:${artifact.contentHash}:${context.run.revision}:${context.run.generation}`,
                ),
              ),
          },
          signal,
        );
      },
    ],
    [
      'draft.execute',
      async (job: Job) => {
        const fence = { job, workerId };
        await new DraftWorker(projects, systemFor, {
          validate: async (context, action) => {
            if (action.kind === 'mcp.call')
              await capabilities(
                context.session,
                context.project,
                fence,
              ).validateWriteProposal(
                {
                  workspaceId: context.draft.workspaceId,
                  actorId: context.draft.actorId,
                },
                action,
              );
            else if (
              !execution ||
              !(await deliveryRepo.deploymentContext(fence))
            )
              throw new DomainError(
                'FORBIDDEN',
                '部署身份、产物、权限或审批已失效',
              );
          },
          execute: async (context, action, currentFence) => {
            if (action.kind === 'mcp.call') {
              const result = await capabilities(
                context.session,
                context.project,
                currentFence,
              ).executeApprovedTool(
                {
                  workspaceId: context.draft.workspaceId,
                  actorId: context.draft.actorId,
                },
                action,
                signal,
              );
              if (result.isError)
                return {
                  status: 'failed',
                  summary: `工具 ${action.toolName} 明确报告执行失败；请核对工具记录`,
                };
              return {
                status: 'succeeded',
                summary: `工具 ${action.toolName} 已执行；完整响应不长期保存`,
              };
            }
            if (!execution)
              throw new DomainError('UNAVAILABLE', '隔离执行环境未配置');
            const service = new DeliveryService(deliveryRepo, {
              assertProject: async (session, workspaceId, projectId, write) => {
                if (
                  workspaceId !== context.project.workspaceId ||
                  projectId !== context.project.id
                )
                  throw new DomainError('FORBIDDEN', '部署超出原项目范围');
                await authorize(session, context.project);
                if (write)
                  await (
                    await systemFor(session)
                  ).assertWritable(context.project.externalId);
              },
            });
            return service.executeApprovedDeployment(
              context,
              action,
              currentFence,
              execution,
              signal,
            );
          },
        }).execute(fence);
      },
    ],
  ]);
}
