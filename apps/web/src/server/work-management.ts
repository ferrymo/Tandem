import { resolve } from 'node:path';
import {
  WorkCredentialsService,
  WorkManagementService,
  ConnectorReadService,
} from '@tandem/application';
import { DomainError } from '@tandem/core';
import { LocalAttachmentStore } from '@tandem/execution';
import { ProtocolModelConnection } from '@tandem/model';
import { createSessionCodec } from '@tandem/platform';
import {
  PostgresWorkCredentialRepository,
  PostgresWorkManagementRepository,
  PostgresConnectorAuthorizationRepository,
} from '@tandem/storage-postgres';
import { collaborationConfig } from './collaboration';
import { database } from './database';
import { ZentaoReadOnlyDatabase } from '@tandem/zentao';

export function workManagement() {
  return new WorkManagementService(
    new PostgresWorkManagementRepository(database()),
  );
}

export function attachmentStore() {
  return new LocalAttachmentStore(
    resolve(
      /* turbopackIgnore: true */ process.env.TANDEM_ATTACHMENT_ROOT ??
        'data/attachments',
    ),
  );
}

export function workCredentials() {
  const key = collaborationConfig().SESSION_ENCRYPTION_KEY;
  if (!key) throw new DomainError('UNAVAILABLE', '凭证加密尚未配置');
  return new WorkCredentialsService(
    new PostgresWorkCredentialRepository(database()),
    createSessionCodec(key),
    new ProtocolModelConnection({
      allowedOrigins: (process.env.MODEL_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      allowHttp: process.env.MODEL_ALLOW_HTTP === 'true',
    }),
  );
}

export function connectorReads() {
  const key = collaborationConfig().SESSION_ENCRYPTION_KEY;
  if (!key) throw new DomainError('UNAVAILABLE', '凭证加密尚未配置');
  const list = (name: string) =>
    (process.env[name] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  return new ConnectorReadService(
    new PostgresConnectorAuthorizationRepository(database()),
    createSessionCodec(key),
    new ZentaoReadOnlyDatabase({
      allowedOrigins: list('TANDEM_CONNECTOR_ALLOWED_ORIGINS'),
      allowedDatabaseHosts: list('TANDEM_CONNECTOR_DB_HOSTS'),
      allowHttp: process.env.TANDEM_CONNECTOR_ALLOW_HTTP === 'true',
      databaseTls: process.env.TANDEM_CONNECTOR_MYSQL_TLS === 'true',
    }),
  );
}
