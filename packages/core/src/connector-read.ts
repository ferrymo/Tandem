import type { ResourceScope } from './index';
import type { WorkConnector } from './work-management';
import type { WorkCredentialState } from './work-secrets';

export type ConnectorCredentials = {
  account: string;
  apiPassword: string;
  databasePassword: string;
};
export type ConnectorAuthorization = {
  encryptedValues: string;
  configurationVersion: number;
  version: number;
};
export interface ConnectorAuthorizationRepository {
  configuration(scope: ResourceScope, id: string): Promise<WorkConnector>;
  authorization(
    scope: ResourceScope,
    id: string,
  ): Promise<ConnectorAuthorization | null>;
  save(
    scope: ResourceScope,
    id: string,
    value: {
      encryptedValues: string;
      configurationVersion: number;
      expectedVersion: number | null;
    },
  ): Promise<void>;
  states(scope: ResourceScope): Promise<WorkCredentialState[]>;
}
export type ConnectorDatabaseEvidence = {
  readOnly: true;
  serverVersion: string;
  principal: string;
  accessibleTables: string[];
};
export type ConnectorTestResult = {
  ok: true;
  checkedAt: string;
  database: ConnectorDatabaseEvidence;
  authorization: {
    account: string;
    visibleProjects: number;
    projectsTruncated: boolean;
  };
};
export type ConnectorExternalProject = {
  id: string;
  name: string;
  status: string;
};
export type ConnectorExternalTask = {
  id: string;
  projectId: string;
  name: string;
  status: string;
  assignee: string;
  moduleId: string | null;
  estimatedHours: number | null;
  consumedHours: number | null;
  remainingHours: number | null;
  deadline: string | null;
};
export type ConnectorReadResult = {
  kind: 'external-read';
  source: 'zentao';
  connectorId: string;
  checkedAt: string;
  expiresAt: string;
  projects: ConnectorExternalProject[];
  tasks: ConnectorExternalTask[];
  tasksLoaded: boolean;
  truncated: boolean;
};
export interface ConnectorReadPort {
  test(
    configuration: WorkConnector,
    credentials: ConnectorCredentials,
  ): Promise<ConnectorTestResult>;
  read(
    configuration: WorkConnector,
    credentials: ConnectorCredentials,
    options: { projectId?: string; limit: number },
  ): Promise<ConnectorReadResult>;
}
