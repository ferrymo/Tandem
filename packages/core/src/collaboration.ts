export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type Identity = Readonly<{
  id: string;
  providerId: string;
  subject: string;
  displayName: string;
  canCreateWorkspace: boolean;
}>;
export type VerifiedLogin = Readonly<{
  providerId: string;
  subject: string;
  displayName: string;
  canCreateWorkspace: boolean;
  accessToken: string;
}>;
export interface IdentityProvider {
  readonly id: string;
  readonly label: string;
  authenticate(account: string, password: string): Promise<VerifiedLogin>;
  verify(
    accessToken: string,
    subject: string,
  ): Promise<Omit<VerifiedLogin, 'accessToken'>>;
}
export type StoredSession = Readonly<{
  id: string;
  identity: Identity;
  encryptedCredential: string;
  expiresAt: string;
}>;
export type WorkspaceSummary = Readonly<{
  id: string;
  name: string;
  role: WorkspaceRole;
}>;
export type AgentRole = 'designer' | 'architect' | 'engineer';
export type TeamOverview = Readonly<{
  id: string;
  name: string;
  templateVersion: number;
  ownerId: string;
  ownerDisplayName: string;
  agents: readonly {
    id: string;
    role: AgentRole;
    name: string;
    description: string;
  }[];
}>;
export type WorkspaceMember = Readonly<{
  identityId: string;
  displayName: string;
  role: WorkspaceRole;
}>;
export interface CollaborationRepository {
  createSession(input: {
    login: Omit<VerifiedLogin, 'accessToken'>;
    tokenHash: string;
    encryptedCredential: string;
    expiresAt: string;
  }): Promise<StoredSession>;
  session(tokenHash: string): Promise<StoredSession | null>;
  refreshIdentity(
    identityId: string,
    login: Omit<VerifiedLogin, 'accessToken'>,
  ): Promise<void>;
  revokeSession(tokenHash: string): Promise<void>;
  listWorkspaces(actorId: string): Promise<readonly WorkspaceSummary[]>;
  createWorkspace(
    actorId: string,
    name: string,
    requestId: string,
  ): Promise<WorkspaceSummary>;
  overview(
    actorId: string,
    workspaceId: string,
  ): Promise<{
    workspace: WorkspaceSummary;
    team: TeamOverview;
  }>;
  members(
    actorId: string,
    workspaceId: string,
  ): Promise<readonly WorkspaceMember[]>;
  setMember(
    actorId: string,
    workspaceId: string,
    identityId: string,
    role: 'admin' | 'member',
  ): Promise<void>;
  removeMember(
    actorId: string,
    workspaceId: string,
    identityId: string,
  ): Promise<void>;
}
