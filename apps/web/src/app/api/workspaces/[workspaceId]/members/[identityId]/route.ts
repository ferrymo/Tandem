import { collaboration } from '../../../../../../server/collaboration';
import {
  assertSameOrigin,
  handle,
  requireSession,
  uuid,
} from '../../../../../../server/collaboration-http';
import { jsonResponse } from '../../../../../../server/http';

export function DELETE(
  request: Request,
  context: { params: Promise<{ workspaceId: string; identityId: string }> },
) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const params = await context.params;
    await collaboration().removeMember(
      session,
      uuid.parse(params.workspaceId),
      uuid.parse(params.identityId),
    );
    return jsonResponse({ ok: true });
  });
}
