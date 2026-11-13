import { z } from 'zod';
import { DomainError } from '@tandem/core';
import { LoginLimiter } from '@tandem/platform';
import {
  collaboration,
  collaborationConfig,
  publicUser,
  revokeLocalSession,
} from '../../../server/collaboration';
import {
  assertSameOrigin,
  body,
  clearSessionCookie,
  handle,
  sessionToken,
  writeSessionCookie,
} from '../../../server/collaboration-http';
import { jsonResponse } from '../../../server/http';

export const dynamic = 'force-dynamic';
const limiter = new LoginLimiter();
export function GET() {
  return handle(async () => {
    const config = collaborationConfig();
    const configured = Boolean(
      config.TANDEM_IDENTITY_URL && config.SESSION_ENCRYPTION_KEY,
    );
    const token = await sessionToken();
    const session =
      configured && token ? await collaboration().authenticate(token) : null;
    if (token && !session) await clearSessionCookie();
    return jsonResponse({
      user: publicUser(session),
      login: { configured, label: '协作账号' },
    });
  });
}
export function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const { account, password } = await body(
      request,
      z
        .object({
          account: z.string().trim().min(1).max(200),
          password: z.string().min(1).max(1024),
        })
        .strict(),
    );
    const release = limiter.acquire(account);
    if (!release)
      throw new DomainError('RATE_LIMITED', '登录尝试过于频繁，请一分钟后重试');
    try {
      let result;
      try {
        result = await collaboration().login(account, password);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'FORBIDDEN')
          throw new DomainError(
            'UNAUTHENTICATED',
            '账号验证失败，请检查账号、密码或授权状态',
          );
        throw error;
      }
      await collaboration().logout(await sessionToken());
      await writeSessionCookie(result.token, result.session.expiresAt);
      return jsonResponse({ user: publicUser(result.session) });
    } finally {
      release();
    }
  });
}
export function DELETE(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const token = await sessionToken();
    // Local logout remains available during an upstream outage or configuration change.
    await revokeLocalSession(token);
    await clearSessionCookie();
    return jsonResponse({ ok: true });
  });
}
