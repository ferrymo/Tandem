import { DomainError } from '@tandem/core';
import type {
  ConnectorAuthorizationRepository,
  ConnectorCredentials,
  ConnectorReadPort,
  StoredSession,
  WorkCredentialCodec,
} from '@tandem/core';

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export class ConnectorReadService {
  constructor(
    private readonly repository: ConnectorAuthorizationRepository,
    private readonly codec: WorkCredentialCodec,
    private readonly adapter: ConnectorReadPort,
  ) {}
  private scope(
    session: StoredSession,
    workspaceId: string,
    ...ids: unknown[]
  ) {
    if (
      !uuid.test(workspaceId) ||
      ids.some((id) => typeof id !== 'string' || !uuid.test(id))
    )
      throw new DomainError('INVALID_INPUT', '连接器或工作空间标识无效');
    return { workspaceId, actorId: session.identity.id };
  }
  private context(
    workspaceId: string,
    id: string,
    actorId: string,
    version: number,
  ) {
    return `connector-credential:${workspaceId}:${id}:${actorId}:${version}`;
  }
  private decode(value: string, context: string): ConnectorCredentials {
    try {
      const parsed = JSON.parse(
        this.codec.open(value, context),
      ) as ConnectorCredentials;
      if (
        !parsed ||
        !['account', 'apiPassword', 'databasePassword'].every(
          (key) =>
            typeof parsed[key as keyof ConnectorCredentials] === 'string' &&
            Boolean(parsed[key as keyof ConnectorCredentials]),
        )
      )
        throw new Error();
      return parsed;
    } catch {
      throw new DomainError(
        'UNAVAILABLE',
        '本人的连接凭据无法解密，请重新保存授权',
      );
    }
  }
  states(session: StoredSession, workspaceId: string) {
    return this.repository.states(this.scope(session, workspaceId));
  }
  async save(
    session: StoredSession,
    workspaceId: string,
    id: unknown,
    values: unknown,
  ) {
    const scope = this.scope(session, workspaceId, id);
    const target = id as string;
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new DomainError('INVALID_INPUT', '请填写本人的连接账号和密码');
    const input = values as Record<string, unknown>;
    const allowed = ['account', 'apiPassword', 'databasePassword'];
    if (
      !Object.keys(input).length ||
      Object.keys(input).some(
        (key) =>
          !allowed.includes(key) ||
          typeof input[key] !== 'string' ||
          !(input[key] as string).length ||
          (input[key] as string).length > 4096,
      )
    )
      throw new DomainError(
        'INVALID_INPUT',
        '连接授权字段无效，留空表示保留本人的原值',
      );
    const config = await this.repository.configuration(scope, target);
    const previous = await this.repository.authorization(scope, target);
    const context = this.context(
      workspaceId,
      target,
      session.identity.id,
      config.version,
    );
    const old =
      previous?.configurationVersion === config.version
        ? this.decode(previous.encryptedValues, context)
        : {};
    const merged = { ...old, ...input } as ConnectorCredentials;
    if (
      !allowed.every(
        (key) =>
          typeof merged[key as keyof ConnectorCredentials] === 'string' &&
          Boolean(merged[key as keyof ConnectorCredentials]),
      )
    )
      throw new DomainError(
        'INVALID_INPUT',
        '首次授权或连接配置变更后，请填写本人禅道账号、账号密码和数据库只读密码',
      );
    await this.repository.save(scope, target, {
      configurationVersion: config.version,
      encryptedValues: this.codec.seal(JSON.stringify(merged), context),
      expectedVersion: previous?.version ?? null,
    });
    return { configured: true };
  }
  private async authorized(
    session: StoredSession,
    workspaceId: string,
    id: unknown,
  ) {
    const scope = this.scope(session, workspaceId, id),
      target = id as string;
    const config = await this.repository.configuration(scope, target),
      authorization = await this.repository.authorization(scope, target);
    if (!authorization)
      throw new DomainError(
        'CONFLICT',
        '请先保存本人的禅道账号及数据库只读授权',
      );
    if (authorization.configurationVersion !== config.version)
      throw new DomainError(
        'CONFLICT',
        '连接配置已更改，请重新保存本人授权，旧账号不能沿用到新站点',
      );
    const credentials = this.decode(
      authorization.encryptedValues,
      this.context(workspaceId, target, session.identity.id, config.version),
    );
    return {
      scope,
      target,
      config,
      credentials,
      authorizationVersion: authorization.version,
    };
  }
  async test(session: StoredSession, workspaceId: string, id: unknown) {
    const auth = await this.authorized(session, workspaceId, id);
    const result = await this.adapter.test(auth.config, auth.credentials);
    const current = await this.repository.configuration(
      auth.scope,
      auth.target,
    );
    const authorization = await this.repository.authorization(
      auth.scope,
      auth.target,
    );
    if (
      current.version !== auth.config.version ||
      current.enabled !== auth.config.enabled ||
      authorization?.version !== auth.authorizationVersion
    )
      throw new DomainError(
        'CONFLICT',
        '验证期间连接配置或本人授权已改变，请重新验证',
      );
    return result;
  }
  async read(
    session: StoredSession,
    workspaceId: string,
    id: unknown,
    options: { projectId?: unknown; limit?: unknown },
  ) {
    const auth = await this.authorized(session, workspaceId, id);
    if (!auth.config.enabled)
      throw new DomainError('CONFLICT', '请先启用此连接器，再读取外部数据');
    const projectId = options.projectId;
    if (
      projectId !== undefined &&
      (typeof projectId !== 'string' || !/^\d{1,20}$/.test(projectId))
    )
      throw new DomainError('INVALID_INPUT', '外部项目标识无效');
    const limit = options.limit ?? 100;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new DomainError('INVALID_INPUT', '每次读取数量须为 1–200');
    const result = await this.adapter.read(auth.config, auth.credentials, {
      ...(typeof projectId === 'string' ? { projectId } : {}),
      limit,
    });
    const current = await this.repository.configuration(
      auth.scope,
      auth.target,
    );
    const authorization = await this.repository.authorization(
      auth.scope,
      auth.target,
    );
    if (
      current.version !== auth.config.version ||
      !current.enabled ||
      authorization?.version !== auth.authorizationVersion
    )
      throw new DomainError('CONFLICT', '读取期间连接配置已改变，请重新读取');
    return result;
  }
}
