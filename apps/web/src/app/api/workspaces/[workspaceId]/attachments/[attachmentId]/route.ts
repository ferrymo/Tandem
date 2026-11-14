import { safeErrorCode } from '@tandem/platform';
import {
  authLogger,
  collaboration,
} from '../../../../../../server/collaboration';
import {
  assertSameOrigin,
  handle,
  requireSession,
  uuid,
} from '../../../../../../server/collaboration-http';
import { jsonResponse } from '../../../../../../server/http';
import {
  attachmentStore,
  workManagement,
} from '../../../../../../server/work-management';
import { attachmentDisposition } from '../../../../../../server/work-management-http';

type Context = {
  params: Promise<{ workspaceId: string; attachmentId: string }>;
};

export function GET(_request: Request, context: Context) {
  return handle(async () => {
    const session = await requireSession();
    const params = await context.params;
    const workspaceId = uuid.parse(params.workspaceId);
    const id = uuid.parse(params.attachmentId);
    await collaboration().overview(session, workspaceId);
    const attachment = await workManagement().attachment(
      session,
      workspaceId,
      id,
    );
    const bytes = await attachmentStore().read(
      attachment.storageKey,
      attachment.size,
    );
    return new Response(Buffer.from(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': attachmentDisposition(attachment.name),
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Referrer-Policy': 'no-referrer',
      },
    });
  });
}

export function DELETE(request: Request, context: Context) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const params = await context.params;
    const workspaceId = uuid.parse(params.workspaceId);
    const id = uuid.parse(params.attachmentId);
    await collaboration().overview(session, workspaceId);
    const service = workManagement();
    const attachment = await service.attachment(session, workspaceId, id);
    await service.deleteAttachment(session, workspaceId, id);
    try {
      await attachmentStore().remove(attachment.storageKey);
    } catch (error) {
      authLogger.error(
        { code: safeErrorCode(error), attachmentId: id },
        '附件引用已删除，文件清理失败，需要存储维护',
      );
    }
    return jsonResponse({ ok: true });
  });
}
