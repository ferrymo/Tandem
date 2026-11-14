import { z } from 'zod';
import { DomainError } from '@tandem/core';

export const managementCommand = z
  .object({ command: z.string().min(1).max(80) })
  .catchall(z.unknown());

export const attachmentOwner = z
  .object({
    projectId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    documentId: z.uuid().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.taskId) !== Boolean(value.documentId), {
    message: '请选择附件所属的任务或文档',
  });

const maxUploadBytes = 20 * 1024 * 1024 + 64 * 1024;

/** Bound multipart bytes before parsing, including requests without Content-Length. */
export async function attachmentForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type');
  if (!contentType?.startsWith('multipart/form-data;'))
    throw new DomainError('INVALID_INPUT', '请使用文件上传表单');
  const length = request.headers.get('content-length');
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > maxUploadBytes)
  )
    throw new DomainError('INVALID_INPUT', '附件不能超过 20 MB');
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError('INVALID_INPUT', '请选择要上传的附件');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxUploadBytes) {
        await reader.cancel();
        throw new DomainError('INVALID_INPUT', '附件不能超过 20 MB');
      }
      chunks.push(value);
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'Content-Type': contentType },
    }).formData();
    const keys: string[] = [];
    form.forEach((_value, key) => keys.push(key));
    if (
      keys.some(
        (key) => !['file', 'projectId', 'taskId', 'documentId'].includes(key),
      ) ||
      new Set(keys).size !== keys.length
    )
      throw new DomainError(
        'INVALID_INPUT',
        '请仅上传一个文件并指定所属任务或文档',
      );
    return form;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_INPUT', '上传内容无效，请重新选择附件');
  } finally {
    reader.releaseLock();
  }
}

export function attachmentName(name: string): string {
  const clean = Array.from(name, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === '/' || character === '\\'
      ? '_'
      : character;
  })
    .join('')
    .trim();
  if (!clean || clean.length > 240 || clean === '.' || clean === '..')
    throw new DomainError('INVALID_INPUT', '附件文件名须为 1–240 个字符');
  return clean;
}

export function attachmentDisposition(name: string) {
  const encoded = encodeURIComponent(attachmentName(name)).replace(
    /['()*]/g,
    (value) => '%' + value.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="attachment"; filename*=UTF-8''${encoded}`;
}
