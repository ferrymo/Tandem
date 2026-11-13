import { DomainError } from '@tandem/core';
import type { IdentityProvider, VerifiedLogin } from '@tandem/core';

type Options = {
  id: string;
  label: string;
  baseUrl: string;
  commanderAccounts: readonly string[];
  allowInsecureHttp?: boolean;
  fetch?: typeof globalThis.fetch;
};

type Profile = { id: string; account: string; displayName: string };
const responseLimit = 256 * 1024;
const tokenPattern = /^[A-Za-z0-9,_-]{8,4096}$/;
const hasControl = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Verified against the upstream REST v1 entries and routing contract:
 * https://github.com/easysoft/zentaopms/blob/zentaopms_22.7_20261103/api/v1/entries/tokens.php
 * https://github.com/easysoft/zentaopms/blob/zentaopms_22.7_20261103/api/v1/entries/user.php
 * https://github.com/easysoft/zentaopms/blob/zentaopms_22.7_20261103/framework/base/router.class.php
 */
export class ZentaoIdentityProvider implements IdentityProvider {
  readonly id: string;
  readonly label: string;
  private readonly endpoint: string;
  private readonly commanders: ReadonlySet<string>;
  private readonly request: typeof globalThis.fetch;

  constructor(options: Options) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new DomainError('INVALID_INPUT', '身份连接地址无效');
    }
    if (
      !options.id.trim() ||
      !options.label.trim() ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && options.allowInsecureHttp === true))
    )
      throw new DomainError(
        'INVALID_INPUT',
        '身份连接必须使用受信的 HTTPS 地址',
      );
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/api.php/v1') ? path : path + '/api.php/v1';
    this.id = options.id;
    this.label = options.label;
    this.endpoint = url.toString().replace(/\/$/, '');
    this.commanders = new Set(options.commanderAccounts);
    this.request = options.fetch ?? globalThis.fetch;
  }

  async authenticate(
    account: string,
    password: string,
  ): Promise<VerifiedLogin> {
    if (
      account.length < 1 ||
      account.length > 120 ||
      account !== account.trim() ||
      hasControl(account) ||
      password.length < 1 ||
      password.length > 4096
    )
      throw new DomainError('INVALID_INPUT', '请输入有效账号和密码');
    const result = await this.json('/tokens', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (
      !isRecord(result) ||
      typeof result.token !== 'string' ||
      !tokenPattern.test(result.token)
    )
      throw new DomainError('UNAVAILABLE', '身份连接返回了无效响应');
    const profile = await this.profile(result.token);
    if (profile.account !== account)
      throw new DomainError('FORBIDDEN', '账号验证失败，请重新登录');
    return { ...this.identity(profile), accessToken: result.token };
  }

  async verify(
    accessToken: string,
    subject: string,
  ): Promise<Omit<VerifiedLogin, 'accessToken'>> {
    if (!tokenPattern.test(accessToken))
      throw new DomainError('FORBIDDEN', '账号授权已失效，请重新登录');
    const profile = await this.profile(accessToken);
    if (profile.id !== subject)
      throw new DomainError('FORBIDDEN', '账号授权已失效，请重新登录');
    return this.identity(profile);
  }

  private identity(profile: Profile): Omit<VerifiedLogin, 'accessToken'> {
    return {
      providerId: this.id,
      subject: profile.id,
      displayName: profile.displayName,
      canCreateWorkspace: this.commanders.has(profile.account),
    };
  }

  private async profile(accessToken: string): Promise<Profile> {
    const result = await this.json('/user', {
      method: 'GET',
      headers: { Token: accessToken },
    });
    if (!isRecord(result) || !isRecord(result.profile))
      throw new DomainError('UNAVAILABLE', '身份连接返回了无效响应');
    const value = result.profile;
    const id =
      typeof value.id === 'number' && Number.isSafeInteger(value.id)
        ? String(value.id)
        : value.id;
    if (
      typeof id !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(id) ||
      typeof value.account !== 'string' ||
      value.account.length < 1 ||
      value.account.length > 120 ||
      value.account !== value.account.trim() ||
      hasControl(value.account)
    )
      throw new DomainError('UNAVAILABLE', '身份连接返回了无效响应');
    if (
      value.account === 'guest' ||
      value.deleted === '1' ||
      value.deleted === 1 ||
      value.deleted === true
    )
      throw new DomainError('FORBIDDEN', '账号授权已失效，请重新登录');
    return {
      id,
      account: value.account,
      displayName:
        typeof value.realname === 'string' && value.realname.trim()
          ? value.realname.trim().slice(0, 120)
          : value.account,
    };
  }

  private async json(path: string, init: RequestInit): Promise<unknown> {
    try {
      const requestInit: RequestInit & { cache: 'no-store' } = {
        ...init,
        headers: { Accept: 'application/json', ...init.headers },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      };
      const response = await this.request(this.endpoint + path, requestInit);
      if ([400, 401, 403].includes(response.status)) {
        await response.body?.cancel();
        throw new DomainError(
          'FORBIDDEN',
          '账号验证失败或授权已失效，请重新登录',
        );
      }
      if (!response.ok || response.status >= 300) {
        await response.body?.cancel();
        throw new DomainError('UNAVAILABLE', '身份连接暂不可用，请稍后重试');
      }
      const length = response.headers.get('Content-Length');
      if (length && Number(length) > responseLimit) {
        await response.body?.cancel();
        throw new DomainError('UNAVAILABLE', '身份连接返回了无效响应');
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new DomainError('UNAVAILABLE', '身份连接返回了无效响应');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > responseLimit) {
            await reader.cancel();
            throw new DomainError('UNAVAILABLE', '身份连接返回了无效响应');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('UNAVAILABLE', '身份连接暂不可用，请稍后重试');
    }
  }
}
