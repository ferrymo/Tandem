import { createHash } from 'node:crypto';
import {
  CapabilitiesService,
  DeliveryService,
  ProjectsService,
} from '@tandem/application';
import { DomainError, type StoredSession } from '@tandem/core';
import { createSessionCodec } from '@tandem/platform';
import {
  PostgresCapabilityRepository,
  PostgresDeliveryRepository,
  PostgresProjectsRepository,
} from '@tandem/storage-postgres';
import { ZentaoProjectSystem } from '@tandem/zentao';
import { GithubSkillSource, SdkMcpTransport } from '@tandem/mcp-client';
import { DockerDeliveryExecution } from '@tandem/execution';
import { collaborationConfig, identityProviderId } from './collaboration';
import { database } from './database';

const split = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export function projectSystem(session: StoredSession) {
  const config = collaborationConfig();
  if (
    !config.TANDEM_IDENTITY_URL ||
    !config.SESSION_ENCRYPTION_KEY ||
    session.identity.providerId !==
      identityProviderId(config.TANDEM_IDENTITY_ID, config.TANDEM_IDENTITY_URL)
  )
    throw new DomainError('FORBIDDEN', '原账号连接已变化，请重新登录');
  const accessToken = createSessionCodec(config.SESSION_ENCRYPTION_KEY).open(
    session.encryptedCredential,
    session.identity.providerId + ':' + session.identity.subject,
  );
  return new ZentaoProjectSystem({
    connectionId: session.identity.providerId,
    baseUrl: config.TANDEM_IDENTITY_URL,
    accessToken,
    subject: session.identity.subject,
    allowInsecureHttp: config.TANDEM_IDENTITY_ALLOW_HTTP,
  });
}
export function executionAdapter() {
  if (!process.env.TANDEM_ARTIFACT_ROOT || !process.env.TANDEM_EXECUTION_IMAGE)
    throw new DomainError('UNAVAILABLE', '隔离执行与产物存储尚未配置');
  return new DockerDeliveryExecution({
    root: process.env.TANDEM_ARTIFACT_ROOT,
    image: process.env.TANDEM_EXECUTION_IMAGE,
  });
}
export function productServices(session: StoredSession, workspaceId: string) {
  const config = collaborationConfig();
  if (!config.SESSION_ENCRYPTION_KEY)
    throw new DomainError('UNAVAILABLE', '凭证加密未配置');
  const pool = database();
  const codec = createSessionCodec(config.SESSION_ENCRYPTION_KEY);
  const repository = new PostgresProjectsRepository(pool);
  const upstream = projectSystem(session);
  const direct = new ProjectsService(repository, upstream);
  const assertProject = async (
    current: StoredSession,
    space: string,
    project: string,
    write = false,
  ) => {
    await new ProjectsService(
      repository,
      projectSystem(current),
    ).assertProjectAccess(
      { workspaceId: space, actorId: current.identity.id },
      project,
      write,
    );
  };
  const delivery = new DeliveryService(new PostgresDeliveryRepository(pool), {
    assertProject,
  });
  const aad = `mcp:${workspaceId}:${session.identity.id}`;
  const capabilities = new CapabilitiesService(
    new PostgresCapabilityRepository(pool),
    new SdkMcpTransport({
      allowedOrigins: split(process.env.MCP_ALLOWED_ORIGINS),
      allowedImages: split(process.env.MCP_ALLOWED_IMAGES),
    }),
    {
      assertProject: async (scope, projectId, write) => {
        await direct.assertProjectAccess(scope, projectId, write);
      },
      assertOwner: async (scope, binding, owner, write) => {
        const upstream = projectSystem(owner);
        const link = await new ProjectsService(
          repository,
          upstream,
        ).assertProjectAccess(
          { workspaceId: scope.workspaceId, actorId: owner.identity.id },
          binding.projectId,
          write,
        );
        if (write) await upstream.assertWritable(link.externalId);
      },
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      seal: (value) => codec.seal(value, aad),
      open: (value) => codec.open(value, aad),
      skillSource: new GithubSkillSource(),
      availableDependencies: ['node:24', 'npm'],
    },
  );
  const projects = new ProjectsService(repository, upstream, {
    validate: async (scope, project, action) => {
      if (action.kind === 'mcp.call') {
        if (action.projectId !== project.id)
          throw new DomainError('FORBIDDEN', '工具草案范围不匹配');
        await capabilities.validateWriteProposal(scope, action);
      } else
        await delivery.validateDeploymentProposal(scope, project.id, action);
    },
  });
  return {
    projects,
    delivery,
    capabilities,
    scope: { workspaceId, actorId: session.identity.id },
  };
}
