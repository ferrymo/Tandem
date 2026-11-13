import { z } from 'zod';
import { collaboration } from '../../../server/collaboration';
import {
  assertSameOrigin,
  body,
  handle,
  requireSession,
  uuid,
} from '../../../server/collaboration-http';
import { jsonResponse } from '../../../server/http';

export function GET() {
  return handle(async () => {
    const session = await requireSession();
    return jsonResponse({
      workspaces: await collaboration().listWorkspaces(session),
    });
  });
}
export function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const input = await body(
      request,
      z
        .object({ name: z.string().trim().min(1).max(120), requestId: uuid })
        .strict(),
    );
    const workspace = await collaboration().createWorkspace(
      session,
      input.name,
      input.requestId,
    );
    return jsonResponse({ workspace }, 201);
  });
}
