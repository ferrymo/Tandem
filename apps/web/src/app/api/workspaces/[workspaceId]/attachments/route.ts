import { DomainError } from '@tandem/core';
import { collaboration } from '../../../../../server/collaboration';
import {
  assertSameOrigin,
  handle,
  requireSession,
  uuid,
} from '../../../../../server/collaboration-http';
import { jsonResponse } from '../../../../../server/http';
import {
  attachmentStore,
  workManagement,
} from '../../../../../server/work-management';
import {
  attachmentForm,
  attachmentName,
  attachmentOwner,
} from '../../../../../server/work-management-http';

type Context = { params: Promise<{ workspaceId: string }> };

export function POST(request: Request, context: Context) {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const workspaceId = uuid.parse((await context.params).workspaceId);
    await collaboration().overview(session, workspaceId);
    const form = await attachmentForm(request);
    const file = form.get('file');
    if (
      !(file instanceof File) ||
      file.size < 1 ||
      file.size > 20 * 1024 * 1024
    )
      throw new DomainError('INVALID_INPUT', '请选择 1 字节至 20 MB 的附件');
    const owner = attachmentOwner.parse(
      Object.fromEntries(
        ['projectId', 'taskId', 'documentId']
          .filter((key) => Boolean(form.get(key)))
          .map((key) => [key, form.get(key)]),
      ),
    );
    const name = attachmentName(file.name);
    const store = attachmentStore();
    const storageKey = await store.put(
      new Uint8Array(await file.arrayBuffer()),
    );
    try {
      const attachment = await workManagement().createAttachment(
        session,
        workspaceId,
        {
          projectId: owner.projectId ?? null,
          taskId: owner.taskId ?? null,
          documentId: owner.documentId ?? null,
          name,
          mime: 'application/octet-stream',
          size: file.size,
          storageKey,
        },
      );
      return jsonResponse(attachment, 201);
    } catch (error) {
      await store.remove(storageKey);
      throw error;
    }
  });
}
