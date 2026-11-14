import { z } from 'zod';
import {
  collaboration,
  collaborationConfig,
} from '../../../../../server/collaboration';
import {
  assertSameOrigin,
  body,
  handle,
  requireSession,
  uuid,
} from '../../../../../server/collaboration-http';
import { jsonResponse } from '../../../../../server/http';
import {
  executionAdapter,
  productServices,
} from '../../../../../server/product';
import { productCommand } from '../../../../../server/product-http';
import type { ProjectDraftAction } from '@tandem/core';
import { parseDeliveryChannelModel } from '@tandem/core';

type Context = { params: Promise<{ workspaceId: string }> };
export function GET(request: Request, context: Context) {
  return handle(async () => {
    const session = await requireSession();
    const workspaceId = uuid.parse((await context.params).workspaceId);
    await collaboration().overview(session, workspaceId);
    const { projects, delivery, capabilities, modelChannels, scope } =
      productServices(session, workspaceId);
    const query = new URL(request.url).searchParams;
    const project = () => uuid.parse(query.get('project'));
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .parse(query.get('page') ?? '1');
    switch (query.get('resource')) {
      case 'connection': {
        const config = collaborationConfig();
        return jsonResponse({
          connection: { label: config.TANDEM_IDENTITY_LABEL, kind: 'zentao' },
          authorization: {
            displayName: session.identity.displayName,
            status: 'authorized',
          },
        });
      }
      case 'projects':
        return jsonResponse({
          projects: (await projects.listProjects(scope))
            .filter((p) => p.available)
            .map((p) => ({
              id: p.id,
              externalId: p.externalId,
              name: p.external!.name,
              status: p.external!.status,
              canWrite: p.canWrite ?? false,
            })),
        });
      case 'available-projects': {
        const all = [];
        for (let n = 1; n <= 100; n++) {
          const batch = await projects.availableProjects(n);
          all.push(...batch.items);
          if (!batch.items.length || all.length >= batch.total) break;
        }
        return jsonResponse({ projects: all });
      }
      case 'project-grants':
        return jsonResponse({
          grants: query.get('project')
            ? (await projects.grants(scope, project())).map((g) => ({
                ...g,
                canWrite: g.role === 'editor',
              }))
            : [],
        });
      case 'executions':
        return jsonResponse({
          executions: await projects.executions(scope, project()),
        });
      case 'tasks':
        return jsonResponse(
          query.get('execution')
            ? await projects.tasks(
                scope,
                project(),
                z
                  .string()
                  .regex(/^[1-9]\d*$/)
                  .parse(query.get('execution')),
                page,
              )
            : { items: [], total: 0, page },
        );
      case 'task': {
        const taskId = z
          .string()
          .regex(/^[1-9]\d*$/)
          .parse(query.get('task'));
        return jsonResponse({
          task: await projects.task(scope, project(), taskId),
          messages: await projects.messages(scope, project(), taskId),
        });
      }
      case 'drafts':
        return jsonResponse({
          drafts: query.get('project')
            ? await projects.drafts(scope, project())
            : [],
        });
      case 'runs':
        return jsonResponse({
          runs: query.get('project')
            ? await delivery.list(session, workspaceId, project())
            : [],
        });
      case 'run':
        return jsonResponse(
          await delivery.detail(
            session,
            workspaceId,
            uuid.parse(query.get('run')),
          ),
        );
      case 'profiles': {
        const profiles = await delivery.profiles(session, workspaceId);
        const channels = await modelChannels.available(scope);
        const configured = Object.values(profiles).every((profile) => {
          try {
            const reference = parseDeliveryChannelModel(profile.model);
            return reference
              ? channels.some(
                  (channel) =>
                    channel.id === reference.channelId &&
                    channel.version === reference.version &&
                    channel.enabled &&
                    channel.configured &&
                    channel.models.includes(reference.model),
                )
              : process.env.MODEL_CONFIGURED === 'true';
          } catch {
            return false;
          }
        });
        return jsonResponse({
          profiles,
          modelChannels: channels,
          model: {
            configured,
            name: process.env.MODEL_NAME ?? '',
          },
          execution: {
            configured:
              !!process.env.TANDEM_ARTIFACT_ROOT &&
              !!process.env.TANDEM_EXECUTION_IMAGE,
          },
        });
      }
      case 'capabilities':
        return jsonResponse(await capabilities.overview(scope));
      case 'capability-bindings':
        return jsonResponse(
          query.get('project')
            ? await capabilities.bindings(scope, project())
            : { skills: [], tools: [] },
        );
      case 'capability-usage':
        return jsonResponse({
          usage: query.get('project')
            ? await capabilities.usage(scope, project())
            : [],
        });
      default:
        return jsonResponse(
          { error: { code: 'INVALID_INPUT', message: '不支持的资源类型' } },
          400,
        );
    }
  });
}
export function POST(request: Request, context: Context) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const workspaceId = uuid.parse((await context.params).workspaceId);
    await collaboration().overview(session, workspaceId);
    const input = await body(request, productCommand, 1200000);
    const { projects, delivery, capabilities, scope } = productServices(
      session,
      workspaceId,
    );
    let result: unknown;
    switch (input.command) {
      case 'bind-project':
        result = await projects.bindProject(scope, input.externalId);
        break;
      case 'grant-project':
        await projects.grant(
          scope,
          input.projectId,
          input.identityId,
          input.canWrite ? 'editor' : 'viewer',
        );
        break;
      case 'revoke-project':
        await projects.grant(scope, input.projectId, input.identityId, null);
        break;
      case 'add-message':
        await projects.addMessage(
          scope,
          input.projectId,
          input.taskId,
          input.message,
        );
        break;
      case 'create-draft':
        result = await projects.createDraft(
          scope,
          session.id,
          input.projectId,
          input.title,
          input.action as ProjectDraftAction,
          input.requestId,
        );
        break;
      case 'revise-draft':
        result = await projects.reviseDraft(
          scope,
          input.draftId,
          input.version,
          input.title,
          input.action as ProjectDraftAction,
        );
        break;
      case 'review-draft':
        result = await projects.reviewDraft(
          scope,
          input.draftId,
          input.version,
          input.approve,
        );
        break;
      case 'start-run':
        result = await delivery.start(session, {
          workspaceId,
          projectId: input.projectId,
          goal: input.goal,
          acceptance: input.acceptance,
          mode: input.mode,
          budgetCalls: input.budgetCalls,
          budgetTokens: input.budgetTokens,
          maxRevisions: input.maxRevisions,
          requestId: input.requestId,
          ...(input.assignedRole ? { assignedRole: input.assignedRole } : {}),
        });
        break;
      case 'control-run':
        result = await delivery.control(
          session,
          workspaceId,
          input.runId,
          input.action,
        );
        break;
      case 'extend-budget':
        result = await delivery.extendBudget(
          session,
          workspaceId,
          input.runId,
          input.calls,
          input.tokens,
        );
        break;
      case 'reconcile-deployment':
        result = await delivery.reconcileDeployment(
          session,
          workspaceId,
          input.runId,
          input.draftId,
          executionAdapter(),
          input.confirmNotPublished,
        );
        break;
      case 'configure-team':
        await delivery.configure(session, workspaceId, input.profiles);
        break;
      case 'install-skill':
        result = await capabilities.installSkill(scope, input.bundle);
        break;
      case 'activate-skill':
        await capabilities.activateSkill(scope, input.skillId, input.versionId);
        break;
      case 'toggle-skill':
        await capabilities.setSkillEnabled(scope, input.skillId, input.enabled);
        break;
      case 'uninstall-skill':
        await capabilities.uninstallSkill(scope, input.skillId);
        break;
      case 'bind-skill':
        result = await capabilities.bindSkill(scope, input);
        break;
      case 'save-server':
        result = await capabilities.saveServer(scope, {
          name: input.name,
          connection: input.connection,
          ...(input.id ? { id: input.id } : {}),
          ...(input.expectedRevision
            ? { expectedRevision: input.expectedRevision }
            : {}),
        });
        break;
      case 'toggle-server':
        await capabilities.setServerEnabled(
          scope,
          input.serverId,
          input.enabled,
        );
        break;
      case 'remove-server':
        await capabilities.removeServer(scope, input.serverId);
        break;
      case 'test-server':
        result = await capabilities.testServer(scope, input.serverId);
        break;
      case 'server-credential':
        await capabilities.setCredential(
          scope,
          input.serverId,
          input.credential,
        );
        break;
      case 'grant-tool':
        result = await capabilities.grantTool(scope, input);
        break;
      case 'call-tool': {
        result = await capabilities.callTool(scope, input);
        if (
          result &&
          typeof result === 'object' &&
          'kind' in result &&
          result.kind === 'proposal' &&
          'proposal' in result
        ) {
          const draft = await projects.createDraft(
            scope,
            session.id,
            input.projectId,
            `工具写入：${input.toolName}`,
            result.proposal as ProjectDraftAction,
            input.requestId,
          );
          result = { kind: 'proposal', draft };
        }
        break;
      }
    }
    return jsonResponse(result ?? { ok: true });
  });
}
