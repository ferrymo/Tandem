import { describe, expect, it, vi } from 'vitest';
import { ZentaoIdentityProvider } from '../../adapters/zentao/src/index';

const token = 'test_session_1234567890';
const profile = {
  id: 7,
  account: 'zhangsan',
  realname: '张三',
  role: { code: 'dev', name: '研发' },
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
function fixture(commanders: readonly string[] = ['zhangsan']) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const provider = new ZentaoIdentityProvider({
    id: 'primary',
    label: '协作账号',
    baseUrl: 'https://collab.example/zentao/',
    commanderAccounts: commanders,
    fetch,
  });
  return { fetch, provider };
}

describe('协作账号身份连接器', () => {
  it('用本人密码取得令牌，再用令牌读取服务端当前身份', async () => {
    const { fetch, provider } = fixture();
    fetch
      .mockResolvedValueOnce(json({ token }, 201))
      .mockResolvedValueOnce(json({ profile }));
    await expect(
      provider.authenticate('zhangsan', 'local-test-password'),
    ).resolves.toEqual({
      providerId: 'primary',
      subject: '7',
      displayName: '张三',
      canCreateWorkspace: true,
      accessToken: token,
    });
    const [tokenUrl, tokenRequest] = fetch.mock.calls[0]!;
    expect(tokenUrl).toBe('https://collab.example/zentao/api.php/v1/tokens');
    expect(tokenRequest).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        account: 'zhangsan',
        password: 'local-test-password',
      }),
      redirect: 'error',
      cache: 'no-store',
    });
    expect(tokenRequest?.signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[1]).toMatchObject([
      'https://collab.example/zentao/api.php/v1/user',
      { method: 'GET', headers: { Token: token }, redirect: 'error' },
    ]);
    expect(String(fetch.mock.calls[1]![0])).not.toContain(token);
  });

  it('角色名称或实例管理员标记不自行扩大指挥官权限', async () => {
    const { fetch, provider } = fixture([]);
    fetch.mockResolvedValueOnce(json({ token }, 201)).mockResolvedValueOnce(
      json({
        profile: {
          ...profile,
          role: { code: 'pm', name: '项目经理' },
          admin: true,
        },
      }),
    );
    expect(
      (await provider.authenticate('zhangsan', 'test-password'))
        .canCreateWorkspace,
    ).toBe(false);
  });

  it('每次重新核验用户，返回当前身份与当前白名单权限', async () => {
    const { fetch, provider } = fixture(['Zhangsan']);
    fetch.mockResolvedValueOnce(
      json({ profile: { ...profile, realname: '李四' } }),
    );
    await expect(provider.verify(token, '7')).resolves.toEqual({
      providerId: 'primary',
      subject: '7',
      displayName: '李四',
      canCreateWorkspace: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]?.body).toBeUndefined();
  });

  it('拒绝令牌指向其他身份，以及认证响应账号不匹配', async () => {
    const { fetch, provider } = fixture();
    fetch.mockResolvedValueOnce(json({ profile }));
    await expect(provider.verify(token, '8')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    fetch
      .mockResolvedValueOnce(json({ token }, 201))
      .mockResolvedValueOnce(
        json({ profile: { ...profile, account: 'lisi' } }),
      );
    await expect(
      provider.authenticate('zhangsan', 'test-password'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([400, 401, 403])(
    '认证拒绝或令牌失效（%s）不暴露上游错误',
    async (status) => {
      const { fetch, provider } = fixture();
      fetch.mockResolvedValueOnce(
        json({ error: 'private-database-password' }, status),
      );
      await expect(provider.verify(token, '7')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.not.stringContaining('private-database-password'),
      });
    },
  );

  it.each([
    {},
    { profile: { ...profile, id: 0 } },
    { profile: { ...profile, id: '1; SELECT' } },
    { profile: { ...profile, id: 1.5 } },
    { profile: { ...profile, account: '' } },
    { profile: [] },
  ])('身份结构无效时不伪造当前用户', async (value) => {
    const { fetch, provider } = fixture();
    fetch.mockResolvedValueOnce(json(value));
    await expect(provider.verify(token, '7')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it.each([
    { ...profile, account: 'guest' },
    { ...profile, deleted: '1' },
  ])('拒绝游客和已删除身份', async (value) => {
    const { fetch, provider } = fixture();
    fetch.mockResolvedValueOnce(json({ profile: value }));
    await expect(provider.verify(token, '7')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('网络异常和重定向均失败关闭，错误不包含凭证', async () => {
    const { fetch, provider } = fixture();
    fetch.mockRejectedValueOnce(new Error('network leaked ' + token));
    await expect(provider.verify(token, '7')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.not.stringContaining(token),
    });
    fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://untrusted.example/' },
      }),
    );
    await expect(provider.verify(token, '7')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(fetch.mock.calls[1]![1]?.redirect).toBe('error');
  });

  it('限制声明长度和实际流长度，拒绝非 JSON 响应', async () => {
    const { fetch, provider } = fixture();
    fetch.mockResolvedValueOnce(
      new Response('{}', { headers: { 'Content-Length': '300000' } }),
    );
    await expect(provider.verify(token, '7')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    fetch.mockResolvedValueOnce(new Response(' '.repeat(300000)));
    await expect(provider.verify(token, '7')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    fetch.mockResolvedValueOnce(new Response('<html>login</html>'));
    await expect(provider.verify(token, '7')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('缺失或异常令牌不能继续读取身份', async () => {
    const { fetch, provider } = fixture();
    fetch.mockResolvedValueOnce(json({ token: 'bad\r\nheader' }, 201));
    await expect(
      provider.authenticate('zhangsan', 'test-password'),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(provider.verify('', '7')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'a'.repeat(121), ' zhangsan', 'zhangsan\n'])(
    '拒绝异常账号输入',
    async (account) => {
      const { fetch, provider } = fixture();
      await expect(
        provider.authenticate(account, 'test-password'),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('允许已配置的 API v1 根，不重复拼接路径', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ profile }));
    const provider = new ZentaoIdentityProvider({
      id: 'primary',
      label: '协作账号',
      baseUrl: 'https://collab.example/zentao/api.php/v1/',
      commanderAccounts: [],
      fetch,
    });
    await provider.verify(token, '7');
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://collab.example/zentao/api.php/v1/user',
    );
  });

  it.each([
    'invalid-url',
    'http://collab.example/',
    'https://user:password@collab.example/',
    'https://collab.example/?token=secret',
    'https://collab.example/#secret',
    'file:///private',
  ])('拒绝不安全或携带凭证的地址', (baseUrl) => {
    expect(
      () =>
        new ZentaoIdentityProvider({
          id: 'primary',
          label: '协作账号',
          baseUrl,
          commanderAccounts: [],
        }),
    ).toThrow();
  });

  it('内网 HTTP 必须由部署端显式启用', () => {
    expect(
      () =>
        new ZentaoIdentityProvider({
          id: 'primary',
          label: '协作账号',
          baseUrl: 'http://127.0.0.1:9999',
          commanderAccounts: [],
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
  });
});
