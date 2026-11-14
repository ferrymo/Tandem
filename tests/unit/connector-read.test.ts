import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assertReadOnlyGrants } from '../../adapters/zentao/src/readonly-database';
import { ConnectorReadService } from '../../packages/application/src/connector-read';
import { DomainError } from '../../packages/core/src/index';
import type {
  ConnectorAuthorization,
  ConnectorAuthorizationRepository,
  ConnectorReadPort,
  StoredSession,
  WorkConnector,
} from '../../packages/core/src/index';
import { createSessionCodec } from '../../packages/platform/src/session-crypto';

describe('数据库只读权限核验', () => {
  it('接受直接授予 SELECT、SHOW VIEW 与 USAGE 的账号', () => {
    expect(() =>
      assertReadOnlyGrants([
        "GRANT USAGE ON *.* TO 'reader'@'%'",
        "GRANT SELECT, SHOW VIEW ON `zentao`.* TO 'reader'@'%'",
      ]),
    ).not.toThrow();
  });

  it.each(
    [
      [],
      ["GRANT SELECT, INSERT ON `zentao`.* TO 'reader'@'% '"],
      ["GRANT ALL PRIVILEGES ON *.* TO 'reader'@'%'"],
      ["GRANT EXECUTE ON PROCEDURE `zentao`.`write_data` TO 'reader'@'%'"],
      ["GRANT SELECT ON `zentao`.* TO 'reader'@'%' WITH GRANT OPTION"],
      ['GRANT `readonly_role`@`%` TO `reader`@`%`'],
      ["GRANT SELECT ON `zentao`.* TO 'reader'@'%'", 'unrecognized grant'],
    ].map((grants) => ({ grants })),
  )('拒绝写入、转授权、角色或无法证明只读的授权 %#', ({ grants }) => {
    expect(() => assertReadOnlyGrants(grants)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

function fixture() {
  const workspaceId = randomUUID(),
    actorId = randomUUID(),
    id = randomUUID(),
    codec = createSessionCodec(randomBytes(32).toString('hex'));
  const session: StoredSession = {
    id: randomUUID(),
    identity: {
      id: actorId,
      providerId: 'isolated-test',
      subject: 'test-user',
      displayName: '张三',
      canCreateWorkspace: true,
    },
    encryptedCredential: '',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  let config: WorkConnector = {
    id,
    version: 1,
    name: '隔离连接',
    kind: 'zentao',
    baseUrl: 'https://zentao.invalid',
    databaseHost: 'db.invalid',
    databasePort: 3306,
    databaseName: 'zentao',
    databaseUser: 'reader',
    credentialRef: '',
    enabled: true,
  };
  let authorization: ConnectorAuthorization | null = {
    version: 1,
    configurationVersion: 1,
    encryptedValues: codec.seal(
      JSON.stringify({
        account: 'member',
        apiPassword: 'isolated-api-password',
        databasePassword: 'isolated-db-password',
      }),
      `connector-credential:${workspaceId}:${id}:${actorId}:1`,
    ),
  };
  let member = true;
  const repository: ConnectorAuthorizationRepository = {
    configuration: vi.fn(async () => {
      if (!member) throw new DomainError('FORBIDDEN', '已撤销');
      return { ...config };
    }),
    authorization: vi.fn(async () => authorization),
    save: vi.fn(),
    states: vi.fn(),
  };
  const duringRequest = vi.fn();
  const adapter: ConnectorReadPort = {
    test: vi.fn<ConnectorReadPort['test']>(async () => {
      duringRequest();
      return {
        ok: true,
        checkedAt: new Date().toISOString(),
        database: {
          readOnly: true,
          serverVersion: 'isolated',
          principal: 'reader',
          accessibleTables: [],
        },
        authorization: {
          account: 'member',
          visibleProjects: 0,
          projectsTruncated: false,
        },
      };
    }),
    read: vi.fn<ConnectorReadPort['read']>(async () => {
      duringRequest();
      return {
        kind: 'external-read',
        source: 'zentao',
        connectorId: id,
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        projects: [],
        tasks: [],
        tasksLoaded: false,
        truncated: false,
      };
    }),
  };
  return {
    service: new ConnectorReadService(repository, codec, adapter),
    session,
    workspaceId,
    id,
    adapter,
    repository,
    duringRequest,
    changeConfig: () => (config = { ...config, version: config.version + 1 }),
    disable: () => (config = { ...config, enabled: false }),
    changeCredential: () => {
      authorization = authorization
        ? { ...authorization, version: authorization.version + 1 }
        : null;
    },
    revokeCredential: () => (authorization = null),
    revokeMembership: () => (member = false),
  };
}

describe('连接器读取的请求后权限复核', () => {
  for (const operation of ['test', 'read'] as const) {
    it.each([
      ['配置版本改变', 'changeConfig', 'CONFLICT'],
      ['连接停用', 'disable', 'CONFLICT'],
      ['本人凭据更新', 'changeCredential', 'CONFLICT'],
      ['本人授权删除', 'revokeCredential', 'CONFLICT'],
      ['空间成员撤权', 'revokeMembership', 'FORBIDDEN'],
    ] as const)(
      `${operation} 拒绝请求期间%s的旧结果`,
      async (_, mutate, code) => {
        const test = fixture();
        test.duringRequest.mockImplementation(test[mutate]);
        const result =
          operation === 'test'
            ? test.service.test(test.session, test.workspaceId, test.id)
            : test.service.read(test.session, test.workspaceId, test.id, {});
        await expect(result).rejects.toMatchObject({ code });
        expect(test.adapter[operation]).toHaveBeenCalledOnce();
      },
    );
  }

  it('缺少连接标识时在调用仓储或外部服务前失败', async () => {
    const test = fixture();
    await expect(
      test.service.test(test.session, test.workspaceId, undefined),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(test.repository.configuration).not.toHaveBeenCalled();
    expect(test.adapter.test).not.toHaveBeenCalled();
  });
});
