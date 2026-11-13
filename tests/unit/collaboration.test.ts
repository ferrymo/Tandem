import { describe, it, expect, vi } from 'vitest';
import { CollaborationService } from '../../packages/application/src/index';
import { DomainError } from '../../packages/core/src/index';
import type {
  CollaborationRepository,
  IdentityProvider,
  StoredSession,
} from '../../packages/core/src/index';
import {
  createSessionCodec,
  LoginLimiter,
  readCollaborationEnv,
} from '../../packages/platform/src/index';

const identity = {
  id: 'person',
  providerId: 'instance',
  subject: '1',
  displayName: '张三',
  canCreateWorkspace: true,
};
const login = {
  providerId: 'instance',
  subject: '1',
  displayName: '张三',
  canCreateWorkspace: true,
};
function fixture() {
  const codec = createSessionCodec('ab'.repeat(32));
  let session: StoredSession | null = null;
  const repository: CollaborationRepository = {
    createSession: vi.fn(async (input) => {
      session = {
        id: 'session',
        identity: { ...identity, ...input.login },
        encryptedCredential: input.encryptedCredential,
        expiresAt: input.expiresAt,
      };
      return session;
    }),
    session: vi.fn(async () => session),
    revokeSession: vi.fn(async () => {
      session = null;
    }),
    refreshIdentity: vi.fn(async (_id, current) => {
      if (session)
        session = { ...session, identity: { ...session.identity, ...current } };
    }),
    listWorkspaces: vi.fn(async () => []),
    createWorkspace: vi.fn(),
    overview: vi.fn(),
    members: vi.fn(),
    setMember: vi.fn(),
    removeMember: vi.fn(),
  };
  const provider: IdentityProvider = {
    id: 'instance',
    label: '协作系统',
    authenticate: vi.fn(async () => ({
      ...login,
      accessToken: 'upstream-secret',
    })),
    verify: vi.fn(async () => login),
  };
  const service = new CollaborationService(
    repository,
    provider,
    codec,
    () => 1_000_000,
  );
  return { codec, repository, provider, service };
}

describe('可信会话与授权', () => {
  it('密码不入库，会话摘要和凭证密文取代明文', async () => {
    const { service, repository, codec } = fixture();
    const { token, session } = await service.login(
      ' zhangsan ',
      'password-only-to-provider',
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const input = vi.mocked(repository.createSession).mock.calls[0]![0];
    expect(input.tokenHash).toBe(codec.hash(token));
    expect(JSON.stringify(input)).not.toContain('upstream-secret');
    expect(JSON.stringify(input)).not.toContain('password-only-to-provider');
    expect(codec.open(session.encryptedCredential, 'instance:1')).toBe(
      'upstream-secret',
    );
    expect(await service.authenticate(token)).toBeTruthy();
  });
  it('每次核验上游，白名单撤销及时更新本地资格', async () => {
    const { service, provider, repository } = fixture();
    const { token } = await service.login('zhangsan', 'password');
    vi.mocked(provider.verify).mockResolvedValue({
      ...login,
      canCreateWorkspace: false,
    });
    const session = (await service.authenticate(token))!;
    expect(session.identity.canCreateWorkspace).toBe(false);
    await expect(
      service.createWorkspace(session, '项目空间', 'request'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.createWorkspace).not.toHaveBeenCalled();
  });
  it('上游会话失效或身份错配撤销本地会话', async () => {
    const { service, provider, repository } = fixture();
    const { token } = await service.login('zhangsan', 'password');
    vi.mocked(provider.verify).mockResolvedValue({ ...login, subject: '2' });
    expect(await service.authenticate(token)).toBeNull();
    expect(repository.revokeSession).toHaveBeenCalled();
  });
  it('上游中断关闭访问但保留可恢复会话', async () => {
    const { service, provider, repository } = fixture();
    const { token } = await service.login('zhangsan', 'password');
    vi.mocked(provider.verify).mockRejectedValue(new Error('private response'));
    await expect(service.authenticate(token)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(repository.revokeSession).not.toHaveBeenCalled();
  });
  it('上游明确拒绝后清除本地授权', async () => {
    const { service, provider } = fixture();
    const { token } = await service.login('zhangsan', 'password');
    vi.mocked(provider.verify).mockRejectedValue(
      new DomainError('FORBIDDEN', 'expired'),
    );
    expect(await service.authenticate(token)).toBeNull();
  });
  it('退出使已复制的旧cookie失效', async () => {
    const { service } = fixture();
    const { token } = await service.login('zhangsan', 'password');
    await service.logout(token);
    expect(await service.authenticate(token)).toBeNull();
  });
  it('核验期间并发退出也不恢复会话', async () => {
    const { service, provider } = fixture();
    const { token } = await service.login('zhangsan', 'password');
    vi.mocked(provider.verify).mockImplementation(async () => {
      await service.logout(token);
      return login;
    });
    expect(await service.authenticate(token)).toBeNull();
  });
  it('无效cookie不查库、不调用外部系统', async () => {
    const { service, provider, repository } = fixture();
    expect(await service.authenticate('fake')).toBeNull();
    expect(repository.session).not.toHaveBeenCalled();
    expect(provider.verify).not.toHaveBeenCalled();
  });
});

describe('会话加密与部署默认值', () => {
  it('AAD防跨身份挪用，篡改与换密钥均拒绝', () => {
    const codec = createSessionCodec('12'.repeat(32));
    const sealed = codec.seal('credential', 'provider:1');
    expect(() => codec.open(sealed, 'provider:2')).toThrow();
    expect(() =>
      createSessionCodec('34'.repeat(32)).open(sealed, 'provider:1'),
    ).toThrow();
    expect(() =>
      codec.open(sealed.replace('v1.', 'v2.'), 'provider:1'),
    ).toThrow();
  });
  it('Compose空变量被当作未配置，不开放访问', () => {
    const env = readCollaborationEnv({
      TANDEM_IDENTITY_URL: '',
      SESSION_ENCRYPTION_KEY: '',
    });
    expect(env.TANDEM_IDENTITY_URL).toBeUndefined();
    expect(env.SESSION_ENCRYPTION_KEY).toBeUndefined();
    expect(env.TANDEM_COMMANDER_ACCOUNTS).toEqual([]);
    expect(env.TANDEM_IDENTITY_ALLOW_HTTP).toBe(false);
  });
  it('公共地址不能混入路径、用户信息或非HTTP协议', () => {
    for (const value of [
      'https://user:secret@example.com',
      'https://example.com/path',
      'ftp://example.com',
    ])
      expect(() =>
        readCollaborationEnv({ TANDEM_PUBLIC_URL: value }),
      ).toThrow();
  });
  it('账号和全局登录频率有限，释放幂等且窗口后恢复', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let index = 0; index < 5; index++) {
      const release = limiter.acquire('user')!;
      expect(release).toBeTruthy();
      release();
      release();
    }
    expect(limiter.acquire('user')).toBeNull();
    for (let index = 0; index < 55; index++)
      limiter.acquire('user-' + index)!();
    expect(limiter.acquire('another')).toBeNull();
    now = 60_001;
    expect(limiter.acquire('user')).toBeTruthy();
  });
});
