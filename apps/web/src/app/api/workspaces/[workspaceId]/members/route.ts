import { z } from 'zod';
import { collaboration } from '../../../../../server/collaboration';
import {
  assertSameOrigin,
  body,
  handle,
  requireSession,
  uuid,
} from '../../../../../server/collaboration-http';
import { jsonResponse } from '../../../../../server/http';

type Context = { params: Promise<{ workspaceId: string }> };
export function GET(_request: Request, context: Context) {
  return handle(async () => {
    const session = await requireSession();
    const workspaceId = uuid.parse((await context.params).workspaceId);
    return jsonResponse({
      members: await collaboration().members(session, workspaceId),
    });
  });
}
export function POST(request: Request, context: Context) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const workspaceId = uuid.parse((await context.params).workspaceId);
    const { identityId, role } = await body(
      request,
      z
        .object({ identityId: uuid, role: z.enum(['admin', 'member']) })
        .strict(),
    );
    await collaboration().setMember(session, workspaceId, identityId, role);
    return jsonResponse({ ok: true });
  });
}
