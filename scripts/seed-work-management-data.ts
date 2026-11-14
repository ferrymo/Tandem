import type {
  ProjectStage,
  WorkTaskStatus,
} from '../packages/core/src/index.js';

export const fixtureKey = 'tandem-work-management-20261114-v1';
export const workspaceName = 'Tandem 产品验收 · 2026-11';
export const window = {
  from: '2026-11-09',
  to: '2026-11-20',
  capacityHours: 8,
};
export const people = [
  { key: 'zhangsan', name: '张三' },
  { key: 'lisi', name: '李四' },
  { key: 'wangwu', name: '王五' },
  { key: 'zhaoliu', name: '赵六' },
] as const;
export type ActorKey = 'owner' | (typeof people)[number]['key'];
export const groups = [
  { key: 'delivery', name: '客户交付', parent: null },
  { key: 'enterprise', name: '企业平台', parent: 'delivery' },
  { key: 'annual', name: '2026 年度专项', parent: 'enterprise' },
  { key: 'research', name: '研究与运营', parent: null },
];
export const projects: {
  key: string;
  name: string;
  stage: ProjectStage;
  group: string;
  initiatedOn: string | null;
  launchOn: string | null;
  acceptanceOn: string | null;
  maintenanceUntil: string | null;
  plannedDays: number;
  plannedAmount: number;
  description: string;
  modules: [string, string];
}[] = [
  {
    key: 'presales',
    name: '学术会议协作平台',
    stage: 'presales',
    group: 'research',
    initiatedOn: null,
    launchOn: null,
    acceptanceOn: null,
    maintenanceUntil: null,
    plannedDays: 18,
    plannedAmount: 56000,
    description: '售前方案评估，尚未立项；预算为估算，不代表合同收入。',
    modules: ['需求调研', '方案与报价'],
  },
  {
    key: 'initiated',
    name: '科研知识门户',
    stage: 'initiated',
    group: 'annual',
    initiatedOn: '2026-11-09',
    launchOn: '2026-12-18',
    acceptanceOn: '2026-12-25',
    maintenanceUntil: '2027-12-24',
    plannedDays: 40,
    plannedAmount: 128000,
    description: '立项完成，正在梳理知识分类与交付边界。',
    modules: ['知识结构', '检索体验'],
  },
  {
    key: 'executing',
    name: '客户服务工作台',
    stage: 'executing',
    group: 'annual',
    initiatedOn: '2026-10-26',
    launchOn: '2026-11-27',
    acceptanceOn: '2026-12-04',
    maintenanceUntil: '2027-12-03',
    plannedDays: 60,
    plannedAmount: 186000,
    description:
      '主要执行项目；11 月 9 日至 20 日用于资源负载验收。日期是业务计划，导入审计保留真实时间。',
    modules: ['服务流程', '工程与质量'],
  },
  {
    key: 'launched',
    name: '运营数据看板',
    stage: 'launched',
    group: 'enterprise',
    initiatedOn: '2026-10-12',
    launchOn: '2026-11-12',
    acceptanceOn: '2026-11-20',
    maintenanceUntil: '2027-11-19',
    plannedDays: 36,
    plannedAmount: 98000,
    description:
      '已于 11 月 12 日上线，正在收集验收反馈；部署字段只记录配置，未运行自动化部署。',
    modules: ['指标口径', '数据展示'],
  },
  {
    key: 'maintenance',
    name: '文献检索助手',
    stage: 'maintenance',
    group: 'research',
    initiatedOn: '2026-08-03',
    launchOn: '2026-09-11',
    acceptanceOn: '2026-09-18',
    maintenanceUntil: null,
    plannedDays: 45,
    plannedAmount: 145000,
    description: '已验收，长期维护；维护结束日期留空。',
    modules: ['检索服务', '运维支持'],
  },
  {
    key: 'closed',
    name: '培训报名系统',
    stage: 'closed',
    group: 'enterprise',
    initiatedOn: '2026-06-01',
    launchOn: '2026-07-17',
    acceptanceOn: '2026-07-24',
    maintenanceUntil: '2026-10-30',
    plannedDays: 30,
    plannedAmount: 86000,
    description: '交付与维护均已结束，保留资料、任务及测试填报记录。',
    modules: ['报名流程', '交付归档'],
  },
  {
    key: 'frozen',
    name: '移动巡检工具',
    stage: 'frozen',
    group: 'annual',
    initiatedOn: '2026-10-19',
    launchOn: '2026-12-04',
    acceptanceOn: '2026-12-11',
    maintenanceUntil: '2027-12-10',
    plannedDays: 50,
    plannedAmount: 160000,
    description:
      '11 月 6 日因客户资源调整冻结；保留原目标日期，冻结任务不占用当前周未来计划。',
    modules: ['离线采集', '同步验证'],
  },
  {
    key: 'cancelled',
    name: '旧站迁移试点',
    stage: 'cancelled',
    group: 'enterprise',
    initiatedOn: '2026-10-05',
    launchOn: null,
    acceptanceOn: null,
    maintenanceUntil: null,
    plannedDays: 20,
    plannedAmount: 48000,
    description:
      '11 月 4 日因业务范围调整取消，尚未上线；已发生工作与取消原因保留。',
    modules: ['迁移评估', '取消复盘'],
  },
];
export type TaskSpec = {
  key: string;
  project: string;
  module: number;
  name: string;
  status: WorkTaskStatus;
  assignee: ActorKey | 'agent-code' | null;
  collaborators: ActorKey[];
  plannedStart: string | null;
  plannedEnd: string | null;
  plannedHours: number | null;
  actualStart: string | null;
  actualEnd: string | null;
  cancellationReason: string;
};
function task(
  key: string,
  project: string,
  name: string,
  status: WorkTaskStatus,
  assignee: TaskSpec['assignee'],
  options: Partial<TaskSpec> = {},
): TaskSpec {
  const historical = ['completed', 'closed', 'paused', 'cancelled'].includes(
    status,
  );
  return {
    key,
    project,
    name,
    status,
    assignee,
    module: 0,
    collaborators: [],
    plannedStart: historical ? '2026-11-02' : '2026-11-23',
    plannedEnd: historical ? '2026-11-06' : '2026-11-27',
    plannedHours: 8,
    actualStart:
      status === 'not_started'
        ? null
        : historical
          ? '2026-11-02'
          : '2026-11-13',
    actualEnd: ['completed', 'closed'].includes(status) ? '2026-11-06' : null,
    cancellationReason:
      status === 'cancelled' ? '需求范围调整，经确认取消后续工作' : '',
    ...options,
  };
}
const current = { plannedStart: window.from, plannedEnd: window.to };
export const tasks: TaskSpec[] = [
  task(
    'sales-interview',
    'presales',
    '梳理参会方使用场景',
    'not_started',
    'owner',
  ),
  task(
    'sales-quote',
    'presales',
    '形成售前方案与报价',
    'not_started',
    'zhaoliu',
    { module: 1 },
  ),
  task(
    'portal-taxonomy',
    'initiated',
    '定义知识分类目录',
    'not_started',
    'wangwu',
  ),
  task(
    'portal-search',
    'initiated',
    '整理检索验收指标',
    'not_started',
    'lisi',
    { module: 1 },
  ),
  task(
    'portal-kickoff',
    'initiated',
    '准备项目启动材料',
    'not_started',
    'owner',
  ),
  task(
    'portal-boundary',
    'initiated',
    '确认资料使用边界',
    'in_progress',
    'zhaoliu',
  ),
  task('desk-api', 'executing', '实现服务流程接口', 'in_progress', 'zhangsan', {
    ...current,
    plannedHours: 80,
    actualStart: window.from,
    collaborators: ['lisi', 'wangwu'],
  }),
  task('desk-web', 'executing', '实现工作台交互界面', 'in_progress', 'lisi', {
    ...current,
    plannedHours: 80,
    actualStart: window.from,
    collaborators: ['wangwu'],
  }),
  task(
    'desk-research',
    'executing',
    '持续验证使用体验',
    'in_progress',
    'wangwu',
    { ...current, plannedHours: 20, actualStart: window.from },
  ),
  task(
    'desk-urgent',
    'executing',
    '临时排查导入数据问题',
    'in_progress',
    'lisi',
    {
      module: 1,
      plannedStart: null,
      plannedEnd: null,
      plannedHours: null,
      actualStart: '2026-11-12',
      collaborators: ['wangwu'],
    },
  ),
  task(
    'desk-agent',
    'executing',
    'Agent 整理接口测试清单',
    'not_started',
    'agent-code',
    {
      module: 1,
      plannedStart: '2026-11-16',
      plannedEnd: '2026-11-17',
      plannedHours: 8,
    },
  ),
  task(
    'desk-pipeline',
    'executing',
    '补充发布回滚说明',
    'not_started',
    'zhangsan',
    { module: 1 },
  ),
  task(
    'desk-unestimated',
    'executing',
    '等待确认任务估算与负责人',
    'not_started',
    null,
    {
      plannedStart: '2026-11-16',
      plannedEnd: '2026-11-17',
      plannedHours: null,
    },
  ),
  task(
    'desk-unscheduled',
    'executing',
    '安排学术术语校验',
    'not_started',
    'zhaoliu',
    { plannedStart: null, plannedEnd: null },
  ),
  task(
    'desk-design',
    'executing',
    '完成服务流程设计',
    'completed',
    'zhangsan',
    { actualEnd: '2026-11-05' },
  ),
  task(
    'desk-environment',
    'executing',
    '验证开发环境配置',
    'completed',
    'lisi',
    { module: 1 },
  ),
  task('desk-wait', 'executing', '等待外部字段说明', 'paused', 'zhangsan', {
    module: 1,
  }),
  task('desk-cancel', 'executing', '评估旧接口兼容分支', 'cancelled', 'lisi', {
    module: 1,
    cancellationReason: '重复需求，统一使用新接口',
  }),
  task(
    'board-feedback',
    'launched',
    '上线准备、指标核对与反馈',
    'in_progress',
    'zhangsan',
    { ...current, plannedHours: 20, actualStart: window.from },
  ),
  task('board-schema', 'launched', '确认指标口径', 'completed', 'zhangsan', {
    actualEnd: '2026-11-03',
  }),
  task('board-chart', 'launched', '完成图表交互验证', 'completed', 'lisi', {
    module: 1,
    actualEnd: '2026-11-04',
  }),
  task('board-release', 'launched', '关闭发布前检查项', 'closed', 'wangwu', {
    module: 1,
    actualEnd: '2026-11-05',
  }),
  task(
    'board-report',
    'launched',
    '整理下一期运营报表需求',
    'not_started',
    'wangwu',
  ),
  task(
    'search-index',
    'maintenance',
    '分析检索质量反馈',
    'in_progress',
    'zhaoliu',
  ),
  task(
    'search-watch',
    'maintenance',
    '整理维护巡检计划',
    'in_progress',
    'owner',
    { module: 1 },
  ),
  task(
    'search-guide',
    'maintenance',
    '修订检索使用说明',
    'in_progress',
    'wangwu',
  ),
  task('search-fix', 'maintenance', '完成文献去重修复', 'completed', 'wangwu'),
  task(
    'search-close',
    'maintenance',
    '关闭上一轮维护工单',
    'closed',
    'zhangsan',
    {
      module: 1,
      plannedStart: '2026-10-26',
      plannedEnd: '2026-10-30',
      actualStart: '2026-10-26',
      actualEnd: '2026-10-30',
    },
  ),
  task(
    'training-flow',
    'closed',
    '完成报名流程维护复核',
    'closed',
    'zhangsan',
    {
      plannedStart: '2026-10-19',
      plannedEnd: '2026-10-19',
      actualStart: '2026-10-19',
      actualEnd: '2026-10-19',
    },
  ),
  task('training-archive', 'closed', '归档维护交接资料', 'closed', 'lisi', {
    module: 1,
    plannedStart: '2026-10-20',
    plannedEnd: '2026-10-20',
    actualStart: '2026-10-20',
    actualEnd: '2026-10-20',
  }),
  task('training-close', 'closed', '确认维护结束记录', 'closed', 'wangwu', {
    module: 1,
    plannedStart: '2026-10-21',
    plannedEnd: '2026-10-21',
    actualStart: '2026-10-21',
    actualEnd: '2026-10-21',
  }),
  task('mobile-offline', 'frozen', '等待采集设备到位', 'paused', 'zhaoliu'),
  task('mobile-sync', 'frozen', '暂停同步压力验证', 'paused', 'lisi', {
    module: 1,
  }),
  task('mobile-check', 'frozen', '完成离线采集原型复核', 'completed', 'lisi', {
    actualEnd: '2026-11-03',
  }),
  task(
    'migration-path',
    'cancelled',
    '取消旧站迁移实施',
    'cancelled',
    'zhangsan',
    {
      plannedStart: '2026-10-26',
      plannedEnd: '2026-11-04',
      actualStart: null,
      cancellationReason: '客户计划取消，停止后续实施',
    },
  ),
  task(
    'migration-review',
    'cancelled',
    '取消数据迁移验证',
    'cancelled',
    'wangwu',
    {
      module: 1,
      plannedStart: '2026-10-26',
      plannedEnd: '2026-11-04',
      actualStart: null,
      cancellationReason: '范围缩减，无需迁移旧数据',
    },
  ),
];
export type EffortSpec = {
  actor: ActorKey;
  task: string;
  date: string;
  hours: number;
  note: string;
};
export const efforts: EffortSpec[] = [];
for (const date of [
  '2026-11-09',
  '2026-11-10',
  '2026-11-11',
  '2026-11-12',
  '2026-11-13',
]) {
  efforts.push(
    {
      actor: 'zhangsan',
      task: 'desk-api',
      date,
      hours: 7,
      note: '服务流程接口开发与验证',
    },
    {
      actor: 'zhangsan',
      task: 'board-feedback',
      date,
      hours: 2,
      note: '跨项目上线反馈核对',
    },
    {
      actor: 'lisi',
      task: 'desk-web',
      date,
      hours: 6,
      note: '工作台界面开发与回归',
    },
    {
      actor: 'wangwu',
      task: 'desk-research',
      date,
      hours: 2,
      note: '使用体验走查与反馈整理',
    },
  );
}
efforts.push({
  actor: 'wangwu',
  task: 'desk-urgent',
  date: '2026-11-12',
  hours: 5,
  note: '协助李四排查临时问题；计划未排期，实际归填报人王五',
});
for (const item of tasks.filter((item) =>
  ['completed', 'closed'].includes(item.status),
)) {
  efforts.push({
    actor: item.assignee as ActorKey,
    task: item.key,
    date: item.actualEnd!,
    hours: 8,
    note: '测试场景历史导入：已完成工作核对，审计时间保留实际导入时间',
  });
}
efforts.push(
  {
    actor: 'zhangsan',
    task: 'desk-wait',
    date: '2026-11-04',
    hours: 8,
    note: '暂停前已完成字段调研，后续等待外部说明',
  },
  {
    actor: 'lisi',
    task: 'desk-cancel',
    date: '2026-11-05',
    hours: 2,
    note: '取消前已发生评估工时，保留实际消耗',
  },
);
export const documents: {
  key: string;
  title: string;
  scope: 'project' | 'team' | 'personal';
  project?: string;
  team?: string;
  actor: ActorKey;
  visibility: 'space' | 'private';
  body: string;
}[] = [
  {
    key: 'proposal',
    title: '客户服务工作台 · 项目方案',
    scope: 'project',
    project: 'executing',
    actor: 'owner',
    visibility: 'space',
    body: '# 项目方案\n\n## 目标\n让服务团队在一个工作台处理需求、进展和交付资料。\n\n## 交付边界\n- 服务流程与责任人\n- 模块化任务与工时\n- 文档和附件权限\n\n| 里程碑 | 计划日期 |\n| --- | --- |\n| 上线 | 2026-11-27 |\n| 验收 | 2026-12-04 |\n\n> 本空间为测试数据，不代表真实客户合同。',
  },
  {
    key: 'technical',
    title: '客户服务工作台 · 技术设计',
    scope: 'project',
    project: 'executing',
    actor: 'owner',
    visibility: 'space',
    body: '# 技术设计\n\n采用模块化服务、PostgreSQL 与独立 Worker。\n\n```text\nWeb → Application → PostgreSQL\n                 → Worker\n```\n\n## 验证重点\n1. 项目范围隔离\n2. 任务版本冲突\n3. 附件授权下载\n\n自动部署配置仅为元数据，未执行部署。',
  },
  {
    key: 'quote',
    title: '客户服务工作台 · 报价说明',
    scope: 'project',
    project: 'executing',
    actor: 'owner',
    visibility: 'private',
    body: '# 报价说明\n\n仅文档所有者可见。\n\n| 项目 | 数量 | 计划金额 |\n| --- | ---: | ---: |\n| 交付人天 | 60 | ￥186,000 |\n\n平均报价 ￥3,100/人天，仅用于测试预算展示；不代表收入确认。',
  },
  {
    key: 'acceptance',
    title: '运营数据看板 · 验收清单',
    scope: 'project',
    project: 'launched',
    actor: 'owner',
    visibility: 'space',
    body: '# 验收清单\n\n上线日期：2026-11-12；计划验收：2026-11-20。\n\n- [x] 指标口径核对\n- [x] 发布前检查关闭\n- [ ] 反馈收集与验收确认\n\n保留未完成事项，不将待验收标为完成。',
  },
  {
    key: 'maintenance',
    title: '文献检索助手 · 维护手册',
    scope: 'project',
    project: 'maintenance',
    actor: 'owner',
    visibility: 'space',
    body: '# 维护手册\n\n## 维护期限\n长期维护，结束日期为空。\n\n## 例行检查\n- 检索服务可用性\n- 文献去重质量\n- 资料权限\n\n遇到问题先记录证据和影响范围，再安排修复。',
  },
  {
    key: 'cancel-review',
    title: '旧站迁移试点 · 取消复盘',
    scope: 'project',
    project: 'cancelled',
    actor: 'lisi',
    visibility: 'private',
    body: '# 取消复盘\n\n李四的私密复盘，空间管理员也不应读取。\n\n业务计划已取消，相关任务保留取消原因；未发生部署、回滚或模型调用。',
  },
  {
    key: 'development',
    title: '研发规范',
    scope: 'team',
    team: 'delivery-team',
    actor: 'owner',
    visibility: 'space',
    body: '# 研发规范\n\n## 工作方式\n小步提交、清楚描述、依据证据确认完成。\n\n- 任务所属模块明确\n- 工时归实际填报人\n- 取消保留原因\n- 不在代码或文档中放置凭据',
  },
  {
    key: 'release',
    title: '发布与回滚清单',
    scope: 'team',
    team: 'delivery-team',
    actor: 'owner',
    visibility: 'space',
    body: '# 发布与回滚清单\n\n1. 确认审批内容与版本\n2. 记录部署版本\n3. 检查健康状态\n4. 保留回滚路径\n\n> 当前数据集没有执行部署，本清单是规范。',
  },
  {
    key: 'citation',
    title: '文献引用规范',
    scope: 'team',
    team: 'research-team',
    actor: 'owner',
    visibility: 'space',
    body: '# 文献引用规范\n\n引用需保留标题、作者、年份和原始来源。\n\n## 资料分类\n项目方案进入项目空间，共用规范进入团队空间，个人研究进入个人空间。',
  },
  {
    key: 'research-plan',
    title: '个人研究计划',
    scope: 'team',
    team: 'research-team',
    actor: 'zhaoliu',
    visibility: 'private',
    body: '# 个人研究计划\n\n赵六的私密研究计划，仅本人可见。\n\n本周暂未排期，不应据此认定没有工作或自动记为零工时。',
  },
  {
    key: 'owner-style',
    title: '我的工作偏好',
    scope: 'personal',
    actor: 'owner',
    visibility: 'private',
    body: '# 我的工作偏好\n\n先明确目标、范围与证据，再拆分可执行任务。\n\n偏好蓝色、紧凑、清楚的日常工作界面。个人资料仅本人可见。',
  },
  {
    key: 'personal-research',
    title: '交互研究笔记',
    scope: 'personal',
    actor: 'wangwu',
    visibility: 'private',
    body: '# 交互研究笔记\n\n王五的个人资料，其他人不能读取。\n\n## 观察\n表单标签常驻、操作反馈明确、复杂表格局部滚动。',
  },
];
export const attachments = [
  {
    key: 'task-requirements',
    task: 'desk-api',
    document: null,
    actor: 'owner' as ActorKey,
    name: '接口需求说明.md',
    content:
      '# 接口需求说明\n\n任务：实现服务流程接口。\n必须校验项目范围与版本。\n',
  },
  {
    key: 'task-regression',
    task: 'desk-web',
    document: null,
    actor: 'lisi' as ActorKey,
    name: '界面回归清单.txt',
    content: '键盘操作\n表单错误\n窄屏布局\n未保存保护\n',
  },
  {
    key: 'task-data',
    task: 'desk-urgent',
    document: null,
    actor: 'wangwu' as ActorKey,
    name: '脱敏问题样例.csv',
    content:
      'case_id,issue,expected\nCASE-001,重复提交,返回同一结果\nCASE-002,无项目权限,拒绝读取\n',
  },
  {
    key: 'document-budget',
    task: null,
    document: 'quote',
    actor: 'owner' as ActorKey,
    name: '预算明细.csv',
    content:
      'category,planned_days,planned_amount_cny\n客户服务工作台,60,186000\n',
  },
  {
    key: 'document-checklist',
    task: null,
    document: 'release',
    actor: 'owner' as ActorKey,
    name: '发布检查表.md',
    content:
      '# 发布检查表\n\n- [ ] 审批版本\n- [ ] 健康检查\n- [ ] 回滚记录\n\n本测试未执行发布。\n',
  },
  {
    key: 'document-private',
    task: null,
    document: 'personal-research',
    actor: 'wangwu' as ActorKey,
    name: '个人走查记录.txt',
    content: '王五个人走查记录。仅本人可见。\n',
  },
];
