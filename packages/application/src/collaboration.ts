import { DomainError } from '@tandem/core';
import type {
  CollaborationRepository,
  IdentityProvider,
  StoredSession,
} from '@tandem/core';

export interface SessionCodec {
  token(): string;
  hash(token: string): string;
  seal(value: string, context: string): string;
  open(value: string, context: string): string;
}

/** A verified upstream identity is required even for workspace initialization. */
export class CollaborationService {
  constructor(
    private readonly repository: CollaborationRepository,
    private readonly provider: IdentityProvider,
    private readonly codec: SessionCodec,
    private readonly now: () => number = Date.now,
  ) {}

  async login(account: string, password: string) {
    if (
      !account.trim() ||
      !password ||
      account.length > 200 ||
      password.length > 1024
    )
      throw new DomainError('INVALID_INPUT', '请填写有效的账号和密码');
    const login = await this.provider.authenticate(account.trim(), password);
    if (
      login.providerId !== this.provider.id ||
      !login.subject ||
      !login.accessToken
    )
      throw new DomainError('FORBIDDEN', '身份连接未返回有效身份');
    const token = this.codec.token();
    const { accessToken, ...identity } = login;
    const session = await this.repository.createSession({
      login: identity,
      tokenHash: this.codec.hash(token),
      encryptedCredential: this.codec.seal(
        accessToken,
        login.providerId + ':' + login.subject,
      ),
      expiresAt: new Date(this.now() + 8 * 60 * 60 * 1000).toISOString(),
    });
    return { token, session };
  }

  async authenticate(token: string | undefined): Promise<StoredSession | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = this.codec.hash(token);
    const session = await this.repository.session(hash);
    if (!session) return null;
    if (
      session.identity.providerId !== this.provider.id ||
      Date.parse(session.expiresAt) <= this.now()
    ) {
      await this.repository.revokeSession(hash);
      return null;
    }
    let credential: string;
    try {
      credential = this.codec.open(
        session.encryptedCredential,
        session.identity.providerId + ':' + session.identity.subject,
      );
    } catch {
      await this.repository.revokeSession(hash);
      return null;
    }
    try {
      const verified = await this.provider.verify(
        credential,
        session.identity.subject,
      );
      if (
        verified.providerId !== session.identity.providerId ||
        verified.subject !== session.identity.subject
      )
        throw new DomainError('FORBIDDEN', '账号身份已变化，请重新登录');
      await this.repository.refreshIdentity(session.identity.id, verified);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'FORBIDDEN') {
        await this.repository.revokeSession(hash);
        return null;
      }
      throw new DomainError('UNAVAILABLE', '暂时无法核验协作账号，请稍后重试');
    }
    // A concurrent sign-out/revocation must also win over in-flight verification.
    return this.repository.session(hash);
  }

  async logout(token: string | undefined) {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token))
      await this.repository.revokeSession(this.codec.hash(token));
  }

  listWorkspaces(session: StoredSession) {
    return this.repository.listWorkspaces(session.identity.id);
  }

  async createWorkspace(
    session: StoredSession,
    name: string,
    requestId: string,
  ) {
    if (!session.identity.canCreateWorkspace)
      throw new DomainError('FORBIDDEN', '当前账号没有创建工作空间的权限');
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 120)
      throw new DomainError('INVALID_INPUT', '工作空间名称须为 1–120 个字符');
    return this.repository.createWorkspace(
      session.identity.id,
      cleanName,
      requestId,
    );
  }

  overview(session: StoredSession, workspaceId: string) {
    return this.repository.overview(session.identity.id, workspaceId);
  }

  members(session: StoredSession, workspaceId: string) {
    return this.repository.members(session.identity.id, workspaceId);
  }

  setMember(
    session: StoredSession,
    workspaceId: string,
    identityId: string,
    role: 'admin' | 'member',
  ) {
    return this.repository.setMember(
      session.identity.id,
      workspaceId,
      identityId,
      role,
    );
  }

  removeMember(
    session: StoredSession,
    workspaceId: string,
    identityId: string,
  ) {
    return this.repository.removeMember(
      session.identity.id,
      workspaceId,
      identityId,
    );
  }
}
