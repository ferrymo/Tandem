import { DomainError } from '@tandem/core';
import type {
  StoredSession,
  WorkCredentialCodec,
  WorkCredentialKind,
  WorkCredentialRepository,
  WorkCredentialValues,
  WorkModelConnection,
} from '@tandem/core';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fieldSets = {
  'model-channel': ['apiKey'],
  connector: ['account', 'apiPassword', 'databasePassword'],
} as const;

/** Secret values remain encrypted at rest and never appear in public configuration. */
export class WorkCredentialsService {
  constructor(
    private readonly repository: WorkCredentialRepository,
    private readonly codec: WorkCredentialCodec,
    private readonly modelConnection: WorkModelConnection,
  ) {}

  private scope(session: StoredSession, workspaceId: string) {
    if (!uuid.test(workspaceId))
      throw new DomainError('INVALID_INPUT', '工作空间标识无效');
    return { workspaceId, actorId: session.identity.id };
  }

  private target(
    kind: unknown,
    id: unknown,
  ): { kind: WorkCredentialKind; id: string } {
    if (
      (kind !== 'model-channel' && kind !== 'connector') ||
      typeof id !== 'string' ||
      !uuid.test(id)
    )
      throw new DomainError('INVALID_INPUT', '凭证所属配置无效');
    return { kind, id };
  }

  states(session: StoredSession, workspaceId: string) {
    return this.repository.states(this.scope(session, workspaceId));
  }

  async save(
    session: StoredSession,
    workspaceId: string,
    input: { kind: unknown; id: unknown; values: unknown },
  ) {
    const target = this.target(input.kind, input.id);
    if (
      !input.values ||
      typeof input.values !== 'object' ||
      Array.isArray(input.values)
    )
      throw new DomainError('INVALID_INPUT', '请填写有效的凭证内容');
    const supplied = input.values as Record<string, unknown>;
    const keys = Object.keys(supplied);
    const allowed: readonly string[] = fieldSets[target.kind];
    if (!keys.length || keys.some((key) => !allowed.includes(key)))
      throw new DomainError('INVALID_INPUT', '凭证字段与配置类型不一致');
    const values: WorkCredentialValues = {};
    for (const key of keys) {
      const value = supplied[key];
      if (
        typeof value !== 'string' ||
        !value.length ||
        value.length > 8192 ||
        value.includes('\0')
      )
        throw new DomainError(
          'INVALID_INPUT',
          '凭证须为 1–8192 个字符，留空表示保留原凭证',
        );
      values[key as keyof WorkCredentialValues] = value;
    }
    const scope = this.scope(session, workspaceId);
    const context = `work-credential:${workspaceId}:${target.kind}:${target.id}`;
    // read() and save() each re-check membership and current resource ownership.
    const existing = await this.repository.read(scope, target.kind, target.id);
    const merged = existing
      ? { ...this.decode(existing.encryptedValues, context), ...values }
      : values;
    await this.repository.save(scope, target.kind, target.id, {
      encryptedValues: this.codec.seal(JSON.stringify(merged), context),
      fields: Object.keys(merged),
      expectedEncryptedValues: existing?.encryptedValues ?? null,
    });
    return { configured: true };
  }

  private decode(encrypted: string, context: string): WorkCredentialValues {
    try {
      const values: unknown = JSON.parse(this.codec.open(encrypted, context));
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw new Error();
      return values as WorkCredentialValues;
    } catch {
      throw new DomainError(
        'UNAVAILABLE',
        '原凭证无法解密，请联系管理员恢复密钥',
      );
    }
  }

  async testModel(
    session: StoredSession,
    workspaceId: string,
    id: unknown,
    requestedModel?: unknown,
  ) {
    const target = this.target('model-channel', id);
    const scope = this.scope(session, workspaceId);
    const channel = await this.repository.modelChannel(scope, target.id);
    if (!channel.enabled) throw new DomainError('CONFLICT', '请先启用模型渠道');
    const model = requestedModel ?? channel.models[0];
    if (
      typeof model !== 'string' ||
      !model.trim() ||
      model.length > 200 ||
      !channel.models.includes(model)
    )
      throw new DomainError('INVALID_INPUT', '请选择此渠道已配置的模型');
    const secret = await this.repository.read(
      scope,
      'model-channel',
      target.id,
    );
    const credential = secret
      ? this.decode(
          secret.encryptedValues,
          `work-credential:${workspaceId}:model-channel:${target.id}`,
        ).apiKey
      : undefined;
    if (!credential && channel.protocol !== 'ollama')
      throw new DomainError('CONFLICT', '请先保存此渠道的 API key');
    return {
      ok: true,
      ...(await this.modelConnection.test(channel, credential ?? '', model)),
    };
  }
}
