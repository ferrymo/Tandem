import assert from 'node:assert/strict';

// Explicit local acceptance only. Credentials stay in ignored environment files.
const upstream = new URL(process.env.TANDEM_IDENTITY_URL ?? '');
const tandem = new URL(process.env.TANDEM_PUBLIC_URL ?? '');
for (const url of [upstream, tandem]) {
  assert(
    url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    '此验收命令仅允许可信本机 HTTP 实例',
  );
}
const account = process.env.ZT_ACC;
const password = process.env.ZT_PWD;
assert(
  account && password,
  '请在被忽略的 .env.zentao.local 配置 ZT_ACC/ZT_PWD',
);
const upstreamRoot = upstream.toString().replace(/\/(?:api\.php\/v1\/?)?$/, '');
const api = upstreamRoot + '/api.php/v1';

async function request(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}

let cookie: string | undefined;
try {
  const tokenResponse = await request(api + '/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  assert.equal(tokenResponse.status, 201, '上游登录失败');
  const { token } = (await tokenResponse.json()) as { token?: string };
  assert(typeof token === 'string' && token.length > 0, '上游未返回授权');
  const userResponse = await request(api + '/user', {
    headers: { Token: token },
  });
  assert.equal(userResponse.status, 200, '上游身份核验失败');
  const { profile } = (await userResponse.json()) as {
    profile?: { id: number; account: string };
  };
  assert(profile?.account === account, '上游身份不匹配');

  const loginResponse = await request(new URL('/api/session', tandem).href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: tandem.origin },
    body: JSON.stringify({ account, password }),
  });
  assert.equal(loginResponse.status, 200, 'Tandem 登录失败');
  const rawCookie = loginResponse.headers.get('set-cookie');
  assert(rawCookie, 'Tandem 未建立会话');
  cookie = rawCookie.split(';')[0]!;
  const login = (await loginResponse.json()) as {
    user?: { id: string; canCreateWorkspace: boolean };
  };
  assert(login.user?.id, 'Tandem 未返回已验证身份');

  async function authenticated(path: string) {
    const response = await request(new URL(path, tandem).href, {
      headers: { Cookie: cookie! },
    });
    assert.equal(response.status, 200, '已登录请求失败：' + path);
    return response;
  }
  const session = (await (await authenticated('/api/session')).json()) as {
    user?: { id: string };
  };
  assert.equal(session.user?.id, login.user.id, '会话身份不一致');
  const connection = (await (
    await authenticated('/api/connection')
  ).json()) as {
    connection?: { configured: boolean; kind: string };
    authorization?: { status: string };
  };
  assert(connection.connection?.configured, '连接未配置');
  assert.equal(connection.connection.kind, 'zentao', '连接类型错误');
  assert.equal(connection.authorization?.status, 'authorized', '身份未授权');
  const { workspaces } = (await (
    await authenticated('/api/workspaces')
  ).json()) as { workspaces: Array<{ id: string }> };
  assert(Array.isArray(workspaces), '工作空间列表无效');
  for (const workspace of workspaces) {
    const detail = (await (
      await authenticated('/api/workspaces/' + workspace.id)
    ).json()) as { team?: { agents?: Array<{ role: string }> } };
    assert.equal(detail.team?.agents?.length, 3, 'T 组须恰好三人');
    assert.deepEqual(
      detail.team.agents.map((agent) => agent.role).sort(),
      ['architect', 'designer', 'engineer'],
      'T 组角色不匹配',
    );
  }
  const logout = await request(new URL('/api/session', tandem).href, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: tandem.origin },
  });
  assert.equal(logout.status, 200, '退出失败');
  const replay = await request(new URL('/api/workspaces', tandem).href, {
    headers: { Cookie: cookie },
  });
  assert.equal(replay.status, 401, '退出后旧会话仍可访问');
  cookie = undefined;
  console.log(
    JSON.stringify({
      upstream: 'REST v1 登录与身份通过',
      tandem: '登录、身份连接、空间读取、退出撤销通过',
      workspaceCount: workspaces.length,
      canCreateWorkspace: login.user.canCreateWorkspace,
    }),
  );
} finally {
  if (cookie)
    await request(new URL('/api/session', tandem).href, {
      method: 'DELETE',
      headers: { Cookie: cookie, Origin: tandem.origin },
    }).catch(() => {});
}
