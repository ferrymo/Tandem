'use client';
import { useMemo, useState } from 'react';
import { Button, Drawer, Input, Select, Tabs } from 'antd';
import type {
  WorkProject,
  WorkGroup,
  WorkSurfaceProps,
} from './work-management-types';
import {
  stageLabels,
  commonRoles,
  day,
  person,
  money,
  can,
  canWriteProject,
} from './work-management-types';
import {
  WorkEditor,
  TextField,
  NumberField,
  ChoiceField,
  StatusLabel,
  WorkEmpty,
} from './work-shared';
import { errorMessage } from './collaboration-types';
import { guardUnsavedNavigation } from './use-unsaved-changes';
import { remainingTasksAt } from './work-analysis-model';

export function ProjectsManagement(props: WorkSurfaceProps) {
  const { data, onCommand } = props;
  const [group, setGroup] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('');
  const [editing, setEditing] = useState<WorkProject | 'new' | null>(null);
  const [groupEditing, setGroupEditing] = useState<WorkGroup | 'new' | null>(
    null,
  );
  const [selected, setSelected] = useState('');
  const descendants = useMemo(() => {
    const ids = new Set([group]);
    let changed = true;
    while (changed) {
      changed = false;
      data.groups.forEach((g) => {
        if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
          ids.add(g.id);
          changed = true;
        }
      });
    }
    return ids;
  }, [group, data.groups]);
  const projects = data.projects.filter(
    (p) =>
      (!group || descendants.has(p.groupId ?? '')) &&
      (!stage || stage === p.stage) &&
      p.name.toLowerCase().includes(query.toLowerCase()),
  );
  const project = data.projects.find((p) => p.id === selected);
  function tree(parentId: string | null, depth = 0): React.ReactNode {
    return data.groups
      .filter((g) => g.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((g) => {
        const hasChildren = data.groups.some(
          (child) => child.parentId === g.id,
        );
        const collapsed = collapsedGroups.includes(g.id);
        return (
          <div key={g.id}>
            <div
              className={`group-row ${group === g.id ? 'selected' : ''}`}
              style={{ paddingLeft: 12 + depth * 16 }}
            >
              {hasChildren ? (
                <button
                  className="group-toggle"
                  aria-label={`${collapsed ? '展开' : '收起'}分组 ${g.name}`}
                  aria-expanded={!collapsed}
                  onClick={() =>
                    setCollapsedGroups((old) =>
                      collapsed
                        ? old.filter((id) => id !== g.id)
                        : [...old, g.id],
                    )
                  }
                >
                  <svg
                    aria-hidden="true"
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  >
                    <path d={collapsed ? 'm4 2 4 4-4 4' : 'm2 4 4 4 4-4'} />
                  </svg>
                </button>
              ) : null}
              <button className="group-select" onClick={() => setGroup(g.id)}>
                <Folder />
                {g.name}
              </button>
              {data.canAdmin ? (
                <button
                  aria-label={`编辑分组 ${g.name}`}
                  className="group-edit"
                  onClick={() => setGroupEditing(g)}
                >
                  ···
                </button>
              ) : null}
            </div>
            {!collapsed && depth < 12 ? tree(g.id, depth + 1) : null}
          </div>
        );
      });
  }
  return (
    <>
      <div className="work-page-actions">
        <span>
          {data.projects.length} 个项目
          <span className="muted"> · 从这里开始组织团队的工作</span>
        </span>
        {can(data, 'project.create') ? (
          <Button type="primary" onClick={() => setEditing('new')}>
            ＋ 新建项目
          </Button>
        ) : null}
      </div>
      <div className="project-layout">
        <aside className="group-pane">
          <div className="pane-heading">
            <h2>项目分组</h2>
            {data.canAdmin ? (
              <Button
                type="text"
                size="small"
                aria-label="新建分组"
                onClick={() => setGroupEditing('new')}
              >
                ＋
              </Button>
            ) : null}
          </div>
          <button
            className={`group-all ${!group ? 'selected' : ''}`}
            onClick={() => setGroup('')}
          >
            <Folder />
            全部项目<span>{data.projects.length}</span>
          </button>
          {tree(null)}
          {!data.groups.length ? (
            <p className="group-hint">
              按客户、业务或团队建立分组，让项目更好找。
            </p>
          ) : null}
        </aside>
        <section className="project-list">
          <div className="list-toolbar">
            <Input
              aria-label="搜索项目"
              placeholder="搜索项目名称"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              allowClear
            />
            <Select
              aria-label="项目阶段筛选"
              value={stage}
              onChange={setStage}
              options={[
                { value: '', label: '全部阶段' },
                ...Object.entries(stageLabels).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
            />
          </div>
          {!projects.length ? (
            <WorkEmpty
              title={
                data.projects.length
                  ? '没有符合条件的项目'
                  : '创建你的第一个项目'
              }
              description={
                data.projects.length
                  ? '换个关键词或筛选条件试试。'
                  : '先建立项目，再安排成员、模块、文档与任务。'
              }
              action={
                can(data, 'project.create') && !data.projects.length ? (
                  <Button type="primary" onClick={() => setEditing('new')}>
                    新建项目
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="table-scroll">
              <table className="work-table projects-table">
                <thead>
                  <tr>
                    <th>项目名称</th>
                    <th>阶段</th>
                    <th>负责人</th>
                    <th>计划人天</th>
                    <th>计划完工额</th>
                    <th>上线日期</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <button
                          className="project-name text-action"
                          onClick={() => setSelected(p.id)}
                        >
                          <span className="project-symbol">
                            <Folder />
                          </span>
                          <span>
                            {p.name}
                            <small>{p.description || '尚未填写项目简介'}</small>
                          </span>
                        </button>
                      </td>
                      <td>
                        <StatusLabel
                          value={p.stage}
                          label={stageLabels[p.stage]!}
                        />
                      </td>
                      <td>{person(data, p.ownerId)}</td>
                      <td>{p.plannedDays ?? '未设置'}</td>
                      <td>{money(p.plannedAmount)}</td>
                      <td>{day(p.launchOn)}</td>
                      <td>
                        <Button type="text" onClick={() => setSelected(p.id)}>
                          查看
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="work-table-caption">
            共 {projects.length} 个项目
            {group
              ? ` · ${data.groups.find((g) => g.id === group)?.name ?? ''}`
              : ''}
          </div>
        </section>
      </div>
      {editing ? (
        <ProjectEditor
          project={editing}
          initialGroupId={group || null}
          {...props}
          close={() => setEditing(null)}
        />
      ) : null}
      {groupEditing ? (
        <WorkEditor
          title={groupEditing === 'new' ? '新建项目分组' : '编辑项目分组'}
          initial={
            groupEditing === 'new'
              ? { name: '', parentId: group || null, sortOrder: 0 }
              : { ...groupEditing }
          }
          command="save-project-group"
          onCommand={onCommand}
          close={() => setGroupEditing(null)}
          {...(groupEditing !== 'new'
            ? {
                removeTitle: `删除分组「${groupEditing.name}」？`,
                remove: async () => {
                  await onCommand('remove-project-group', {
                    id: groupEditing.id,
                    version: groupEditing.version,
                  });
                  if (group === groupEditing.id) setGroup('');
                },
              }
            : {})}
        >
          {(values, set) => (
            <>
              <TextField
                label="分组名称"
                name="name"
                values={values}
                set={set}
                required
              />
              <ChoiceField
                label="上级分组"
                name="parentId"
                values={values}
                set={set}
                nullable
                options={data.groups
                  .filter(
                    (g) => groupEditing === 'new' || g.id !== groupEditing.id,
                  )
                  .map((g) => ({ value: g.id, label: g.name }))}
              />
              <NumberField
                label="排序"
                name="sortOrder"
                values={values}
                set={set}
              />
            </>
          )}
        </WorkEditor>
      ) : null}
      {project ? (
        <Drawer
          title={project.name}
          open
          size={960}
          onClose={() => guardUnsavedNavigation(() => setSelected(''))}
          extra={
            canWriteProject(data, project.id) ? (
              <Button onClick={() => setEditing(project)}>编辑项目</Button>
            ) : null
          }
        >
          <ProjectDetail {...props} project={project} />
        </Drawer>
      ) : null}
    </>
  );
}
function Folder() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M2 6h6l2 2h8v9H2zM2 6V3h6l2 3" />
    </svg>
  );
}
function ProjectEditor({
  project,
  initialGroupId,
  data,
  onCommand,
  close,
}: WorkSurfaceProps & {
  project: WorkProject | 'new';
  initialGroupId: string | null;
  close: () => void;
}) {
  const initial =
    project === 'new'
      ? {
          name: '',
          description: '',
          groupId: initialGroupId,
          stage: 'initiated',
          ownerId: data.actorId,
          initiatedOn: null,
          launchOn: null,
          acceptanceOn: null,
          maintenanceUntil: null,
          plannedDays: null,
          plannedAmount: null,
          repositoryUrl: '',
          deploymentTarget: '',
          deploymentBranch: 'main',
          deploymentCommand: '',
        }
      : { ...project };
  const participantOptions = data.participants
    .filter((p) => p.kind === 'human')
    .map((p) => ({ value: p.id, label: p.name }));
  return (
    <WorkEditor
      title={project === 'new' ? '新建项目' : '编辑项目'}
      initial={initial}
      command="save-project"
      onCommand={onCommand}
      close={close}
    >
      {(values, set) => (
        <>
          <div className="form-grid">
            <TextField
              label="项目名称"
              name="name"
              values={values}
              set={set}
              required
            />
            <ChoiceField
              label="项目分组"
              name="groupId"
              values={values}
              set={set}
              nullable
              options={data.groups.map((g) => ({ value: g.id, label: g.name }))}
            />
            <ChoiceField
              label="项目阶段"
              name="stage"
              values={values}
              set={set}
              options={Object.entries(stageLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <ChoiceField
              label="项目负责人"
              name="ownerId"
              values={values}
              set={set}
              options={participantOptions}
            />
            <TextField
              label="立项日期"
              name="initiatedOn"
              type="date"
              values={values}
              set={set}
            />
            <TextField
              label="上线日期"
              name="launchOn"
              type="date"
              values={values}
              set={set}
            />
            <TextField
              label="验收日期"
              name="acceptanceOn"
              type="date"
              values={values}
              set={set}
            />
            <TextField
              label="维护结束日期"
              name="maintenanceUntil"
              type="date"
              values={values}
              set={set}
              help="留空表示长期维护"
            />
            <NumberField
              label="计划人天"
              name="plannedDays"
              values={values}
              set={set}
              suffix="人天"
            />
            <NumberField
              label="计划完工额"
              name="plannedAmount"
              values={values}
              set={set}
              suffix="元"
            />
          </div>
          <TextField
            label="项目简介"
            name="description"
            values={values}
            set={set}
            multiline
          />
          <h3 className="form-section-title">代码与部署</h3>
          <TextField
            label="代码仓库地址"
            name="repositoryUrl"
            values={values}
            set={set}
          />
          <div className="form-grid">
            <TextField
              label="部署目标"
              name="deploymentTarget"
              values={values}
              set={set}
            />
            <TextField
              label="部署分支"
              name="deploymentBranch"
              values={values}
              set={set}
            />
          </div>
          <TextField
            label="部署命令"
            name="deploymentCommand"
            values={values}
            set={set}
            multiline
            help="保存部署方案；执行部署仍需草案审批，不会自动在宿主运行。"
          />
        </>
      )}
    </WorkEditor>
  );
}
function ProjectDetail({
  project,
  ...props
}: WorkSurfaceProps & { project: WorkProject }) {
  const { data, onCommand } = props;
  const tasks = data.tasks.filter((t) => t.projectId === project.id);
  const efforts = data.efforts.filter((e) => e.projectId === project.id);
  const [module, setModule] = useState<{
    id?: string;
    version?: number;
    name: string;
    description: string;
  } | null>(null);
  return (
    <Tabs
      items={[
        {
          key: 'overview',
          label: '项目概要',
          children: (
            <>
              <p className="detail-description">
                {project.description || '为项目添加简介，让团队了解目标。'}
              </p>
              <div className="project-facts">
                <dl>
                  <dt>项目阶段</dt>
                  <dd>{stageLabels[project.stage]}</dd>
                  <dt>负责人</dt>
                  <dd>{person(data, project.ownerId)}</dd>
                  <dt>计划人天</dt>
                  <dd>{project.plannedDays ?? '未设置'}</dd>
                  <dt>计划完工额</dt>
                  <dd>{money(project.plannedAmount)}</dd>
                  <dt>立项日期</dt>
                  <dd>{day(project.initiatedOn)}</dd>
                  <dt>上线日期</dt>
                  <dd>{day(project.launchOn)}</dd>
                  <dt>验收日期</dt>
                  <dd>{day(project.acceptanceOn)}</dd>
                  <dt>维护结束</dt>
                  <dd>
                    {project.maintenanceUntil
                      ? day(project.maintenanceUntil)
                      : '长期维护'}
                  </dd>
                </dl>
              </div>
              <div className="project-inline-stats">
                <span>
                  任务 <strong>{tasks.length}</strong>
                </span>
                <span>
                  已完成{' '}
                  <strong>
                    {
                      tasks.filter((t) =>
                        ['completed', 'closed'].includes(t.status),
                      ).length
                    }
                  </strong>
                </span>
                <span>
                  实际投入{' '}
                  <strong>{efforts.reduce((n, e) => n + e.hours, 0)} h</strong>
                </span>
              </div>
              <h3 className="form-section-title">任务燃尽</h3>
              <Burndown tasks={tasks} events={data.taskEvents} />
              <p className="form-help">
                按任务创建与状态变更记录重建剩余任务数；已取消任务不计入剩余。
              </p>
            </>
          ),
        },
        {
          key: 'members',
          label: '团队成员',
          children: <MemberMatrix {...props} project={project} />,
        },
        {
          key: 'modules',
          label: '项目模块',
          children: (
            <>
              <div className="section-toolbar">
                <p className="muted">模块用于归类任务与资源投入。</p>
                {canWriteProject(data, project.id) ? (
                  <Button
                    onClick={() => setModule({ name: '', description: '' })}
                  >
                    新建模块
                  </Button>
                ) : null}
              </div>
              <table className="work-table">
                <thead>
                  <tr>
                    <th>模块</th>
                    <th>说明</th>
                    <th>任务</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.modules
                    .filter((m) => m.projectId === project.id)
                    .map((m) => (
                      <tr key={m.id}>
                        <td>{m.name}</td>
                        <td>{m.description || '—'}</td>
                        <td>
                          {tasks.filter((t) => t.moduleId === m.id).length}
                        </td>
                        <td>
                          <Button
                            type="text"
                            disabled={!canWriteProject(data, project.id)}
                            onClick={() => setModule(m)}
                          >
                            编辑
                          </Button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {module ? (
                <WorkEditor
                  title="维护项目模块"
                  initial={{ ...module, projectId: project.id }}
                  command="save-module"
                  onCommand={onCommand}
                  close={() => setModule(null)}
                  {...(module.id
                    ? {
                        removeTitle: `删除模块「${module.name}」？`,
                        remove: () =>
                          onCommand('remove-module', {
                            id: module.id,
                            version: module.version,
                            projectId: project.id,
                          }),
                      }
                    : {})}
                >
                  {(values, set) => (
                    <>
                      <TextField
                        label="模块名称"
                        name="name"
                        values={values}
                        set={set}
                        required
                      />
                      <TextField
                        label="模块说明"
                        name="description"
                        values={values}
                        set={set}
                        multiline
                      />
                    </>
                  )}
                </WorkEditor>
              ) : null}
            </>
          ),
        },
        {
          key: 'repository',
          label: '仓库与部署',
          children: (
            <dl className="settings-definition">
              <dt>代码仓库</dt>
              <dd>{project.repositoryUrl || '未配置'}</dd>
              <dt>部署目标</dt>
              <dd>{project.deploymentTarget || '未配置'}</dd>
              <dt>部署分支</dt>
              <dd>{project.deploymentBranch || '未配置'}</dd>
              <dt>部署命令</dt>
              <dd>
                <pre>{project.deploymentCommand || '未配置'}</pre>
              </dd>
              <dt>执行方式</dt>
              <dd>
                当前保存部署方案，尚未接入自动部署流水线。已有 T
                组交付中的部署仍通过草案审批与隔离执行。
              </dd>
            </dl>
          ),
        },
      ]}
    />
  );
}
function MemberMatrix({
  project,
  data,
  onCommand,
}: WorkSurfaceProps & { project: WorkProject }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');
  const members = data.projectMembers.filter((m) => m.projectId === project.id);
  const roles = [
    ...new Set([
      ...commonRoles,
      ...members.map((m) => m.role),
      ...(custom ? [custom] : []),
    ]),
  ];
  async function change(role: string, ids: string[]) {
    setBusy(true);
    setError('');
    try {
      for (const m of members.filter(
        (m) => m.role === role && !ids.includes(m.participantId),
      ))
        await onCommand('remove-project-member', {
          id: m.id,
          version: m.version,
        });
      for (const id of ids.filter(
        (id) => !members.some((m) => m.role === role && m.participantId === id),
      ))
        await onCommand('save-project-member', {
          projectId: project.id,
          participantId: id,
          role,
          canWrite: true,
        });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="muted">
        每个角色可选择多人，也可分配 Agent。新增成员默认可维护项目任务。
      </p>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <table className="work-table member-matrix">
        <thead>
          <tr>
            <th>职责角色</th>
            <th>人员 / Agent</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role}>
              <td>{role}</td>
              <td>
                <Select
                  mode="multiple"
                  aria-label={`${role}成员`}
                  value={members
                    .filter((m) => m.role === role)
                    .map((m) => m.participantId)}
                  disabled={!canWriteProject(data, project.id) || busy}
                  onChange={(ids) => void change(role, ids)}
                  options={data.participants.map((p) => ({
                    value: p.id,
                    label: `${p.name}${p.kind === 'agent' ? ' · Agent' : ''}`,
                  }))}
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择人员或 Agent"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canWriteProject(data, project.id) ? (
        <div className="inline-form">
          <Input
            aria-label="自定义职责角色"
            placeholder="输入其他职责，如：测试"
            maxLength={80}
            onPressEnter={(e) => {
              e.preventDefault();
              setCustom(e.currentTarget.value.trim());
              e.currentTarget.value = '';
            }}
          />
          <span className="form-help">按 Enter 添加自定义角色</span>
        </div>
      ) : null}
    </>
  );
}
function Burndown({
  tasks,
  events,
}: {
  tasks: WorkSurfaceProps['data']['tasks'];
  events: WorkSurfaceProps['data']['taskEvents'];
}) {
  const scheduled = tasks.filter((t) => t.plannedStart || t.createdAt);
  if (!scheduled.length)
    return (
      <WorkEmpty
        title="还没有任务记录"
        description="创建任务并记录完成时间后，这里会展示任务燃尽趋势。"
      />
    );
  const start = Math.min(...scheduled.map((t) => Date.parse(t.createdAt)));
  const end = Math.max(
    Date.now(),
    ...scheduled.map((t) => Date.parse(t.actualEnd ?? t.updatedAt)),
  );
  const count = Math.min(
    30,
    Math.max(2, Math.ceil((end - start) / 86400000) + 1),
  );
  const values = Array.from({ length: count }, (_, i) => {
    const at = start + ((end - start) * i) / (count - 1);
    return remainingTasksAt(scheduled, events, at);
  });
  const max = Math.max(1, ...values);
  const pts = values
    .map((v, i) => `${40 + (i * 640) / (count - 1)},${150 - (v / max) * 120}`)
    .join(' ');
  return (
    <div className="burndown-chart">
      <svg
        role="img"
        aria-label={`任务燃尽图，当前剩余${values.at(-1)}个任务`}
        viewBox="0 0 720 184"
      >
        <path d="M40 20v130h640" fill="none" stroke="var(--color-divider)" />
        <path
          d="M40 30 680 150"
          fill="none"
          stroke="var(--color-neutral-muted)"
          strokeDasharray="5 5"
        />
        <polyline
          points={pts}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="2.5"
        />
        <text x="8" y="34">
          {max}
        </text>
        <text x="10" y="154">
          0
        </text>
        <text x="40" y="177">
          {new Date(start).toLocaleDateString('zh-CN')}
        </text>
        <text x="580" y="177">
          {new Date(end).toLocaleDateString('zh-CN')}
        </text>
      </svg>
      <span className="form-help">蓝线：按记录重建 · 虚线：参考趋势</span>
    </div>
  );
}
