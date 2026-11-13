import { CollaborationService } from '@tandem/application';
import { DomainError } from '@tandem/core';
import {
  createLogger,
  createSessionCodec,
  readCollaborationEnv,
} from '@tandem/platform';
import { PostgresCollaborationRepository } from '@tandem/storage-postgres';
import { ZentaoIdentityProvider } from '@tandem/zentao';
import { database } from './database';
import { createHash } from 'node:crypto';

let service: CollaborationService | undefined;
export const collaborationConfig = () => readCollaborationEnv();
export function collaboration() {
  if (service) return service;
  const config = collaborationConfig();
  if (!config.TANDEM_IDENTITY_URL || !config.SESSION_ENCRYPTION_KEY)
    throw new DomainError('UNAVAILABLE', '尚未配置身份连接，请联系部署管理员');
  service = new CollaborationService(
    new PostgresCollaborationRepository(database()),
    new ZentaoIdentityProvider({
      // Changing the upstream instance cannot inherit memberships for coincident IDs.
      id: identityProviderId(
        config.TANDEM_IDENTITY_ID,
        config.TANDEM_IDENTITY_URL,
      ),
      label: config.TANDEM_IDENTITY_LABEL,
      baseUrl: config.TANDEM_IDENTITY_URL,
      commanderAccounts: config.TANDEM_COMMANDER_ACCOUNTS,
      allowInsecureHttp: config.TANDEM_IDENTITY_ALLOW_HTTP,
    }),
    createSessionCodec(config.SESSION_ENCRYPTION_KEY),
  );
  return service;
}
export const authLogger = createLogger('collaboration');
export function identityProviderId(id: string, address: string) {
  const url = new URL(address);
  url.pathname =
    url.pathname.replace(/\/+$/, '').replace(/\/api\.php\/v1$/, '') || '/';
  return (
    id +
    ':' +
    createHash('sha256').update(url.toString()).digest('hex').slice(0, 32)
  );
}
export async function revokeLocalSession(token: string | undefined) {
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token))
    await new PostgresCollaborationRepository(database()).revokeSession(
      createHash('sha256').update(token).digest('hex'),
    );
}
export function publicUser(
  session: Awaited<ReturnType<CollaborationService['authenticate']>>,
) {
  if (!session) return null;
  const { id, displayName, canCreateWorkspace } = session.identity;
  return { id, displayName, canCreateWorkspace };
}
