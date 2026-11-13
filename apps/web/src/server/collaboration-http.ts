import { cookies } from 'next/headers';
import { z } from 'zod';
import { DomainError } from '@tandem/core';
import { safeErrorCode } from '@tandem/platform';
import { jsonResponse } from './http';
import {
  authLogger,
  collaboration,
  collaborationConfig,
} from './collaboration';

export const uuid = z.uuid();
export const sessionCookieName = () =>
  new URL(collaborationConfig().TANDEM_PUBLIC_URL).protocol === 'https:'
    ? '__Host-tandem_session'
    : 'tandem_session';
export async function sessionToken() {
  return (await cookies()).get(sessionCookieName())?.value;
}
export async function requireSession() {
  const session = await collaboration().authenticate(await sessionToken());
  if (!session)
    throw new DomainError('UNAUTHENTICATED', '会话已失效，请重新登录');
  return session;
}
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = new URL(collaborationConfig().TANDEM_PUBLIC_URL).origin;
  if (
    origin !== expected ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    throw new DomainError('FORBIDDEN', '请求来源不被允许，请从本站重新操作');
}
export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 8192,
): Promise<T> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new DomainError('INVALID_INPUT', '请提交 JSON 格式的数据');
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError('INVALID_INPUT', '缺少请求内容');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new DomainError('INVALID_INPUT', '请求内容过长');
      }
      chunks.push(value);
    }
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('INVALID_INPUT', '请求参数无效，请检查后重试');
  } finally {
    reader.releaseLock();
  }
}
export function handle(work: () => Promise<Response>) {
  return work().catch((error: unknown) => {
    if (error instanceof DomainError) {
      const status = {
        UNAUTHENTICATED: 401,
        FORBIDDEN: 403,
        INVALID_INPUT: 400,
        CONFLICT: 409,
        UNAVAILABLE: 503,
        RATE_LIMITED: 429,
      }[error.code];
      const response = jsonResponse(
        { error: { code: error.code, message: error.message } },
        status,
      );
      if (status === 429) response.headers.set('Retry-After', '60');
      return response;
    }
    if (error instanceof z.ZodError)
      return jsonResponse(
        {
          error: {
            code: 'INVALID_INPUT',
            message: '请求参数无效，请检查后重试',
          },
        },
        400,
      );
    authLogger.error({ code: safeErrorCode(error) }, '协作请求失败');
    return jsonResponse(
      { error: { code: 'UNAVAILABLE', message: '服务暂不可用，请稍后重试' } },
      503,
    );
  });
}
export async function writeSessionCookie(token: string, expiresAt: string) {
  (await cookies()).set(sessionCookieName(), token, {
    httpOnly: true,
    secure:
      new URL(collaborationConfig().TANDEM_PUBLIC_URL).protocol === 'https:',
    sameSite: 'strict',
    path: '/',
    expires: new Date(expiresAt),
  });
}
export async function clearSessionCookie() {
  (await cookies()).set(sessionCookieName(), '', {
    httpOnly: true,
    secure:
      new URL(collaborationConfig().TANDEM_PUBLIC_URL).protocol === 'https:',
    sameSite: 'strict',
    path: '/',
    expires: new Date(0),
  });
}
