import { collaboration } from '../../../../../server/collaboration';
import {
  assertSameOrigin,
  body,
  handle,
  requireSession,
  uuid,
} from '../../../../../server/collaboration-http';
import { jsonResponse } from '../../../../../server/http';
import {
  workCredentials,
  workManagement,
  connectorReads,
} from '../../../../../server/work-management';
import { managementCommand } from '../../../../../server/work-management-http';

type Context = { params: Promise<{ workspaceId: string }> };

export function GET(_request: Request, context: Context) {
  return handle(async () => {
    const session = await requireSession();
    const workspaceId = uuid.parse((await context.params).workspaceId);
    await collaboration().overview(session, workspaceId);
    const snapshot = await workManagement().snapshot(session, workspaceId);
    const modelStates = (
      await workCredentials().states(session, workspaceId)
    ).filter((state) => state.kind === 'model-channel');
    const connectorStates = await connectorReads().states(session, workspaceId);
    const secretStates = [...modelStates, ...connectorStates];
    return jsonResponse({ ...snapshot, secretStates });
  });
}

export function POST(request: Request, context: Context) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const workspaceId = uuid.parse((await context.params).workspaceId);
    await collaboration().overview(session, workspaceId);
    const input = await body(request, managementCommand, 2 * 1024 * 1024);
    if (input.command === 'set-credential') {
      if (input.kind === 'connector')
        return jsonResponse(
          await connectorReads().save(
            session,
            workspaceId,
            input.id,
            input.values,
          ),
        );
      return jsonResponse(
        await workCredentials().save(session, workspaceId, {
          kind: input.kind,
          id: input.id,
          values: input.values,
        }),
      );
    }
    if (input.command === 'test-model-channel') {
      return jsonResponse(
        await workCredentials().testModel(
          session,
          workspaceId,
          input.id,
          input.model,
        ),
      );
    }
    if (input.command === 'test-connector')
      return jsonResponse(
        await connectorReads().test(session, workspaceId, input.id),
      );
    if (input.command === 'read-connector')
      return jsonResponse(
        await connectorReads().read(session, workspaceId, input.id, {
          projectId: input.projectId,
          limit: input.limit,
        }),
      );
    return jsonResponse(
      await workManagement().execute(session, workspaceId, input),
    );
  });
}
