import { isIP } from 'node:net';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { DomainError } from '@tandem/core';
import type {
  ConnectorCredentials,
  ConnectorDatabaseEvidence,
  ConnectorExternalProject,
  ConnectorExternalTask,
  ConnectorReadPort,
  ConnectorReadResult,
  ConnectorTestResult,
  WorkConnector,
} from '@tandem/core';
import { ZentaoIdentityProvider } from './identity';
import { ZentaoProjectSystem } from './projects';

type Options = {
  allowedOrigins?: string[];
  allowedDatabaseHosts?: string[];
  allowHttp?: boolean;
  databaseTls?: boolean;
};
type Schema = { prefix: string; columns: Map<string, Set<string>> };
type Authorized = {
  system: ZentaoProjectSystem;
  subject: string;
  projects: ConnectorExternalProject[];
  truncated: boolean;
};
const identifier = (value: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(value))
    throw new DomainError('UNAVAILABLE', '禅道表结构标识无效');
  return '`' + value + '`';
};
const number = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const text = (value: unknown, max = 200) =>
  typeof value === 'string'
    ? value.slice(0, max)
    : value === null || value === undefined
      ? ''
      : String(value).slice(0, max);

/** Fail closed: only directly granted SELECT/SHOW VIEW/USAGE accounts qualify. */
export function assertReadOnlyGrants(grants: string[]): void {
  if (!grants.length)
    throw new DomainError('FORBIDDEN', '无法核验数据库账号只读权限');
  for (const grant of grants) {
    const match = /^GRANT (.+?) ON .+? TO /i.exec(grant);
    if (
      !match ||
      /WITH GRANT OPTION/i.test(grant) ||
      !match[1]!
        .split(',')
        .every((value) =>
          ['SELECT', 'SHOW VIEW', 'USAGE'].includes(value.trim().toUpperCase()),
        )
    )
      throw new DomainError(
        'FORBIDDEN',
        '数据库账号含写权限、转授权或角色授权，不能证明只读；请使用仅直接授予 SELECT 的专用账号',
      );
  }
}

/** API ACLs select the exact task IDs that the read-only database may summarize. */
export class ZentaoReadOnlyDatabase implements ConnectorReadPort {
  constructor(private readonly options: Options = {}) {}
  private validate(config: WorkConnector) {
    let api: URL;
    try {
      api = new URL(config.baseUrl);
    } catch {
      throw new DomainError('INVALID_INPUT', '禅道服务地址无效');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
    if (
      api.username ||
      api.password ||
      api.search ||
      api.hash ||
      !['https:', 'http:'].includes(api.protocol) ||
      (api.protocol === 'http:' && !local && !this.options.allowHttp)
    )
      throw new DomainError(
        'INVALID_INPUT',
        '禅道地址须为 HTTPS，本机测试可使用 HTTP',
      );
    if (
      this.options.allowedOrigins?.length &&
      !this.options.allowedOrigins.includes(api.origin)
    )
      throw new DomainError('FORBIDDEN', '禅道地址不在部署允许的来源范围');
    if (
      !config.databaseHost ||
      (!isIP(config.databaseHost) &&
        !/^[A-Za-z0-9.-]{1,253}$/.test(config.databaseHost)) ||
      !config.databaseName ||
      !config.databaseUser
    )
      throw new DomainError(
        'INVALID_INPUT',
        '请填写数据库主机、数据库名和只读账号',
      );
    if (
      this.options.allowedDatabaseHosts?.length &&
      !this.options.allowedDatabaseHosts.includes(config.databaseHost) &&
      !this.options.allowedDatabaseHosts.includes(
        config.databaseHost + ':' + config.databasePort,
      )
    )
      throw new DomainError('FORBIDDEN', '数据库地址不在部署允许的范围');
    return api.protocol === 'http:';
  }
  private async authorize(
    config: WorkConnector,
    credentials: ConnectorCredentials,
  ): Promise<Authorized> {
    const allowInsecureHttp = this.validate(config),
      signal = AbortSignal.timeout(20000);
    const request: typeof fetch = (input, init = {}) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          ...(init.signal ? [init.signal] : []),
        ]),
      });
    const login = await new ZentaoIdentityProvider({
      id: `connector:${config.id}:${config.version}`,
      label: config.name,
      baseUrl: config.baseUrl,
      commanderAccounts: [],
      allowInsecureHttp,
      fetch: request,
    }).authenticate(credentials.account, credentials.apiPassword);
    const system = new ZentaoProjectSystem({
      connectionId: login.providerId,
      baseUrl: config.baseUrl,
      accessToken: login.accessToken,
      subject: login.subject,
      allowInsecureHttp,
      fetch: request,
    });
    const page = await system.projects(1);
    return {
      system,
      subject: login.subject,
      projects: [...page.items],
      truncated: page.total > page.items.length,
    };
  }
  private async query(
    connection: Connection,
    sql: string,
    params: unknown[] = [],
  ) {
    const [rows] = await connection.query<RowDataPacket[]>(
      { sql, timeout: 5000 },
      params,
    );
    return rows;
  }
  private async schema(
    connection: Connection,
    database: string,
  ): Promise<Schema> {
    const tables = await this.query(
      connection,
      'SELECT TABLE_NAME,COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND (TABLE_NAME LIKE ? OR TABLE_NAME LIKE ? OR TABLE_NAME LIKE ?)',
      [database, '%project', '%task', '%user'],
    );
    const columns = new Map<string, Set<string>>();
    for (const row of tables) {
      const name = text(row.TABLE_NAME, 200);
      if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
      const fields = columns.get(name) ?? new Set<string>();
      fields.add(text(row.COLUMN_NAME));
      columns.set(name, fields);
    }
    const prefixes = [...columns.keys()]
      .filter((name) => name.endsWith('project'))
      .map((name) => name.slice(0, -7))
      .filter(
        (prefix) =>
          columns.has(prefix + 'task') && columns.has(prefix + 'user'),
      );
    const prefix = prefixes.includes('zt_')
      ? 'zt_'
      : prefixes.length === 1
        ? prefixes[0]
        : undefined;
    if (
      prefix === undefined ||
      ![
        ['project', 'id'],
        ['project', 'name'],
        ['project', 'status'],
        ['task', 'id'],
        ['task', 'project'],
        ['task', 'name'],
        ['task', 'status'],
        ['user', 'id'],
        ['user', 'account'],
      ].every(([table, column]) => columns.get(prefix + table)?.has(column!))
    )
      throw new DomainError(
        'UNAVAILABLE',
        '未找到兼容的禅道 project/task/user 表，或只读账号缺少这些表的 SELECT 权限',
      );
    return { prefix, columns };
  }
  private async database<T>(
    config: WorkConnector,
    credentials: ConnectorCredentials,
    subject: string,
    work: (
      connection: Connection,
      schema: Schema,
      evidence: ConnectorDatabaseEvidence,
    ) => Promise<T>,
  ): Promise<T> {
    this.validate(config);
    let connection: Connection | undefined;
    let transaction = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      connection = await mysql.createConnection({
        host: config.databaseHost,
        port: config.databasePort,
        database: config.databaseName,
        user: config.databaseUser,
        password: credentials.databasePassword,
        connectTimeout: 5000,
        multipleStatements: false,
        flags: ['-LOCAL_FILES'],
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        enableKeepAlive: false,
        ...(this.options.databaseTls
          ? { ssl: { rejectUnauthorized: true } }
          : {}),
      });
      deadline = setTimeout(() => connection?.destroy(), 15000);
      const rawGrants = await this.query(
        connection,
        'SHOW GRANTS FOR CURRENT_USER()',
      );
      assertReadOnlyGrants(
        rawGrants.map((row) => String(Object.values(row)[0] ?? '')),
      );
      await connection.query({
        sql: 'START TRANSACTION READ ONLY',
        timeout: 5000,
      });
      transaction = true;
      const schema = await this.schema(connection, config.databaseName),
        users = schema.columns.get(schema.prefix + 'user')!;
      const own = await this.query(
        connection,
        `SELECT id,account FROM ${identifier(schema.prefix + 'user')} WHERE account=? ${users.has('deleted') ? "AND deleted='0'" : ''} LIMIT 1`,
        [credentials.account],
      );
      if (String(own[0]?.id ?? '') !== subject)
        throw new DomainError(
          'CONFLICT',
          '数据库与当前禅道账号身份不匹配，请核对连接的站点和数据库',
        );
      for (const suffix of ['project', 'task'])
        await this.query(
          connection,
          `SELECT id FROM ${identifier(schema.prefix + suffix)} LIMIT 0`,
        );
      const info = await this.query(
        connection,
        'SELECT VERSION() AS version,CURRENT_USER() AS principal',
      );
      return await work(connection, schema, {
        readOnly: true,
        serverVersion: text(info[0]?.version, 160),
        principal: text(info[0]?.principal, 200),
        accessibleTables: ['project', 'task', 'user'].map(
          (name) => schema.prefix + name,
        ),
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code =
        error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (
        [
          'ER_ACCESS_DENIED_ERROR',
          'ER_DBACCESS_DENIED_ERROR',
          'ER_TABLEACCESS_DENIED_ERROR',
          'ER_SPECIFIC_ACCESS_DENIED_ERROR',
        ].includes(String(code))
      )
        throw new DomainError(
          'FORBIDDEN',
          '数据库账号认证失败或缺少只读权限，请核对本人的授权',
        );
      throw new DomainError(
        'UNAVAILABLE',
        '数据库连接或只读查询失败，请检查网络、表结构和只读账号',
      );
    } finally {
      if (connection) {
        if (transaction)
          await connection
            .query({ sql: 'ROLLBACK', timeout: 1000 })
            .catch(() => undefined);
        connection.destroy();
      }
      if (deadline) clearTimeout(deadline);
    }
  }
  async test(
    config: WorkConnector,
    credentials: ConnectorCredentials,
  ): Promise<ConnectorTestResult> {
    const auth = await this.authorize(config, credentials);
    return this.database(
      config,
      credentials,
      auth.subject,
      async (_connection, _schema, database) => ({
        ok: true,
        checkedAt: new Date().toISOString(),
        database,
        authorization: {
          account: credentials.account,
          visibleProjects: auth.projects.length,
          projectsTruncated: auth.truncated,
        },
      }),
    );
  }
  async read(
    config: WorkConnector,
    credentials: ConnectorCredentials,
    options: { projectId?: string; limit: number },
  ): Promise<ConnectorReadResult> {
    const auth = await this.authorize(config, credentials);
    let projects = auth.projects,
      truncated = auth.truncated;
    const taskIds: string[] = [];
    if (options.projectId) {
      projects = [await auth.system.project(options.projectId)];
      const executions = await auth.system.executions(options.projectId);
      truncated = executions.length > 5;
      for (const execution of executions.slice(0, 5)) {
        const page = await auth.system.tasks(
          options.projectId,
          execution.id,
          1,
        );
        taskIds.push(
          ...page.items
            .slice(0, options.limit - taskIds.length)
            .map((task) => task.id),
        );
        if (page.total > page.items.length || taskIds.length >= options.limit)
          truncated = true;
        if (taskIds.length >= options.limit) break;
      }
    }
    return this.database(
      config,
      credentials,
      auth.subject,
      async (connection, schema) => {
        const projectTable = identifier(schema.prefix + 'project'),
          projectFields = schema.columns.get(schema.prefix + 'project')!;
        let projectRows: RowDataPacket[] = [];
        if (projects.length)
          projectRows = await this.query(
            connection,
            `SELECT id,name,status FROM ${projectTable} WHERE id IN (${projects.map(() => '?').join(',')}) ${projectFields.has('deleted') ? "AND deleted='0'" : ''}`,
            projects.map((project) => project.id),
          );
        if (
          projects.some(
            (project) =>
              !projectRows.some(
                (row) =>
                  String(row.id) === project.id &&
                  text(row.name) === project.name,
              ),
          )
        )
          throw new DomainError(
            'CONFLICT',
            'API 与数据库的项目不一致，或读取期间项目已变化，请核对数据源后重试',
          );
        const dbProjects = projects.map((project) => {
          const row = projectRows.find((row) => String(row.id) === project.id)!;
          return {
            id: project.id,
            name: text(row.name),
            status: text(row.status, 40),
          };
        });
        let tasks: ConnectorExternalTask[] = [];
        if (options.projectId && taskIds.length) {
          const fields = schema.columns.get(schema.prefix + 'task')!;
          const optional = [
            'module',
            'assignedTo',
            'estimate',
            'consumed',
            'left',
            'deadline',
          ].map((field) =>
            fields.has(field)
              ? identifier(field)
              : `NULL AS ${identifier(field)}`,
          );
          const rows = await this.query(
            connection,
            `SELECT id,project,name,status,${optional.join(',')} FROM ${identifier(schema.prefix + 'task')} WHERE project=? AND id IN (${taskIds.map(() => '?').join(',')}) ${fields.has('deleted') ? "AND deleted='0'" : ''} ORDER BY id LIMIT ?`,
            [options.projectId, ...taskIds, options.limit],
          );
          if (rows.length !== new Set(taskIds).size)
            throw new DomainError(
              'CONFLICT',
              '任务授权清单与数据库不一致，可能正在变更，请重新读取',
            );
          tasks = rows.map((row) => ({
            id: String(row.id),
            projectId: String(row.project),
            name: text(row.name),
            status: text(row.status, 40),
            assignee: text(row.assignedTo, 120),
            moduleId:
              row.module === null || row.module === undefined
                ? null
                : String(row.module),
            estimatedHours: number(row.estimate),
            consumedHours: number(row.consumed),
            remainingHours: number(row.left),
            deadline:
              typeof row.deadline === 'string' &&
              /^\d{4}-\d{2}-\d{2}/.test(row.deadline) &&
              !row.deadline.startsWith('0000')
                ? row.deadline.slice(0, 10)
                : null,
          }));
        }
        const checkedAt = new Date().toISOString();
        return {
          kind: 'external-read',
          source: 'zentao',
          connectorId: config.id,
          checkedAt,
          expiresAt: new Date(Date.now() + 30000).toISOString(),
          projects: dbProjects,
          tasks,
          tasksLoaded: Boolean(options.projectId),
          truncated,
        };
      },
    );
  }
}
