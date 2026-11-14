import type { ResourceScope } from './index';
import type { WorkModelChannel } from './work-management';

export type WorkCredentialKind = 'model-channel' | 'connector';
export type WorkCredentialValues = {
  apiKey?: string;
  account?: string;
  apiPassword?: string;
  databasePassword?: string;
};
export type WorkCredentialState = {
  kind: WorkCredentialKind;
  id: string;
  configured: boolean;
  fields: string[];
  updatedAt: string;
};
export interface WorkCredentialRepository {
  states(scope: ResourceScope): Promise<WorkCredentialState[]>;
  read(
    scope: ResourceScope,
    kind: WorkCredentialKind,
    id: string,
  ): Promise<{ encryptedValues: string; fields: string[] } | null>;
  save(
    scope: ResourceScope,
    kind: WorkCredentialKind,
    id: string,
    input: {
      encryptedValues: string;
      fields: string[];
      expectedEncryptedValues: string | null;
    },
  ): Promise<void>;
  modelChannel(scope: ResourceScope, id: string): Promise<WorkModelChannel>;
}
export interface WorkCredentialCodec {
  seal(value: string, context: string): string;
  open(value: string, context: string): string;
}
export interface WorkModelConnection {
  test(
    channel: WorkModelChannel,
    credential: string,
    model: string,
  ): Promise<{
    checkedAt: string;
    latencyMs: number;
    model: string;
    protocol: string;
  }>;
}
