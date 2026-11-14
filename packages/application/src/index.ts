import { DomainError } from '@tandem/core';
export * from './collaboration';
export * from './capabilities';
export * from './projects';
export * from './work-management';
export * from './work-secrets';
export * from './connector-read';
import type { AuthorizationPort, ReadinessPort } from '@tandem/core';
// Missing identity providers must never silently grant development access.
export const denyAllAuthorization: AuthorizationPort = {
  async assertAllowed() {
    throw new DomainError('FORBIDDEN', '身份与资源授权尚未配置');
  },
};
export async function checkReadiness(
  database: ReadinessPort,
): Promise<{ status: 'ready' | 'unavailable' }> {
  try {
    return { status: (await database.check()) ? 'ready' : 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}
export * from './delivery';
