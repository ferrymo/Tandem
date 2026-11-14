import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { WorkSnapshot } from '../packages/core/src/index';

type Entity = { key: string; id: string; [field: string]: unknown };
type Actor = {
  key: string;
  id: string;
  name?: string;
  accountEnv?: string;
  passwordEnv?: string;
  credentialEnv?: { account: string; password: string };
};
type FixtureManifest = {
  schemaVersion: 1;
  fixtureKey: string;
  baseUrl: string;
  identityBaseUrl: string;
  asOfDate?: string;
  workspace: { id: string; name: string; requestId: string };
  owner: Omit<Actor, 'key'>;
  members: Actor[];
  groups: Entity[];
  projects: Entity[];
  modules: Entity[];
  projectMembers?: Entity[];
  teams: Entity[];
  agents: Entity[];
  roles: Entity[];
  tasks: Entity[];
  documents: Entity[];
  attachments: (Entity & {
    sha256: string;
    size: number;
    target: { taskId?: string; documentId?: string; projectId?: string };
    visibleTo?: string[];
  })[];
  efforts: Entity[];
  expectations: {
    counts: Record<string, number>;
    visibleProjectIdsByActor: Record<string, string[]>;
    visibleDocumentIdsByActor: Record<string, string[]>;
    permissionsByActor?: Record<string, string[]>;
    totals?: { effortHours: number; plannedHours: number };
    resourceWindow: {
      from: string;
      to: string;
      capacityHours: number;
      plannedHoursByActor: Record<string, number>;
      actualHoursByActor: Record<string, number>;
    };
    dailyEfforts?: { actor: string; date: string; hours: number }[];
  };
};

async function verify() {
  const manifestPath = resolve(
    process.argv[2] ?? 'data/work-fixture/manifest.json',
  );
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as FixtureManifest;
  assert.equal(manifest.schemaVersion, 1, '不支持的 fixture manifest 版本');
  const base = new URL(manifest.baseUrl);
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) &&
      ['http:', 'https:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash &&
      base.pathname === '/',
    '此验收脚本只访问本机 Tandem',
  );
  const origin = base.origin;
  function localIdentityAddress(value: string) {
    const url = new URL(value);
    assert(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      'fixture 身份服务必须为明确的本机地址',
    );
    url.pathname =
      url.pathname.replace(/\/+$/, '').replace(/\/api\.php\/v1$/, '') || '/';
    return url.toString();
  }
  assert(process.env.TANDEM_IDENTITY_URL, '请加载身份服务环境配置');
  const identityAddress = localIdentityAddress(manifest.identityBaseUrl);
  assert.equal(
    localIdentityAddress(process.env.TANDEM_IDENTITY_URL),
    identityAddress,
    '本机身份服务与fixture清单不一致',
  );
  const asOfDate = manifest.asOfDate ?? '2026-11-14';
  assert(/^\d{4}-\d{2}-\d{2}$/.test(asOfDate));
  const workspaceId = manifest.workspace.id;
  const endpoint = `/api/workspaces/${workspaceId}`;
  const checks: string[] = [];
  const actorReports: Record<string, unknown> = {};
  const clients: HttpActor[] = [];

  class HttpActor {
    private cookie = '';
    constructor(readonly actor: Actor) {}
    async request(path: string, method = 'GET', payload?: unknown) {
      const response = await fetch(new URL(path, origin), {
        method,
        redirect: 'error',
        headers: {
          Origin: origin,
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(payload === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(20000),
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length)
        this.cookie = cookies
          .map((value) => value.split(';', 1)[0]!)
          .filter((value) => /^(?:__Host-)?tandem_session=/.test(value))
          .join('; ');
      return response;
    }
    async json<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
      const response = await this.request(path, method, payload);
      if (!response.ok)
        throw new Error(
          `${this.actor.key}: ${method} ${path} HTTP ${response.status}`,
        );
      return response.json() as Promise<T>;
    }
    async login() {
      const accountKey =
        this.actor.credentialEnv?.account ?? this.actor.accountEnv;
      const passwordKey =
        this.actor.credentialEnv?.password ?? this.actor.passwordEnv;
      assert(
        accountKey && passwordKey,
        `${this.actor.key}: 缺少凭据环境变量引用`,
      );
      const account = process.env[accountKey],
        password = process.env[passwordKey];
      assert(
        account && password,
        `${this.actor.key}: 请加载专用 fixture 凭据环境文件`,
      );
      const result = await this.json<{ user: { id: string } }>(
        '/api/session',
        'POST',
        { account, password },
      );
      assert.equal(
        result.user.id,
        this.actor.id,
        `${this.actor.key}: 登录身份不符`,
      );
      const session = await this.json<{ user: { id: string } }>('/api/session');
      assert.equal(
        session.user.id,
        this.actor.id,
        `${this.actor.key}: 会话身份不符`,
      );
    }
    async logout() {
      if (this.cookie) await this.request('/api/session', 'DELETE');
    }
  }

  const sorted = (values: string[]) => [...values].sort();
  const ids = (values: { id: string }[]) =>
    sorted(values.map((value) => value.id));
  const near = (actual: number, expected: number, label: string) =>
    assert(
      Math.abs(actual - expected) < 0.000001,
      `${label}: ${actual} != ${expected}`,
    );
  const sum = (values: { hours: number }[]) =>
    values.reduce((total, value) => total + value.hours, 0);
  const metadataFields: Record<string, string[]> = {
    groups: ['name', 'parentId', 'sortOrder'],
    projects: [
      'name',
      'description',
      'groupId',
      'stage',
      'ownerId',
      'initiatedOn',
      'launchOn',
      'acceptanceOn',
      'maintenanceUntil',
      'plannedDays',
      'plannedAmount',
      'repositoryUrl',
      'deploymentTarget',
      'deploymentBranch',
      'deploymentCommand',
    ],
    modules: ['projectId', 'name', 'description'],
    projectMembers: ['projectId', 'participantId', 'role', 'canWrite'],
    teams: ['name', 'description', 'memberIds', 'ownerId'],
    agents: [
      'name',
      'description',
      'avatar',
      'teamId',
      'modelChannelId',
      'model',
      'protocol',
      'sandboxId',
      'skillIds',
      'mcpServerIds',
      'enabled',
    ],
    roles: ['name', 'description', 'permissions', 'memberIds', 'enabled'],
    tasks: [
      'projectId',
      'moduleId',
      'name',
      'description',
      'assigneeId',
      'collaboratorIds',
      'plannedStart',
      'plannedEnd',
      'plannedHours',
      'actualStart',
      'actualEnd',
      'actualHours',
      'status',
      'cancellationReason',
    ],
    documents: [
      'title',
      'body',
      'scope',
      'projectId',
      'teamId',
      'visibility',
      'ownerId',
    ],
    efforts: ['taskId', 'projectId', 'actorId', 'date', 'hours', 'note'],
    attachments: [
      'projectId',
      'taskId',
      'documentId',
      'ownerId',
      'name',
      'mime',
      'size',
    ],
  };
  function compareEntity(
    entity: Entity,
    actual: Record<string, unknown>,
    kind: string,
  ) {
    for (const field of metadataFields[kind] ?? []) {
      if (!(field in entity)) continue;
      const expected = entity[field],
        value = actual[field];
      assert.deepEqual(
        Array.isArray(value) ? sorted(value) : value,
        Array.isArray(expected) ? sorted(expected) : expected,
        `${kind}/${entity.key}: ${field}`,
      );
    }
  }
  function weekday(value: string) {
    const day = new Date(`${value}T00:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6;
  }
  function days(from: string, to: string) {
    const start = Date.parse(`${from}T00:00:00Z`),
      end = Date.parse(`${to}T00:00:00Z`);
    assert(Number.isFinite(start) && Number.isFinite(end) && end >= start);
    assert(end - start <= 3660 * 86400000, 'fixture 日期跨度过大');
    return Array.from(
      { length: Math.round((end - start) / 86400000) + 1 },
      (_, index) =>
        new Date(start + index * 86400000).toISOString().slice(0, 10),
    );
  }

  try {
    const actors: Actor[] = [
      { ...manifest.owner, key: 'owner' },
      ...manifest.members,
    ];
    const actorIdFor = (key: string) => {
      const actor = actors.find((candidate) => candidate.key === key);
      if (actor) return actor.id;
      if (key === 'agent-code') {
        const assignee = manifest.tasks.find(
          (task) => task.key === 'desk-agent',
        )?.assigneeId;
        if (typeof assignee === 'string' && assignee) return assignee;
      }
      return manifest.agents.find((agent) => agent.key === key)?.id ?? key;
    };
    const snapshots = new Map<string, WorkSnapshot>();
    for (const actor of actors) {
      const client = new HttpActor(actor);
      clients.push(client);
      await client.login();
      const available = await client.json<{ workspaces: { id: string }[] }>(
        '/api/workspaces',
      );
      assert(
        available.workspaces.some((workspace) => workspace.id === workspaceId),
      );
      const snapshot = await client.json<WorkSnapshot>(`${endpoint}/manage`);
      assert.equal(snapshot.actorId, actor.id);
      assert.equal(
        snapshot.canAdmin,
        actor.key === 'owner',
        `${actor.key}: 空间管理角色`,
      );
      snapshots.set(actor.key, snapshot);
      assert.deepEqual(
        ids(snapshot.projects),
        sorted(manifest.expectations.visibleProjectIdsByActor[actor.key]!),
        `${actor.key}: 项目 ACL`,
      );
      assert.deepEqual(
        ids(snapshot.documents),
        sorted(manifest.expectations.visibleDocumentIdsByActor[actor.key]!),
        `${actor.key}: 三空间文档 ACL`,
      );
      const permissions = manifest.expectations.permissionsByActor?.[actor.key];
      if (permissions)
        assert.deepEqual(
          sorted(snapshot.permissions),
          sorted(permissions),
          `${actor.key}: 角色授权`,
        );
      const visibleProjectIds = new Set(
        snapshot.projects.map((project) => project.id),
      );
      for (const collection of [
        snapshot.tasks,
        snapshot.modules,
        snapshot.efforts,
        snapshot.projectMembers,
      ])
        assert(
          collection.every((item) => visibleProjectIds.has(item.projectId)),
          `${actor.key}: 项目子资源越界`,
        );
      for (const document of snapshot.documents) {
        if (document.scope === 'personal' || document.visibility === 'private')
          assert.equal(
            document.ownerId,
            actor.id,
            `${actor.key}: 私有文档越界`,
          );
      }
      for (const [kind, fields] of Object.entries(metadataFields)) {
        void fields;
        const expected = manifest[kind as keyof FixtureManifest];
        const actual = snapshot[kind as keyof WorkSnapshot];
        if (!Array.isArray(expected) || !Array.isArray(actual)) continue;
        for (const entity of expected as Entity[]) {
          const found = (actual as { id: string }[]).find(
            (item) => item.id === entity.id,
          );
          if (found) compareEntity(entity, found, kind);
        }
      }
      const downloaded: string[] = [];
      for (const attachment of manifest.attachments) {
        const expectedVisible = attachment.visibleTo
          ? attachment.visibleTo.includes(actor.key)
          : Boolean(
              attachment.target.taskId
                ? snapshot.tasks.some(
                    (task) => task.id === attachment.target.taskId,
                  )
                : snapshot.documents.some(
                    (document) => document.id === attachment.target.documentId,
                  ),
            );
        assert.equal(
          snapshot.attachments.some((item) => item.id === attachment.id),
          expectedVisible,
          `${actor.key}: 附件列表 ACL`,
        );
        const response = await client.request(
          `${endpoint}/attachments/${attachment.id}`,
        );
        if (!expectedVisible) {
          assert.equal(response.status, 403, `${actor.key}: 私有附件下载 ACL`);
          continue;
        }
        assert.equal(response.status, 200, `${actor.key}: 附件下载失败`);
        assert.match(
          response.headers.get('content-disposition') ?? '',
          /^attachment;/,
        );
        const content = Buffer.from(await response.arrayBuffer());
        assert.equal(
          content.byteLength,
          attachment.size,
          `${actor.key}: 附件长度`,
        );
        assert.equal(
          createHash('sha256').update(content).digest('hex'),
          attachment.sha256,
          `${actor.key}: 附件 SHA256`,
        );
        downloaded.push(attachment.id);
      }
      actorReports[actor.key] = {
        identityId: actor.id,
        projects: snapshot.projects.length,
        documents: snapshot.documents.length,
        efforts: snapshot.efforts.length,
        downloadedAttachments: downloaded,
      };
    }
    checks.push('全部测试人员经真实协作身份登录；空间与项目/文档/附件逐人 ACL');
    const owner = snapshots.get('owner')!;
    assert.equal(owner.projects.length, 8, '固定场景项目数');
    assert.equal(owner.tasks.length, 36, '固定场景任务数');
    assert.equal(owner.efforts.length, 34, '固定场景工时条数');
    near(sum(owner.efforts), 188, '固定场景全部实际工时');
    assert.equal(manifest.documents.length, 12, '固定场景文档数');
    assert.equal(manifest.attachments.length, 6, '固定场景附件数');
    assert(
      owner.participants.some(
        (participant) =>
          participant.id === actorIdFor('agent-code') &&
          participant.kind === 'agent',
      ),
      '未来Agent任务须分配给Agent参与者',
    );
    const members = await clients[0]!.json<{
      members: { identityId: string; role: string }[];
    }>(`${endpoint}/members`);
    for (const actor of actors) {
      const membership = members.members.find(
        (member) => member.identityId === actor.id,
      );
      assert(membership, `${actor.key}: 空间成员缺失`);
      assert.equal(
        membership.role,
        actor.key === 'owner' ? 'owner' : 'member',
        `${actor.key}: 空间成员角色`,
      );
    }
    for (const [kind, count] of Object.entries(manifest.expectations.counts)) {
      const actual = owner[kind as keyof WorkSnapshot];
      assert(Array.isArray(actual), `未知计数项: ${kind}`);
      assert.equal(actual.length, count, `owner: ${kind} 总数`);
    }
    for (const kind of [
      'groups',
      'projects',
      'modules',
      'teams',
      'agents',
      'roles',
      'tasks',
      'efforts',
    ] as const)
      assert.deepEqual(
        ids(owner[kind]),
        ids(manifest[kind]),
        `${kind}: 缺失或多余记录`,
      );
    if (manifest.projectMembers)
      assert.deepEqual(
        ids(owner.projectMembers),
        ids(manifest.projectMembers),
        '项目职责矩阵完整性',
      );
    assert.deepEqual(
      sorted([
        ...new Set(
          [...snapshots.values()].flatMap((snapshot) =>
            snapshot.attachments.map((attachment) => attachment.id),
          ),
        ),
      ]),
      ids(manifest.attachments),
      '附件全集',
    );
    assert.deepEqual(
      sorted([
        ...new Set(
          [...snapshots.values()].flatMap((snapshot) =>
            snapshot.documents.map((document) => document.id),
          ),
        ),
      ]),
      ids(manifest.documents),
      '三空间文档全集',
    );
    assert.deepEqual(
      sorted([
        ...new Set(
          manifest.documents.map((document) => String(document.scope)),
        ),
      ]),
      ['personal', 'project', 'team'],
    );
    const projectMap = new Map(
      owner.projects.map((project) => [project.id, project]),
    );
    assert.deepEqual(
      sorted([...new Set(owner.projects.map((project) => project.stage))]),
      sorted([
        'presales',
        'initiated',
        'executing',
        'launched',
        'maintenance',
        'closed',
        'frozen',
        'cancelled',
      ]),
      '八个项目阶段覆盖',
    );
    assert.deepEqual(
      sorted([...new Set(owner.tasks.map((task) => task.status))]),
      sorted([
        'not_started',
        'in_progress',
        'completed',
        'closed',
        'paused',
        'cancelled',
      ]),
      '六个任务状态覆盖',
    );
    for (const project of owner.projects) {
      for (const field of [
        'initiatedOn',
        'launchOn',
        'acceptanceOn',
        'maintenanceUntil',
      ] as const)
        assert(
          project[field] === null || /^\d{4}-\d{2}-\d{2}$/.test(project[field]),
          `项目日期格式: ${field}`,
        );
      const sequence = [
        project.initiatedOn,
        project.launchOn,
        project.acceptanceOn,
        project.maintenanceUntil,
      ].filter((date): date is string => date !== null);
      assert(
        sequence.every(
          (date, index) => index === 0 || date >= sequence[index - 1]!,
        ),
        `${project.id}: 项目里程碑先后关系`,
      );
    }
    for (const task of owner.tasks) {
      assert(projectMap.has(task.projectId));
      if (task.moduleId)
        assert(
          owner.modules.some(
            (module) =>
              module.id === task.moduleId &&
              module.projectId === task.projectId,
          ),
        );
      const entries = owner.efforts.filter((entry) => entry.taskId === task.id);
      assert(
        entries.every((entry) => entry.projectId === task.projectId),
        `${task.id}: 工时项目归属`,
      );
      near(task.actualHours, sum(entries), `${task.id}: 实际工时汇总`);
      if (task.status === 'cancelled')
        assert(task.cancellationReason.trim(), `${task.id}: 取消原因缺失`);
      if (task.actualStart)
        assert(
          task.actualStart <= asOfDate,
          `${task.id}: 实际开始在场景日之后`,
        );
      if (task.actualEnd) {
        assert(
          task.actualStart && task.actualEnd >= task.actualStart,
          `${task.id}: 实际完成早于开始`,
        );
        assert(task.actualEnd <= asOfDate, `${task.id}: 实际完成在场景日之后`);
      }
      const project = projectMap.get(task.projectId)!;
      if (project.stage === 'closed' && project.maintenanceUntil) {
        if (task.actualStart)
          assert(
            task.actualStart <= project.maintenanceUntil,
            `${task.id}: 实际开始超过维护结束`,
          );
        if (task.actualEnd)
          assert(
            task.actualEnd <= project.maintenanceUntil,
            `${task.id}: 实际完成超过维护结束`,
          );
        assert(
          entries.every((entry) => entry.date <= project.maintenanceUntil!),
          `${task.id}: 工时超过维护结束`,
        );
      }
      assert(
        entries.every(
          (entry) =>
            entry.date <= asOfDate &&
            Boolean(task.actualStart) &&
            entry.date >= task.actualStart! &&
            (!task.actualEnd || entry.date <= task.actualEnd),
        ),
        `${task.id}: 工时超出实际执行日期区间`,
      );
      assert(
        owner.taskEvents.some(
          (event) => event.taskId === task.id && event.kind === 'created',
        ),
        `${task.id}: 创建时间轴缺失`,
      );
    }
    for (const entry of owner.efforts) {
      assert(
        owner.tasks.some((task) => task.id === entry.taskId),
        '工时任务缺失',
      );
      const sameDay = owner.efforts.filter(
        (effort) =>
          effort.actorId === entry.actorId && effort.date === entry.date,
      );
      assert(sum(sameDay) <= 24, `${entry.actorId}: 同日登记超过24小时`);
      assert(
        owner.participants.some(
          (participant) =>
            participant.id === entry.actorId && participant.kind === 'human',
        ),
        '工时必须属于实际填报人员',
      );
      assert(
        entry.hours > 0 &&
          entry.hours <= 24 &&
          /^\d{4}-\d{2}-\d{2}$/.test(entry.date),
      );
    }
    checks.push(
      '项目日期、模块和成员角色、任务创建事件、工时任务/项目/本人归属及汇总',
    );
    const window = manifest.expectations.resourceWindow;
    assert.equal(window.capacityHours, 8);
    const windowDays = new Set(days(window.from, window.to));
    for (const [key, expected] of Object.entries(window.plannedHoursByActor)) {
      const actorId = actorIdFor(key);
      const planned = owner.tasks
        .filter((task) => task.assigneeId === actorId)
        .reduce((total, task) => {
          if (
            task.status === 'cancelled' ||
            task.plannedHours === null ||
            !task.plannedStart ||
            !task.plannedEnd
          )
            return total;
          const workdays = days(task.plannedStart, task.plannedEnd).filter(
            weekday,
          );
          const included = workdays.filter((day) => windowDays.has(day)).length;
          return (
            total +
            (workdays.length
              ? (task.plannedHours * included) / workdays.length
              : 0)
          );
        }, 0);
      near(planned, expected, `${key}: 时间窗计划工时`);
    }
    for (const [key, expected] of Object.entries(window.actualHoursByActor)) {
      const actorId = actorIdFor(key);
      near(
        sum(
          owner.efforts.filter(
            (effort) =>
              effort.actorId === actorId && windowDays.has(effort.date),
          ),
        ),
        expected,
        `${key}: 时间窗实际工时`,
      );
    }
    if (manifest.expectations.totals) {
      near(
        sum(owner.efforts),
        manifest.expectations.totals.effortHours,
        '全部登记工时',
      );
      near(
        owner.tasks.reduce(
          (total, task) => total + (task.plannedHours ?? 0),
          0,
        ),
        manifest.expectations.totals.plannedHours,
        '全部任务计划工时',
      );
    }
    if (manifest.expectations.dailyEfforts) {
      const expectedDays = new Map(
        manifest.expectations.dailyEfforts.map((entry) => [
          `${actorIdFor(entry.actor)}:${entry.date}`,
          entry.hours,
        ]),
      );
      for (const actor of actors)
        for (const date of windowDays) {
          const expected = expectedDays.get(`${actor.id}:${date}`) ?? 0;
          near(
            sum(
              owner.efforts.filter(
                (entry) => entry.actorId === actor.id && entry.date === date,
              ),
            ),
            expected,
            `${actor.key}/${date}: 逐日实际工时`,
          );
        }
    }
    const plannedAt = (actorId: string, date: string) =>
      owner.tasks
        .filter(
          (task) =>
            task.assigneeId === actorId &&
            task.status !== 'cancelled' &&
            task.plannedStart &&
            task.plannedEnd &&
            task.plannedHours !== null &&
            date >= task.plannedStart &&
            date <= task.plannedEnd,
        )
        .reduce((total, task) => {
          const scheduled = days(task.plannedStart!, task.plannedEnd!).filter(
            weekday,
          );
          return (
            total +
            (weekday(date) && scheduled.length
              ? task.plannedHours! / scheduled.length
              : 0)
          );
        }, 0);
    for (const [key, dailyHours] of Object.entries({
      owner: 0,
      zhangsan: 10,
      lisi: 8,
      wangwu: 2,
      zhaoliu: 0,
    }))
      for (const date of windowDays)
        near(
          plannedAt(actorIdFor(key), date),
          weekday(date) ? dailyHours : 0,
          `${key}/${date}: 固定场景逐日计划`,
        );
    for (const actor of actors)
      for (const date of windowDays) {
        const workingHistory = date >= '2026-11-09' && date <= '2026-11-13';
        const expected = !workingHistory
          ? 0
          : actor.key === 'zhangsan'
            ? 9
            : actor.key === 'lisi'
              ? 6
              : actor.key === 'wangwu'
                ? date === '2026-11-12'
                  ? 7
                  : 2
                : 0;
        near(
          sum(
            owner.efforts.filter(
              (entry) => entry.actorId === actor.id && entry.date === date,
            ),
          ),
          expected,
          `${actor.key}/${date}: 固定场景逐日实际`,
        );
      }
    for (const [taskKey, actorKey, hours] of [
      ['desk-api', 'zhangsan', 7],
      ['board-feedback', 'zhangsan', 2],
      ['desk-web', 'lisi', 6],
      ['desk-research', 'wangwu', 2],
    ] as const) {
      const taskId = manifest.tasks.find((task) => task.key === taskKey)?.id;
      assert(taskId, `固定场景任务缺失: ${taskKey}`);
      for (const date of days('2026-11-09', '2026-11-13')) {
        const entries: WorkSnapshot['efforts'] = owner.efforts.filter(
          (entry) => entry.taskId === taskId && entry.date === date,
        );
        assert.equal(entries.length, 1, `${taskKey}/${date}: 填报条数`);
        assert.equal(
          entries[0]!.actorId,
          actorIdFor(actorKey),
          `${taskKey}/${date}: 实际填报人`,
        );
        near(entries[0]!.hours, hours, `${taskKey}/${date}: 实际工时`);
      }
    }
    const urgentId = manifest.tasks.find(
      (task) => task.key === 'desk-urgent',
    )?.id;
    const urgent = owner.efforts.filter((entry) => entry.taskId === urgentId);
    assert.equal(urgent.length, 1, '临时协助任务工时条数');
    assert.equal(
      urgent[0]!.actorId,
      actorIdFor('wangwu'),
      '临时协助工时必须归王五',
    );
    assert.equal(urgent[0]!.date, '2026-11-12', '临时协助任务工作日期');
    near(urgent[0]!.hours, 5, '临时协助任务工时');
    for (const date of windowDays)
      near(
        plannedAt(actorIdFor('agent-code'), date),
        ['2026-11-16', '2026-11-17'].includes(date) ? 4 : 0,
        `agent-code/${date}: Agent逐日计划`,
      );
    checks.push(
      '固定主窗逐日计划：张三10h、李四8h、王五2h；Agent仅11月16–17日各4h',
    );
    checks.push('分析时间窗按工作日独立分摊计划工时，并按实际填报人汇总');
    const report = {
      checkedAt: new Date().toISOString(),
      fixtureKey: manifest.fixtureKey,
      workspaceId,
      source:
        'Real Tandem HTTP and authenticated ZenTao identities; no fabricated session or business writes',
      checks,
      actors: actorReports,
      resourceWindow: window,
      urls: Object.fromEntries(
        ['projects', 'documents', 'tasks', 'analysis', 'agents', 'admin'].map(
          (view) => [view, `${origin}/?view=${view}&workspace=${workspaceId}`],
        ),
      ),
    };
    await writeFile(
      resolve(dirname(manifestPath), 'verification.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(
      `Fixture HTTP验收通过：${actors.length}个真实身份，${owner.projects.length}个项目，${owner.tasks.length}项任务，${owner.efforts.length}条工时；报告保存在ignored fixture目录。`,
    );
  } finally {
    await Promise.allSettled(clients.map((client) => client.logout()));
  }
}

await verify().catch((error: unknown) => {
  const reason =
    error instanceof assert.AssertionError && !error.generatedMessage
      ? error.message.split('\n')[0]
      : error instanceof Error &&
          /^(?:owner|zhangsan|lisi|wangwu|zhaoliu): (?:GET|POST) \/api\/[^\s]+ HTTP \d{3}$/.test(
            error.message,
          )
        ? error.message
        : '输入、网络或清单检查失败（未输出原始异常及响应）';
  console.error('Fixture HTTP验收失败：' + reason);
  process.exitCode = 1;
});
