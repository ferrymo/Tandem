import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect, type Locator, type Page } from '@playwright/test';
import type {
  DeliveryDetail,
  DeliveryRun,
  InstalledSkill,
  ProjectDraft,
  SkillBinding,
} from '../packages/core/src/index.js';

// Real localhost acceptance. Mutations are exclusively clicks/submissions in the
// authenticated product UI. GETs observe its durable records; no DB writes,
// synthetic sessions, route mocks, generated packages, or model substitutes.
const base = 'http://127.0.0.1:3000';
const workspaceId =
  process.env.TANDEM_ACCEPTANCE_WORKSPACE_ID ??
  '55250568-2570-44cf-8cfd-81eef409f249';
const upstream = new URL(process.env.TANDEM_IDENTITY_URL ?? '');
assert(['127.0.0.1', 'localhost'].includes(upstream.hostname));
assert.equal(upstream.port, '8088', 'Dedicated local collaboration instance');
const account = process.env.ZT_ACC;
const password = process.env.ZT_PWD;
assert(account && password, 'Load ignored .env.zentao.local');
const directory = resolve('data/acceptance/real-delivery');
const reportPath = resolve('data/acceptance/real-delivery-report.json');
await mkdir(directory, { recursive: true });
const safe = (value: string) =>
  [password, account, process.env.MODEL_API_KEY]
    .reduce<string>(
      (result, secret) =>
        secret ? result.replaceAll(secret, '[redacted]') : result,
      value,
    )
    .replace(/tandem_session=[^\s;]+/g, 'tandem_session=[redacted]')
    .replace(/cookie:[^\r\n]*/gi, 'cookie: [redacted]');
type Check = {
  name: string;
  status: 'passed' | 'failed';
  at: string;
  detail: unknown;
};
type RunRecord = {
  goal: string;
  runId?: string;
  latest?: DeliveryDetail;
  preview?: unknown;
  zip?: unknown;
  deploymentDraftId?: string;
  deploymentDraft?: ProjectDraft;
  deployment?: unknown;
  rollbackDraftId?: string;
  rollbackDraft?: ProjectDraft;
  rollback?: unknown;
  resumeEvidence?: unknown;
  resumeHistory?: unknown[];
  budgetExtensionHistory?: unknown[];
  failedDeploymentDrafts?: ProjectDraft[];
};
type Report = {
  runKey: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  workspaceId: string;
  projectId: string;
  externalProjectId: string;
  source: string;
  skillName: string;
  skillMarker: string;
  skill?: InstalledSkill;
  bindings?: SkillBinding[];
  capabilityUsage?: unknown;
  prepared?: boolean;
  runs: Record<'baseline' | 'upgrade', RunRecord>;
  checks: Check[];
  currentChecks?: Check[];
  browserErrors: string[];
  networkFailures: { resource: string; status: number }[];
  screenshots?: string[];
  dockerEvents?: {
    name: string;
    image: string;
    exitCode: string | null;
    time: number;
    event: string;
  }[];
  dockerObserverError?: string;
  stops?: { at: string; error: string }[];
  interactionTrace?: unknown[];
  browserConsoleErrors?: string[];
};
let report: Report;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
  assert.equal(report.workspaceId, workspaceId);
  assert.equal(report.externalProjectId, '3');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
    throw error;
  const runKey =
    'real-delivery-' + new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  report = {
    runKey,
    startedAt: new Date().toISOString(),
    updatedAt: '',
    workspaceId,
    projectId: '',
    externalProjectId: '3',
    source:
      'Actual local product UI, configured real model, durable Worker and Docker',
    skillName: runKey + '-split-quality',
    skillMarker: 'resource-' + randomUUID(),
    runs: {
      baseline: { goal: `${runKey} 费用拆分 V1` },
      upgrade: { goal: `${runKey} 费用拆分 V2` },
    },
    checks: [],
    browserErrors: [],
    networkFailures: [],
  };
}
async function save() {
  report.updatedAt = new Date().toISOString();
  report.currentChecks = [
    ...new Map(report.checks.map((item) => [item.name, item])).values(),
  ];
  const temporary = reportPath + '.tmp';
  await writeFile(temporary, safe(JSON.stringify(report, null, 2)) + '\n');
  await rename(temporary, reportPath);
}
// Observe real short-lived execution containers without exposing arbitrary
// container metadata or environment. This never creates/changes a container.
const dockerObserver = spawn(
  'docker',
  [
    'events',
    '--format',
    '{{json .}}',
    '--filter',
    'type=container',
    '--filter',
    'event=start',
    '--filter',
    'event=die',
  ],
  {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  },
);
let dockerBuffer = '';
dockerObserver.stdout.on('data', (chunk: Buffer) => {
  dockerBuffer += chunk.toString();
  const lines = dockerBuffer.split('\n');
  dockerBuffer = lines.pop() ?? '';
  if (dockerBuffer.length > 100000) dockerBuffer = '';
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        Action?: string;
        time?: number;
        Actor?: { Attributes?: Record<string, string> };
      };
      const attributes = event.Actor?.Attributes;
      if (
        !attributes?.name?.startsWith('tandem-') ||
        !['start', 'die'].includes(event.Action ?? '')
      )
        continue;
      report.dockerEvents ??= [];
      report.dockerEvents.push({
        name: attributes.name,
        image: attributes.image ?? '',
        exitCode: attributes.exitCode ?? null,
        time: event.time ?? 0,
        event: event.Action!,
      });
    } catch {
      /* Ignore incomplete/unsupported daemon messages. */
    }
  }
});
dockerObserver.on('error', (error) => {
  report.dockerObserverError = safe(error.message);
});
async function check(name: string, action: () => Promise<unknown>) {
  if (
    report.checks.some((item) => item.name === name && item.status === 'passed')
  )
    return;
  try {
    const detail = await action();
    report.checks.push({
      name,
      status: 'passed',
      at: new Date().toISOString(),
      detail,
    });
    console.log(JSON.stringify({ check: name, status: 'passed' }));
  } catch (error) {
    const detail = safe(String(error instanceof Error ? error.message : error));
    report.checks.push({
      name,
      status: 'failed',
      at: new Date().toISOString(),
      detail,
    });
    console.log(JSON.stringify({ check: name, status: 'failed', detail }));
    throw error;
  } finally {
    await save();
  }
}
const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  locale: 'zh-CN',
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
function observePage(observed: Page) {
  observed.on('console', (message) => {
    if (message.type() === 'error') {
      report.browserConsoleErrors ??= [];
      report.browserConsoleErrors.push(safe(message.text()));
    }
  });
  observed.on('pageerror', (error) =>
    report.browserErrors.push(safe(error.message)),
  );
  observed.on('response', (response) => {
    if (response.url().startsWith(base) && response.status() >= 500)
      report.networkFailures.push({
        resource:
          new URL(response.url()).searchParams.get('resource') ??
          new URL(response.url()).pathname,
        status: response.status(),
      });
  });
}
observePage(page);
context.on('page', observePage);
async function read<T>(resource: string, params: Record<string, string> = {}) {
  const response = await page.request.get(
    `${base}/api/workspaces/${workspaceId}/product?` +
      new URLSearchParams({ resource, ...params }),
  );
  assert.equal(
    response.status(),
    200,
    `${resource}: ${safe(await response.text())}`,
  );
  return (await response.json()) as T;
}
async function command<T>(name: string, action: () => Promise<unknown>) {
  const waiting = page.waitForResponse((response) => {
    if (
      !response.url().startsWith(base) ||
      !response.url().includes('/product?') ||
      response.request().method() !== 'POST'
    )
      return false;
    try {
      return response.request().postDataJSON().command === name;
    } catch {
      return false;
    }
  });
  const [response] = await Promise.all([waiting, action()]);
  const value = await response.json();
  assert.equal(
    response.status(),
    200,
    `${name}: ${safe(JSON.stringify(value))}`,
  );
  return value as T;
}
async function navigate(view: string) {
  await page.goto(`${base}/?view=${view}&workspace=${workspaceId}`);
  await expect(page.locator('#project-scope')).toBeVisible();
  if (
    report.projectId &&
    (await page.locator('#project-scope').inputValue()) !== report.projectId
  )
    await page.locator('#project-scope').selectOption(report.projectId);
  await expect(page.locator('.loading-rows')).toHaveCount(0, {
    timeout: 30000,
  });
}
async function closeDrawer() {
  const drawer = page.getByRole('dialog', {
    name: '运行详情与交付证据',
    exact: true,
  });
  if (await drawer.count()) {
    await drawer.getByRole('button', { name: /^(Close|关闭)$/ }).click();
    await expect(drawer).toHaveCount(0);
  }
}
async function screenshot(target: Page | Locator, name: string) {
  if (!process.argv.includes('--screenshots')) return;
  const path = resolve(directory, name + '.png');
  await target.screenshot({ path, animations: 'disabled' });
  report.screenshots ??= [];
  if (!report.screenshots.includes(path)) report.screenshots.push(path);
  await save();
}
async function openRun(record: RunRecord) {
  await closeDrawer();
  await navigate('observe');
  const row = page.locator('.product-rows > li').filter({
    has: page.getByRole('button', { name: record.goal, exact: true }),
  });
  await row.getByRole('button', { name: '查看运行', exact: true }).click();
  const drawer = page.getByRole('dialog', {
    name: '运行详情与交付证据',
    exact: true,
  });
  await expect(
    drawer.getByRole('heading', { name: record.goal, exact: true }),
  ).toBeVisible();
  return drawer;
}
async function snapshotRun(kind: 'baseline' | 'upgrade') {
  const record = report.runs[kind];
  assert(record.runId);
  const detail = await read<DeliveryDetail>('run', { run: record.runId });
  record.latest = detail;
  await writeFile(
    resolve(directory, `${kind}-run.json`),
    safe(JSON.stringify(detail, null, 2)) + '\n',
  );
  for (const document of detail.documents)
    await writeFile(
      resolve(
        directory,
        `${kind}-${document.role}-${document.kind}-${document.version}.txt`,
      ),
      safe(document.content),
    );
  await save();
  return detail;
}
async function prepare() {
  await navigate('capabilities');
  let overview = await read<{ skills: InstalledSkill[] }>('capabilities');
  let skill = overview.skills.find((item) => item.name === report.skillName);
  if (!skill) {
    const bundle = {
      name: report.skillName,
      version: '1.0.0',
      description:
        '专用真实模型验收：人民币分摊、无障碍交互与业务测试复核，无额外权限。',
      source: {
        kind: 'upload',
        label: `${report.runKey} 本机专用验收文本技能`,
      },
      permissions: [],
      dependencies: [],
      files: {
        'SKILL.md': `---\nname: ${report.skillName}\ndescription: Read the expense split acceptance reference and apply its business rules.\n---\n在设计、实现和复核当前费用拆分目标之前，必须按需读取 references/split-acceptance.md。使用系统提供的skillReads JSON读取实际目录skillId和该相对路径；不要在没有读取时假称使用技能。只在本阶段尚未收到该资源时读取一次，收到后继续完成本阶段要求的最终格式。设计文档必须写出资源中的验证标识，工程交付summary或limitations也必须写出同一标识，以留下可核对的真实读取证据。工程及复核输出仍遵循系统要求的严格JSON，不加Markdown围栏。该技能只有文本规则，不授予网络、文件系统或外部系统写权限。\n`,
        'references/split-acceptance.md': `费用拆分规则（真实验收资源）\n资源验证标识：${report.skillMarker}\n人民币按整数分计算，最多两位小数，总额非负、人数1至20的整数。余数从第一人起逐分分配，100元3人应为33.34、33.33、33.33且总和100.00。零元合法；负数、空值、超过两位小数、非数字、零人数和非整数人数均明确报错。显示初始空态、计算结果、错误、重置；模拟范围为本地输入计算，没有支付、存储和真实费用数据。采用共享业务纯函数并在Node测试中断言真实返回值/错误；浏览器真正使用同一份业务代码。测试不能只检查字符串或assert(true)。\n`,
      },
    };
    const bundlePath = resolve(directory, 'split-quality.skill.json');
    await writeFile(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
    await page
      .getByRole('button', { name: '安装技能 / 新版本', exact: true })
      .click();
    const modal = page.getByRole('dialog', {
      name: '安装技能 / 新版本',
      exact: true,
    });
    await modal
      .getByLabel('导入完整技能包', { exact: true })
      .setInputFiles(bundlePath);
    await expect(modal.getByLabel('技能名称', { exact: true })).toHaveValue(
      report.skillName,
    );
    await command('install-skill', () =>
      modal.getByRole('button', { name: '验证并安装', exact: true }).click(),
    );
    await expect(modal).toHaveCount(0);
    overview = await read<{ skills: InstalledSkill[] }>('capabilities');
    skill = overview.skills.find((item) => item.name === report.skillName);
  }
  assert(skill);
  const row = page
    .locator('.capability-list > li')
    .filter({ has: page.getByText(report.skillName, { exact: true }) });
  await row.locator('summary').first().click();
  if (!skill.enabled) {
    await command('toggle-skill', () =>
      row.getByRole('button', { name: '启用技能', exact: true }).click(),
    );
    await navigate('capabilities');
    await row.locator('summary').first().click();
  }
  const version = skill.versions.find((item) => item.version === '1.0.0');
  assert(version);
  await row.getByLabel('查看版本').selectOption(version.id);
  if (skill.activeVersionId !== version.id) {
    await command('activate-skill', () =>
      row.getByRole('button', { name: '切换生效版本', exact: true }).click(),
    );
    await navigate('capabilities');
    await row.locator('summary').first().click();
  }
  for (const role of ['designer', 'engineer']) {
    const bindings = await read<{ skills: SkillBinding[] }>(
      'capability-bindings',
      { project: report.projectId },
    );
    if (
      !bindings.skills.some(
        (item) =>
          item.skillId === skill.id &&
          item.versionId === version.id &&
          item.agentRole === role &&
          item.enabled,
      )
    ) {
      await row.getByLabel('成员范围').selectOption(role);
      await command('bind-skill', () =>
        row
          .getByRole('button', { name: '绑定到当前项目', exact: true })
          .click(),
      );
      await navigate('capabilities');
      await row.locator('summary').first().click();
    }
  }
  const installed = (
    await read<{ skills: InstalledSkill[] }>('capabilities')
  ).skills.find((item) => item.id === skill.id);
  assert(installed);
  report.skill = installed;
  report.bindings = (
    await read<{ skills: SkillBinding[] }>('capability-bindings', {
      project: report.projectId,
    })
  ).skills.filter((item) => item.skillId === skill.id);
  await navigate('agents');
  await page.getByRole('button', { name: '配置 T 组', exact: true }).click();
  const modal = page.getByRole('dialog', {
    name: 'T 组模型与职责',
    exact: true,
  });
  for (let index = 0; index < 3; index++) {
    await modal.getByLabel('模型名称', { exact: true }).nth(index).fill('');
    await modal
      .getByLabel('补充要求')
      .nth(index)
      .fill(
        `${report.runKey} 专用验收配置。严格完成当前系统阶段，控制范围，采用简洁中文。${index !== 1 ? '当前费用拆分目标必须实际读取并使用已绑定的split-quality技能references/split-acceptance.md；只在当前调用上下文尚未收到该资源时先输出skillReads JSON，资源收到后立即完成当前阶段。不要省略技能资源中的验证标识。' : '负责最小离线架构、共享业务逻辑、真实行为测试、本地演示部署健康与回滚复核。'} 不调用与目标无关的MCP工具。工程和复核阶段只输出系统要求的JSON，禁止Markdown围栏。`,
      );
  }
  await command('configure-team', () =>
    modal.getByRole('button', { name: '保存配置', exact: true }).click(),
  );
  await expect(modal).toHaveCount(0);
  report.prepared = true;
  await save();
  return {
    skillId: skill.id,
    versionId: version.id,
    roles: ['designer', 'engineer'],
    permissions: [],
  };
}
const acceptance = (kind: 'baseline' | 'upgrade') =>
  `完成小型费用拆分Demo${kind === 'upgrade' ? ' V2：页面顶部明确显示“费用拆分 V2”，增加可见的“按整数分精确分配”说明；其余业务与V1一致' : ' V1：页面顶部明确显示“费用拆分 V1”'}。1.只有两个文本输入（type=text、适当inputmode，由JS统一验证，避免浏览器原生校验阻止错误态），精确无障碍label分别为“账单总额（元）”“分摊人数”，按钮“计算分摊”“重置”；姓名用张三、李四、王五，后续用第N人。2.初始结果为空，显示说明；100元3人显示33.34、33.33、33.33，总和100.00；0元2人显示两个0.00；负数、空、非数字、三位小数、人数0/2.5/21报可见错误，清除旧结果。3.采用#share-list容器，成功时每人一项li，每项data-cents属性为整数分；错误容器#split-error用role=alert；#split-summary显示总和（两位小数），重置清空输入/结果/错误。4.宽390px无横向溢出，键盘可提交，错误与结果有屏幕阅读器状态。5.浏览器与node --test必须用同一份业务源文件split.js（可兼容Node的module.exports）；用node build.mjs把该源文件和经典交互脚本内联进最终index.html的script标签中，CSS内联。页面不引用任何外部JS/CSS/模块、不用fetch、localStorage或其他存储；预览iframe为opaque origin，外部资源请求无会话。buildCommands必须真实运行该构建脚本。node测试实际覆盖金额余数/零/错误边界，禁止伪测试。工程约四五个小文件，总计约15KB。6.页面明确“本地演示：不支付、不保存，不接入真实费用数据”；无网络依赖。7.设计师与工程师必须先实际读取已绑定专用技能的reference，设计文档和工程summary/limitations引用读取到的资源验证标识，不能只宣称技能已绑定。8.复核实际文件与Docker测试证据，交付模式只为本地演示。`;
async function ensureRun(kind: 'baseline' | 'upgrade') {
  const record = report.runs[kind];
  if (!record.runId) {
    const runs = await read<{ runs: DeliveryRun[] }>('runs', {
      project: report.projectId,
    });
    const previous = runs.runs.find((run) => run.goal === record.goal);
    if (previous) {
      record.runId = previous.id;
      await save();
    }
  }
  if (record.runId) return;
  await navigate('agents');
  const form = page.locator('section.content-panel').filter({
    has: page.getByRole('heading', { name: '给 T 组一个目标', exact: true }),
  });
  await form.getByLabel('交付目标', { exact: true }).fill(record.goal);
  await form.getByLabel('验收条件', { exact: true }).fill(acceptance(kind));
  await form
    .locator('select')
    .nth(0)
    .selectOption(kind === 'baseline' ? 'demo' : 'deploy');
  await form.locator('select').nth(1).selectOption('team');
  await form.getByText('预算与返工上限', { exact: true }).click();
  await form.getByLabel('最多模型调用', { exact: true }).fill('18');
  await form.getByLabel('最多 Tokens', { exact: true }).fill('350000');
  await form.getByLabel('最多返工次数', { exact: true }).fill('2');
  const run = await command<DeliveryRun>('start-run', () =>
    form.getByRole('button', { name: '交给 T 组', exact: true }).click(),
  );
  record.runId = run.id;
  await save();
  assert(record.runId);
}
async function waitRun(
  kind: 'baseline' | 'upgrade',
  deployment = false,
  rollback = false,
) {
  const timeout =
    Number(
      process.argv
        .find((item) => item.startsWith('--watch-minutes='))
        ?.split('=')[1] ?? 25,
    ) * 60000;
  assert(timeout >= 60000 && timeout <= 3600000);
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    const detail = await snapshotRun(kind);
    const run = detail.run;
    if (deployment || rollback) {
      const record = report.runs[kind];
      const draftId = rollback
        ? record.rollbackDraftId
        : record.deploymentDraftId;
      const draft = (
        await read<{ drafts: ProjectDraft[] }>('drafts', {
          project: report.projectId,
        })
      ).drafts.find((item) => item.id === draftId);
      assert(draft, 'Approved deployment draft must remain readable');
      if (rollback) record.rollbackDraft = draft;
      else record.deploymentDraft = draft;
      await writeFile(
        resolve(
          directory,
          `${kind}-${rollback ? 'rollback' : 'deployment'}-draft-latest.json`,
        ),
        safe(JSON.stringify(draft, null, 2)) + '\n',
      );
      await save();
      if (['failed', 'rejected', 'unknown'].includes(draft.status))
        throw new Error(
          `Deployment draft ${draft.id} is ${draft.status}: ${draft.error ?? ''}; inspect evidence before any retry.`,
        );
    }
    const stage = `${run.status}/${run.phase}/${run.usedCalls}/${run.revision}/${run.deployment?.status ?? ''}`;
    if (stage !== last) {
      console.log(
        JSON.stringify({
          kind,
          runId: run.id,
          status: run.status,
          phase: run.phase,
          usedCalls: run.usedCalls,
          usedTokens: run.usedTokens,
          revision: run.revision,
          deployment: run.deployment?.status,
        }),
      );
      last = stage;
    }
    if (
      rollback
        ? run.deployment?.status === 'rolled_back'
        : deployment
          ? run.deployment?.status === 'healthy'
          : ['delivered', 'awaiting_deployment'].includes(run.status)
    )
      return detail;
    if (
      [
        'needs_auth',
        'needs_configuration',
        'needs_decision',
        'failed',
        'cancelled',
        'paused',
      ].includes(run.status)
    )
      throw new Error(
        `Real run stopped: ${run.status} / ${run.phase}: ${run.error ?? ''}. Durable run saved; inspect and resume through UI.`,
      );
    await new Promise((done) => setTimeout(done, 5000));
  }
  throw new Error(
    'Run still active after watch interval; rerun this script to observe the same durable run.',
  );
}
async function verifyDocuments(kind: 'baseline' | 'upgrade') {
  const detail = await snapshotRun(kind);
  type SkillRead = {
    role: string;
    phase: string;
    skillId: string;
    versionId: string;
    path: string;
    contentHash: string;
    byteLength: number;
    truncated: boolean;
  };
  const reads = detail.documents
    .filter((document) => document.kind.startsWith('skill_resources.'))
    .flatMap((document) => JSON.parse(document.content) as SkillRead[]);
  const reference = report.skill?.versions.find(
    (version) => version.id === report.skill?.activeVersionId,
  )?.files['references/split-acceptance.md'];
  assert(reference);
  const expectedHash = createHash('sha256')
    .update(reference, 'utf8')
    .digest('hex');
  for (const [role, phase] of [
    ['designer', kind === 'baseline' ? 'design_review' : 'design'],
    ['engineer', 'implementation'],
  ] as const) {
    const audit = reads.find(
      (read) =>
        read.role === role &&
        read.phase === phase &&
        read.skillId === report.skill?.id &&
        read.versionId === report.skill.activeVersionId &&
        read.path === 'references/split-acceptance.md',
    );
    assert(
      audit,
      `${role}/${phase} must have a real resource-read audit, never synthesized from output`,
    );
    assert.equal(audit.contentHash, expectedHash);
    assert.equal(audit.byteLength, Buffer.byteLength(reference, 'utf8'));
    assert.equal(audit.truncated, false);
    assert(
      detail.events.some(
        (event) => event.kind === 'skill_resources_read' && event.role === role,
      ),
    );
  }
  for (const [role, documentKind] of [
    ['designer', 'design'],
    ['architect', 'architecture'],
    ['engineer', 'implementation'],
    ['designer', 'design_review'],
    ['architect', 'technical_review'],
  ] as const)
    assert(
      detail.documents.some(
        (document) => document.role === role && document.kind === documentKind,
      ),
      `${role}/${documentKind}`,
    );
  assert(
    detail.documents.some(
      (document) =>
        document.kind === 'design' &&
        document.content.includes(report.skillMarker),
    ),
    'Designer must cite marker available only in skill reference',
  );
  assert(
    detail.documents.some(
      (document) =>
        document.kind === 'implementation' &&
        document.content.includes(report.skillMarker),
    ),
    'Engineer must cite marker available only in skill reference',
  );
  assert(detail.run.artifact?.passed);
  assert(
    detail.run.artifact.commands.some(
      (item) =>
        item.command[0] === 'node' &&
        item.command.includes('--test') &&
        item.exitCode === 0 &&
        /pass|tests|✔|ok /i.test(item.output),
    ),
    'Actual Docker node:test output',
  );
  assert(detail.run.usedCalls >= 5 && detail.run.usedTokens > 0);
  const drawer = await openRun(report.runs[kind]);
  await drawer.getByRole('tab', { name: '方案与交接', exact: true }).click();
  await expect(drawer).toContainText('产品设计');
  await expect(drawer).toContainText('技能资源读取记录');
  if (kind === 'baseline') {
    await drawer
      .locator('summary')
      .filter({ hasText: '技能资源读取记录' })
      .last()
      .scrollIntoViewIfNeeded();
    await screenshot(page, 'baseline-desktop-chinese-documents');
  }
  await drawer.getByRole('tab', { name: '交付物', exact: true }).click();
  await expect(drawer).toContainText('验证通过');
  await expect(drawer).toContainText(
    '这里记录构建、行为测试与入口检查；交互效果请打开预览验收。',
  );
  await drawer
    .getByRole('button', { name: '打开隔离预览', exact: true })
    .scrollIntoViewIfNeeded();
  await screenshot(page, `${kind}-desktop-run-detail`);
  return {
    usedCalls: detail.run.usedCalls,
    usedTokens: detail.run.usedTokens,
    artifact: detail.run.artifact,
    documents: detail.documents.map(({ kind, role, version }) => ({
      kind,
      role,
      version,
    })),
    skillReadAudit: reads,
  };
}
async function interact(target: Page | Locator, version: 'V1' | 'V2') {
  await expect(
    target.getByRole('heading', { name: `费用拆分 ${version}`, exact: true }),
  ).toBeVisible();
  const total = target.getByLabel('账单总额（元）', { exact: true });
  const people = target.getByLabel('分摊人数', { exact: true });
  const calculate = target.getByRole('button', {
    name: '计算分摊',
    exact: true,
  });
  await expect
    .poll(() =>
      target
        .locator('#share-list')
        .evaluate((element) => element.ownerDocument.readyState),
    )
    .toBe('complete');
  await target.locator('#share-list').evaluate((element) => {
    const doc = element.ownerDocument;
    const observation: unknown[] = [];
    (
      doc.defaultView as unknown as Record<string, unknown>
    ).__tandemAcceptanceEvents = observation;
    for (const kind of ['click', 'submit'])
      doc.addEventListener(
        kind,
        (event) => {
          const target = event.target as HTMLElement;
          observation.push({
            type: event.type,
            tag: target.tagName,
            id: target.id,
            text: target.textContent?.slice(0, 40),
          });
        },
        true,
      );
  });
  async function actualClick(button: Locator) {
    await button.scrollIntoViewIfNeeded();
    let previous = '';
    await expect
      .poll(async () => {
        const box = await button.boundingBox();
        const viewport = button.page().viewportSize();
        if (!box || !viewport) return false;
        const key = [box.x, box.y, box.width, box.height]
          .map((value) => value.toFixed(1))
          .join(',');
        const stable = key === previous;
        previous = key;
        const inside =
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width &&
          box.y + box.height <= viewport.height;
        const hitsButton = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = element.ownerDocument.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return hit === element || (!!hit && element.contains(hit));
        });
        return stable && inside && hitsButton;
      })
      .toBe(true);
    await button.click();
  }
  async function trace(step: string) {
    const snapshot = {
      at: new Date().toISOString(),
      version,
      step,
      total: await total.inputValue(),
      people: await people.inputValue(),
      shares: await target.locator('#share-list li').evaluateAll((items) =>
        items.map((item) => ({
          text: item.textContent,
          cents: item.getAttribute('data-cents'),
        })),
      ),
      error: await target.locator('#split-error').textContent(),
      summary: await target.locator('#split-summary').textContent(),
      buttonBox: await calculate.boundingBox(),
      parent: await calculate.page().evaluate(() => ({
        viewport: { width: innerWidth, height: innerHeight },
        drawers: [
          ...Array.from(
            document.querySelectorAll('.ant-drawer-content-wrapper'),
          ),
        ].map((element) => ({
          rect: element.getBoundingClientRect().toJSON(),
          transform: getComputedStyle(element).transform,
          transition: getComputedStyle(element).transitionDuration,
        })),
        animations: document.getAnimations().map((animation) => ({
          playState: animation.playState,
          currentTime: animation.currentTime,
          effect: animation.effect?.getTiming(),
        })),
      })),
      document: await target.locator('#share-list').evaluate((element) => ({
        url: element.ownerDocument.URL,
        readyState: element.ownerDocument.readyState,
        apiType: typeof (
          element.ownerDocument.defaultView as unknown as Record<
            string,
            unknown
          >
        ).SplitExpense,
        events: (
          element.ownerDocument.defaultView as unknown as Record<
            string,
            unknown
          >
        ).__tandemAcceptanceEvents,
        scriptPrefix: element.ownerDocument.scripts[0]?.textContent?.slice(
          0,
          30,
        ),
        buttons: Array.from(
          element.ownerDocument.querySelectorAll('button'),
        ).map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            text: button.textContent,
            rect: rect.toJSON(),
            hit: element.ownerDocument.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            )?.outerHTML,
            active: element.ownerDocument.activeElement?.outerHTML,
          };
        }),
      })),
    };
    report.interactionTrace ??= [];
    report.interactionTrace.push(snapshot);
    await save();
  }
  await total.fill('100');
  await people.fill('3');
  await trace('before-initial-100/3');
  await actualClick(calculate);
  await trace('after-initial-100/3');
  await expect(target.locator('#share-list li')).toHaveCount(3);
  const cents = await target
    .locator('#share-list li')
    .evaluateAll((items) =>
      items.map((item) => Number(item.getAttribute('data-cents'))),
    );
  assert.deepEqual(cents, [3334, 3333, 3333]);
  await expect(target.locator('#split-summary')).toContainText('100.00');
  const announcement = await target
    .locator('#split-summary')
    .evaluate((element) => {
      const live = element.closest(
        '[aria-live], [role="status"], [role="alert"]',
      );
      return {
        role: live?.getAttribute('role') ?? null,
        ariaLive: live?.getAttribute('aria-live') ?? null,
      };
    });
  assert(
    ['status', 'alert'].includes(announcement.role ?? '') ||
      ['polite', 'assertive'].includes(announcement.ariaLive ?? ''),
    'Results must have a live announcement semantic',
  );
  await total.fill('0');
  await people.fill('2');
  await people.press('Enter');
  await trace('after-keyboard-0/2');
  await expect(target.locator('#share-list li')).toHaveCount(2);
  assert.deepEqual(
    await target
      .locator('#share-list li')
      .evaluateAll((items) =>
        items.map((item) => Number(item.getAttribute('data-cents'))),
      ),
    [0, 0],
  );
  const invalid = [
    ['-1', '2'],
    ['1.001', '2'],
    ['abc', '2'],
    ['', '2'],
    ['1', '0'],
    ['1', '2.5'],
    ['1', '21'],
  ];
  for (const [amount, count] of invalid) {
    await total.fill(amount!);
    await people.fill(count!);
    await actualClick(calculate);
    await trace(`after-invalid-${amount}/${count}`);
    await expect(target.locator('#split-error')).toBeVisible();
    await expect(target.locator('#split-error')).toHaveAttribute(
      'role',
      'alert',
    );
    await expect(target.locator('#split-error')).not.toBeEmpty();
    await expect(target.locator('#share-list li')).toHaveCount(0);
  }
  await actualClick(target.getByRole('button', { name: '重置', exact: true }));
  await trace('after-reset');
  await expect(total).toHaveValue('');
  await expect(people).toHaveValue('');
  await expect(target.locator('#share-list li')).toHaveCount(0);
  await expect(target.locator('#split-error')).toBeEmpty();
  await total.fill('100');
  await people.fill('3');
  await actualClick(calculate);
  await trace('after-reset-100/3');
  await expect(target.locator('#share-list li')).toHaveCount(3);
  return {
    version,
    cents,
    remainderTotal: cents.reduce((a, b) => a + b),
    zero: [0, 0],
    invalidCases: invalid,
    reset: 'fields and results cleared',
    keyboardSubmit: true,
    accessibility: {
      errorRole: 'alert',
      resultAnnouncement: announcement,
      actualScreenReader: 'not_performed',
    },
  };
}
async function verifyPreview(kind: 'baseline' | 'upgrade') {
  const record = report.runs[kind];
  const drawer = await openRun(record);
  await drawer.getByRole('tab', { name: '交付物', exact: true }).click();
  await drawer
    .getByRole('button', { name: '打开隔离预览', exact: true })
    .click();
  const frame = page.frameLocator('iframe[title="交付物隔离预览"]');
  // FrameLocator shares the Locator query surface; scope it through body.
  record.preview = await interact(
    frame.locator('body'),
    kind === 'baseline' ? 'V1' : 'V2',
  );
  await screenshot(
    page.locator('iframe[title="交付物隔离预览"]'),
    `${kind}-opaque-preview`,
  );
  const downloadPromise = page.waitForEvent('download');
  await drawer.getByRole('link', { name: '下载交付包', exact: true }).click();
  const download = await downloadPromise;
  const zipPath = resolve(directory, `${kind}-delivery.zip`);
  await download.saveAs(zipPath);
  const bytes = await readFile(zipPath);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert(bytes.length > 1000);
  record.zip = {
    path: zipPath,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await closeDrawer();
  const previewPage = await context.newPage();
  await previewPage.setViewportSize({ width: 390, height: 844 });
  await previewPage.goto(
    `${base}/api/workspaces/${workspaceId}/artifacts/${record.runId}/preview/index.html`,
  );
  const mobile = await interact(previewPage, kind === 'baseline' ? 'V1' : 'V2');
  const width = await previewPage.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert(
    width.scroll <= width.viewport,
    '390px preview must not horizontally overflow',
  );
  await screenshot(previewPage, `${kind}-mobile-demo`);
  await previewPage.close();
  if (process.argv.includes('--screenshots')) {
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileDrawer = await openRun(record);
    if (kind === 'baseline') {
      await mobileDrawer
        .getByRole('tab', { name: '方案与交接', exact: true })
        .click();
      await expect(mobileDrawer).toContainText('技能资源读取记录');
      await mobileDrawer
        .locator('summary')
        .filter({ hasText: '技能资源读取记录' })
        .last()
        .scrollIntoViewIfNeeded();
      await screenshot(page, 'baseline-mobile-chinese-documents');
    }
    await mobileDrawer
      .getByRole('tab', { name: '交付物', exact: true })
      .click();
    await mobileDrawer
      .getByRole('button', { name: '打开隔离预览', exact: true })
      .scrollIntoViewIfNeeded();
    await screenshot(page, `${kind}-mobile-run-detail`);
    await closeDrawer();
    await page.setViewportSize({ width: 1366, height: 900 });
  }
  await save();
  return {
    iframe: record.preview,
    mobile: { ...mobile, width },
    zip: record.zip,
  };
}
async function approveDraft(draft: ProjectDraft) {
  assert.equal(draft.projectId, report.projectId);
  const action = draft.action;
  assert(
    'runId' in action &&
      Object.values(report.runs).some((item) => item.runId === action.runId),
  );
  if (draft.status === 'pending') {
    await closeDrawer();
    await navigate('focus');
    const row = page
      .locator('.draft-list > li')
      .filter({
        has: page.getByRole('heading', { name: draft.title, exact: true }),
      })
      .filter({
        hasText:
          action.kind === 'delivery.rollback'
            ? action.deploymentId
            : action.runId,
      })
      .filter({
        has: page.getByRole('button', {
          name: `批准版本 ${draft.version}`,
          exact: true,
        }),
      });
    await expect(row).toContainText('待审阅');
    const result = await command<ProjectDraft>('review-draft', () =>
      row
        .getByRole('button', { name: `批准版本 ${draft.version}`, exact: true })
        .click(),
    );
    assert.equal(result.id, draft.id);
  } else
    assert(
      ['approved', 'executing', 'succeeded'].includes(draft.status),
      `Draft ${draft.id}: ${draft.status} ${draft.error ?? ''}`,
    );
}
async function deploy(kind: 'baseline' | 'upgrade') {
  const record = report.runs[kind];
  let detail = await snapshotRun(kind);
  if (detail.run.deployment?.status === 'healthy') {
    record.deployment = detail.run.deployment;
    return record.deployment;
  }
  let drafts = (
    await read<{ drafts: ProjectDraft[] }>('drafts', {
      project: report.projectId,
    })
  ).drafts;
  let draft = drafts.find(
    (item) =>
      item.action.kind === 'delivery.deploy' &&
      item.action.runId === record.runId,
  );
  if (draft && ['failed', 'rejected', 'unknown'].includes(draft.status)) {
    const failedId = draft.id;
    record.failedDeploymentDrafts ??= [];
    if (!record.failedDeploymentDrafts.some((item) => item.id === failedId))
      record.failedDeploymentDrafts.push(draft);
    await writeFile(
      resolve(directory, `${kind}-failed-deployment-${draft.id}.json`),
      safe(JSON.stringify(draft, null, 2)) + '\n',
    );
    await save();
  }
  if (
    draft &&
    ['failed', 'rejected'].includes(draft.status) &&
    process.argv.includes(`--retry-deploy-${kind}`)
  )
    draft = undefined;
  if (!draft) {
    const drawer = await openRun(record);
    await drawer.getByRole('tab', { name: '交付物', exact: true }).click();
    draft = await command<ProjectDraft>('create-draft', () =>
      drawer
        .getByRole('button', { name: '申请本地演示部署', exact: true })
        .click(),
    );
  }
  record.deploymentDraftId = draft.id;
  await save();
  await approveDraft(draft);
  detail = await waitRun(kind, true);
  assert(detail.run.deployment?.status === 'healthy');
  record.deployment = detail.run.deployment;
  const deployed = await context.newPage();
  const response = await deployed.goto(
    `${base}/api/workspaces/${workspaceId}/artifacts/${record.runId}/deployment/index.html`,
  );
  assert.equal(response?.status(), 200);
  const interaction = await interact(
    deployed,
    kind === 'baseline' ? 'V1' : 'V2',
  );
  await deployed.close();
  drafts = (
    await read<{ drafts: ProjectDraft[] }>('drafts', {
      project: report.projectId,
    })
  ).drafts;
  const receipt = drafts.find((item) => item.id === draft.id);
  assert.equal(receipt?.status, 'succeeded');
  await writeFile(
    resolve(directory, `${kind}-deployment-draft.json`),
    safe(JSON.stringify(receipt, null, 2)) + '\n',
  );
  await save();
  return {
    deployment: record.deployment,
    receipt,
    browserHTTP: 200,
    interaction,
  };
}
async function rollback() {
  const record = report.runs.upgrade;
  let detail = await snapshotRun('upgrade');
  if (detail.run.deployment?.status === 'rolled_back') {
    record.rollback = detail.run.deployment;
    return record.rollback;
  }
  assert(detail.run.deployment?.status === 'healthy');
  const baseline = report.runs.baseline.latest?.run.deployment;
  assert(baseline);
  assert.equal(
    detail.run.deployment.previousDeploymentId,
    baseline.id,
    'V2 must point to actual V1 deployment',
  );
  let draft = (
    await read<{ drafts: ProjectDraft[] }>('drafts', {
      project: report.projectId,
    })
  ).drafts.find(
    (item) =>
      item.action.kind === 'delivery.rollback' &&
      item.action.runId === record.runId,
  );
  if (!draft) {
    const drawer = await openRun(record);
    await drawer.getByRole('tab', { name: '交付物', exact: true }).click();
    draft = await command<ProjectDraft>('create-draft', () =>
      drawer.getByRole('button', { name: '申请回滚', exact: true }).click(),
    );
  }
  record.rollbackDraftId = draft.id;
  await save();
  await approveDraft(draft);
  detail = await waitRun('upgrade', false, true);
  assert.equal(detail.run.deployment?.status, 'rolled_back');
  assert.equal(detail.run.deployment.contentHash, baseline.contentHash);
  record.rollback = detail.run.deployment;
  const deployed = await context.newPage();
  const response = await deployed.goto(
    `${base}/api/workspaces/${workspaceId}/artifacts/${record.runId}/deployment/index.html`,
  );
  assert.equal(response?.status(), 200);
  const interaction = await interact(deployed, 'V1');
  await screenshot(deployed, 'rollback-restored-v1');
  await deployed.close();
  const receipt = (
    await read<{ drafts: ProjectDraft[] }>('drafts', {
      project: report.projectId,
    })
  ).drafts.find((item) => item.id === draft.id);
  assert.equal(receipt?.status, 'succeeded');
  await writeFile(
    resolve(directory, 'rollback-draft.json'),
    safe(JSON.stringify(receipt, null, 2)) + '\n',
  );
  await save();
  return {
    deployment: record.rollback,
    restoredContentHash: baseline.contentHash,
    browserHTTP: 200,
    interaction,
    receipt,
  };
}
try {
  await page.goto(base);
  await page.getByLabel('协作账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  const login = page.waitForResponse(
    (response) =>
      response.url() === base + '/api/session' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '登录', exact: true }).click();
  assert.equal((await login).status(), 200);
  await expect(page.locator('#workspace-selector')).toBeVisible();
  await page.locator('#workspace-selector').selectOption(workspaceId);
  const projects = await read<{
    projects: {
      id: string;
      externalId: string;
      name: string;
      canWrite: boolean;
    }[];
  }>('projects');
  const project = projects.projects.find(
    (item) => item.externalId === report.externalProjectId,
  );
  assert(
    project?.canWrite && project.name.includes('验收'),
    'Use only writable dedicated acceptance project',
  );
  report.projectId = project.id;
  await save();
  if (!report.prepared)
    await check(
      'Install, enable and bind fixed text skill and configure actual T group',
      prepare,
    );
  for (const kind of ['baseline', 'upgrade'] as const) {
    const extension = process.argv.find((argument) =>
      argument.startsWith(`--extend-${kind}=`),
    );
    if (!extension) continue;
    const calls = Number(extension.split('=')[1]);
    const before = await snapshotRun(kind);
    assert(
      Number.isInteger(calls) &&
        calls >= before.run.budgetCalls &&
        calls <= 100,
    );
    const drawer = await openRun(report.runs[kind]);
    await drawer.getByText('调整累计预算', { exact: true }).click();
    await drawer.getByLabel('总调用上限', { exact: true }).fill(String(calls));
    await expect(
      drawer.getByLabel('总 Token 上限', { exact: true }),
    ).toHaveValue(String(before.run.budgetTokens));
    const after = await command<DeliveryRun>('extend-budget', () =>
      drawer.getByRole('button', { name: '增加预算上限', exact: true }).click(),
    );
    assert.equal(after.usedCalls, before.run.usedCalls);
    assert.equal(after.usedTokens, before.run.usedTokens);
    assert.equal(after.budgetTokens, before.run.budgetTokens);
    assert.equal(after.maxRevisions, before.run.maxRevisions);
    assert.equal(after.budgetCalls, calls);
    const evidence = {
      at: new Date().toISOString(),
      before: {
        budgetCalls: before.run.budgetCalls,
        usedCalls: before.run.usedCalls,
        usedTokens: before.run.usedTokens,
      },
      after: {
        budgetCalls: after.budgetCalls,
        usedCalls: after.usedCalls,
        usedTokens: after.usedTokens,
        budgetTokens: after.budgetTokens,
        maxRevisions: after.maxRevisions,
      },
    };
    report.runs[kind].budgetExtensionHistory ??= [];
    report.runs[kind].budgetExtensionHistory.push(evidence);
    await save();
    await snapshotRun(kind);
    await closeDrawer();
    console.log(
      JSON.stringify({ action: 'extend-budget-through-UI', kind, ...evidence }),
    );
  }
  if (!process.argv.includes('--prepare-only')) {
    const profiles = await read<{
      model: { configured: boolean };
      execution: { configured: boolean };
    }>('profiles');
    assert(
      profiles.model.configured && profiles.execution.configured,
      'Root must configure real model and restart services first',
    );
    for (const kind of ['baseline', 'upgrade'] as const) {
      if (kind === 'upgrade' && process.argv.includes('--baseline-only')) break;
      await ensureRun(kind);
      if (process.argv.includes(`--resume-${kind}`)) {
        const before = await snapshotRun(kind);
        assert(
          [
            'paused',
            'needs_auth',
            'needs_configuration',
            'needs_decision',
            'failed',
          ].includes(before.run.status),
          'Only explicitly resume a stopped durable run',
        );
        const drawer = await openRun(report.runs[kind]);
        const after = await command<DeliveryRun>('control-run', () =>
          drawer.getByRole('button', { name: '继续运行', exact: true }).click(),
        );
        assert.equal(after.id, before.run.id);
        assert.equal(after.usedCalls, before.run.usedCalls);
        assert.equal(after.usedTokens, before.run.usedTokens);
        const record = report.runs[kind];
        record.resumeHistory ??= record.resumeEvidence
          ? [record.resumeEvidence]
          : [];
        record.resumeEvidence = {
          before: {
            status: before.run.status,
            phase: before.run.phase,
            usedCalls: before.run.usedCalls,
            usedTokens: before.run.usedTokens,
          },
          after: {
            status: after.status,
            phase: after.phase,
            usedCalls: after.usedCalls,
            usedTokens: after.usedTokens,
          },
          at: new Date().toISOString(),
        };
        record.resumeHistory.push(record.resumeEvidence);
        await save();
        await closeDrawer();
      }
      await waitRun(kind);
      await check(
        `${kind}: real roles, skill reference use and Docker business tests`,
        () => verifyDocuments(kind),
      );
      await check(
        `${kind}: isolated preview, desktop/mobile interactions and ZIP`,
        () => verifyPreview(kind),
      );
      await check(
        `${kind}: approve local deployment, health receipt and actual entry`,
        () => deploy(kind),
      );
    }
    if (!process.argv.includes('--baseline-only'))
      await check(
        'Approve V2 rollback and verify restored V1 entry and content hash',
        rollback,
      );
    report.capabilityUsage = await read('capability-usage', {
      project: report.projectId,
    });
    if (!process.argv.includes('--baseline-only'))
      report.completedAt ??= new Date().toISOString();
  }
  console.log(
    JSON.stringify({
      report: reportPath,
      prepared: report.prepared,
      completed: !!report.completedAt,
      checks: report.currentChecks?.map(({ name, status }) => ({
        name,
        status,
      })),
      browserErrors: report.browserErrors.length,
      networkFailures: report.networkFailures.length,
    }),
  );
} catch (error) {
  const message = safe(String(error instanceof Error ? error.message : error));
  report.stops ??= [];
  report.stops.push({ at: new Date().toISOString(), error: message });
  console.log(
    JSON.stringify({
      status: 'stopped',
      error: message,
      report: reportPath,
    }),
  );
  process.exitCode = 1;
} finally {
  dockerObserver.kill();
  await save();
  await browser.close();
}
