import { collaboration } from '../../../../server/collaboration';
import {
  handle,
  requireSession,
  uuid,
} from '../../../../server/collaboration-http';
import { jsonResponse } from '../../../../server/http';

export function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  return handle(async () => {
    const session = await requireSession();
    const workspaceId = uuid.parse((await context.params).workspaceId);
    return jsonResponse(await collaboration().overview(session, workspaceId));
  });
}
