'use client';
import { useState } from 'react';
import { Button, Drawer, Input, InputNumber, Select, Tabs } from 'antd';
import type { WorkTask, WorkSurfaceProps } from './work-management-types';
import {
  day,
  person,
  statusLabels,
  canWriteProject,
  projectPeople,
} from './work-management-types';
import {
  WorkEditor,
  TextField,
  ChoiceField,
  NumberField,
  StatusLabel,
  WorkEmpty,
  AttachmentList,
  AttachmentUpload,
} from './work-shared';
import { TasksPanel } from './tasks-panel';
import { useProductResource, type ProjectItem } from './product-api';
import { errorMessage } from './collaboration-types';
import {
  guardUnsavedNavigation,
  useUnsavedChanges,
} from './use-unsaved-changes';

export function TasksManagement(props: WorkSurfaceProps) {
  const { data } = props;
  const [source, setSource] = useState('local');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState<WorkTask | 'new' | null>(null);
  const [efforts, setEfforts] = useState(false);
  const tasks = data.tasks.filter(
    (t) =>
      (!project || t.projectId === project) &&
      (!status || t.status === status) &&
      t.name.toLowerCase().includes(query.toLowerCase()),
  );
  const task = data.tasks.find((t) => t.id === selected);
  const writableProjects = data.projects.filter((p) =>
    canWriteProject(data, p.id),
  );
  return (
    <>
      <Tabs
        activeKey={source}
        onChange={setSource}
        items={[
          { key: 'local', label: '团队任务' },
          { key: 'external', label: '禅道任务' },
        ]}
      />
      {source === 'external' ? (
        <ExternalTasks {...props} />
      ) : (
        <>
          <div className="work-page-actions">
            <div className="list-toolbar">
              <Input
                placeholder="搜索任务名称"
                aria-label="搜索任务"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                allowClear
              />
              <Select
                aria-label="任务项目筛选"
                value={project}
                onChange={setProject}
                options={[
                  { value: '', label: '全部项目' },
                  ...data.projects.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
              <Select
                aria-label="任务状态筛选"
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: '全部状态' },
                  ...Object.entries(statusLabels).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
            </div>
            <div className="toolbar-actions">
              <Button
                onClick={() => setEfforts(true)}
                disabled={
                  !tasks.some((t) => canWriteProject(data, t.projectId))
                }
              >
                批量填报工时
              </Button>
              <Button
                type="primary"
                onClick={() => setEditing('new')}
                disabled={!writableProjects.length}
              >
                ＋ 新建任务
              </Button>
            </div>
          </div>
          {!tasks.length ? (
            <WorkEmpty
              title={
                data.tasks.length
                  ? '没有符合条件的任务'
                  : '把目标拆成可以行动的任务'
              }
              description={
                !data.projects.length
                  ? '先创建项目，再安排第一项任务。'
                  : '选择执行人、安排时间，让每一步都有明确归属。'
              }
              action={
                writableProjects.length && !data.tasks.length ? (
                  <Button type="primary" onClick={() => setEditing('new')}>
                    新建任务
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="table-scroll task-table-wrap">
              <table className="work-table">
                <thead>
                  <tr>
                    <th>任务名称</th>
                    <th>项目 / 模块</th>
                    <th>状态</th>
                    <th>执行人</th>
                    <th>计划日期</th>
                    <th>计划 / 实际工时</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <button
                          className="text-action task-name"
                          onClick={() => setSelected(t.id)}
                        >
                          {t.name}
                        </button>
                        {t.collaboratorIds.length ? (
                          <small className="cell-secondary">
                            协助：
                            {t.collaboratorIds
                              .map((id) => person(data, id))
                              .join('、')}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {data.projects.find((p) => p.id === t.projectId)?.name}
                        <small className="cell-secondary">
                          {data.modules.find((m) => m.id === t.moduleId)
                            ?.name || '未分模块'}
                        </small>
                      </td>
                      <td>
                        <StatusLabel
                          value={t.status}
                          label={statusLabels[t.status]!}
                        />
                      </td>
                      <td>{person(data, t.assigneeId)}</td>
                      <td>
                        {day(t.plannedStart)}
                        <small className="cell-secondary">
                          至 {day(t.plannedEnd)}
                        </small>
                      </td>
                      <td>
                        {t.plannedHours === null
                          ? '未估算'
                          : `${t.plannedHours} h`}
                        <span className="muted"> / </span>
                        {t.actualHours} h
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="work-table-caption">
            共 {tasks.length} 项任务 · 实际工时以填报记录汇总
          </div>
        </>
      )}
      {editing ? (
        <TaskEditor
          {...props}
          task={editing}
          defaultProject={project || writableProjects[0]?.id || ''}
          close={() => setEditing(null)}
        />
      ) : null}
      {task ? (
        <Drawer
          title={task.name}
          open
          size={800}
          onClose={() => guardUnsavedNavigation(() => setSelected(''))}
          extra={
            writableProjects.some((p) => p.id === task.projectId) ? (
              <Button
                onClick={() => guardUnsavedNavigation(() => setEditing(task))}
              >
                编辑任务
              </Button>
            ) : null
          }
        >
          <TaskDetail key={task.id} {...props} task={task} />
        </Drawer>
      ) : null}
      {efforts ? (
        <EffortEditor {...props} close={() => setEfforts(false)} />
      ) : null}
    </>
  );
}
function TaskEditor({
  task,
  defaultProject,
  data,
  onCommand,
  close,
}: WorkSurfaceProps & {
  task: WorkTask | 'new';
  defaultProject: string;
  close: () => void;
}) {
  const initial =
    task === 'new'
      ? {
          projectId: defaultProject,
          moduleId: null,
          name: '',
          description: '',
          assigneeId: null,
          collaboratorIds: [],
          plannedStart: null,
          plannedEnd: null,
          plannedHours: null,
          actualStart: null,
          actualEnd: null,
          status: 'not_started',
          cancellationReason: '',
        }
      : { ...task };
  return (
    <WorkEditor
      title={task === 'new' ? '新建任务' : '编辑任务'}
      initial={initial}
      command="save-task"
      onCommand={onCommand}
      close={close}
    >
      {(values, set) => (
        <>
          <TextField
            label="任务名称"
            name="name"
            values={values}
            set={set}
            required
          />
          <div className="form-grid">
            <ChoiceField
              label="所属项目"
              name="projectId"
              values={values}
              set={(key, value) => {
                set(key, value);
                set('moduleId', null);
                set('assigneeId', null);
                set('collaboratorIds', []);
              }}
              options={data.projects.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
            />
            <ChoiceField
              label="所属模块"
              name="moduleId"
              values={values}
              set={set}
              nullable
              options={data.modules
                .filter((m) => m.projectId === values.projectId)
                .map((m) => ({ value: m.id, label: m.name }))}
            />
            <ChoiceField
              label="执行人"
              name="assigneeId"
              values={values}
              set={set}
              nullable
              options={projectPeople(data, String(values.projectId)).map(
                (p) => ({
                  value: p.id,
                  label: `${p.name}${p.kind === 'agent' ? ' · Agent' : ''}`,
                }),
              )}
            />
            <ChoiceField
              label="协助人"
              name="collaboratorIds"
              values={values}
              set={set}
              multiple
              options={projectPeople(data, String(values.projectId)).map(
                (p) => ({
                  value: p.id,
                  label: `${p.name}${p.kind === 'agent' ? ' · Agent' : ''}`,
                }),
              )}
            />
            <TextField
              label="计划开始日期"
              name="plannedStart"
              type="date"
              values={values}
              set={set}
            />
            <TextField
              label="计划结束日期"
              name="plannedEnd"
              type="date"
              values={values}
              set={set}
            />
            <NumberField
              label="计划工时"
              name="plannedHours"
              suffix="h"
              values={values}
              set={set}
            />
            <ChoiceField
              label="任务状态"
              name="status"
              values={values}
              set={set}
              options={Object.entries(statusLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <TextField
              label="实际开始日期"
              name="actualStart"
              type="date"
              values={values}
              set={set}
            />
            <TextField
              label="实际完成日期"
              name="actualEnd"
              type="date"
              values={values}
              set={set}
            />
          </div>
          <p className="form-help">
            实际工时由工时填报累计，避免与填报记录不一致。
          </p>
          {values.status === 'cancelled' ? (
            <>
              <div className="field">
                <label>取消原因快捷选择</label>
                <Select
                  aria-label="取消原因快捷选择"
                  placeholder="选择常见原因，或在下方填写"
                  onChange={(v) => set('cancellationReason', v)}
                  options={[
                    '需求取消',
                    '计划调整',
                    '重复任务',
                    '项目取消',
                    '暂不具备执行条件',
                  ].map((value) => ({ value, label: value }))}
                />
              </div>
              <TextField
                label="取消原因"
                name="cancellationReason"
                values={values}
                set={set}
                required
                multiline
              />
            </>
          ) : null}
          <TextField
            label="任务描述"
            name="description"
            values={values}
            set={set}
            multiline
            help="保存后可在任务详情中上传附件、添加备注和登记工时。"
          />
        </>
      )}
    </WorkEditor>
  );
}
function TaskDetail({
  task,
  data,
  client,
  onCommand,
}: WorkSurfaceProps & { task: WorkTask }) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useUnsavedChanges(comment, () => setComment(''), busy);
  const events = data.taskEvents
    .filter((e) => e.taskId === task.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  async function add() {
    if (!comment.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onCommand('add-task-comment', { taskId: task.id, body: comment });
      setComment('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const fieldNames: Record<string, string> = {
    name: '任务名称',
    description: '描述',
    assigneeId: '执行人',
    collaboratorIds: '协助人',
    projectId: '项目',
    moduleId: '模块',
    status: '状态',
    plannedStart: '计划开始',
    plannedEnd: '计划结束',
    plannedHours: '计划工时',
    actualStart: '实际开始',
    actualEnd: '实际完成',
    cancellationReason: '取消原因',
    attachment: '附件',
  };
  const format = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return '未设置';
    if (key === 'status') return statusLabels[String(value)];
    if (key === 'assigneeId') return person(data, String(value));
    if (key === 'collaboratorIds' && Array.isArray(value))
      return value.map((id) => person(data, String(id))).join('、') || '无';
    if (key === 'moduleId')
      return data.modules.find((m) => m.id === value)?.name ?? '未分模块';
    if (key === 'projectId')
      return data.projects.find((p) => p.id === value)?.name ?? '不可见项目';
    if (key === 'attachment' && typeof value === 'object' && value) {
      const attachment = value as { name: string; size: number };
      return `${attachment.name}（${Math.max(1, Math.ceil(attachment.size / 1024))} KB）`;
    }
    return String(value);
  };
  return (
    <>
      {guard.confirmation}
      <div className="task-detail-top">
        <StatusLabel value={task.status} label={statusLabels[task.status]!} />
        <span className="muted">
          {data.projects.find((p) => p.id === task.projectId)?.name} ·{' '}
          {data.modules.find((m) => m.id === task.moduleId)?.name || '未分模块'}
        </span>
      </div>
      <p className="detail-description">
        {task.description || '尚未填写任务描述。'}
      </p>
      <dl className="task-facts">
        <div>
          <dt>执行人</dt>
          <dd>{person(data, task.assigneeId)}</dd>
        </div>
        <div>
          <dt>协助人</dt>
          <dd>
            {task.collaboratorIds.map((id) => person(data, id)).join('、') ||
              '无'}
          </dd>
        </div>
        <div>
          <dt>计划日期</dt>
          <dd>
            {day(task.plannedStart)} 至 {day(task.plannedEnd)}
          </dd>
        </div>
        <div>
          <dt>实际日期</dt>
          <dd>
            {day(task.actualStart)} 至 {day(task.actualEnd)}
          </dd>
        </div>
        <div>
          <dt>计划工时</dt>
          <dd>
            {task.plannedHours === null ? '未估算' : `${task.plannedHours} h`}
          </dd>
        </div>
        <div>
          <dt>实际工时</dt>
          <dd>{task.actualHours} h</dd>
        </div>
      </dl>
      {task.cancellationReason ? (
        <p className="notice">取消原因：{task.cancellationReason}</p>
      ) : null}
      <h3 className="form-section-title">附件</h3>
      <AttachmentList
        attachments={data.attachments.filter((a) => a.taskId === task.id)}
        workspaceId={client.workspace.id}
        {...(canWriteProject(data, task.projectId)
          ? { onRemove: client.refresh }
          : {})}
      />
      {canWriteProject(data, task.projectId) ? (
        <AttachmentUpload
          workspaceId={client.workspace.id}
          owner={{ taskId: task.id }}
          onComplete={client.refresh}
        />
      ) : null}
      <h3 className="form-section-title">任务时间轴</h3>
      {canWriteProject(data, task.projectId) ? (
        <div className="task-comment">
          <Input.TextArea
            aria-label="任务备注"
            placeholder="记录进展、问题或补充说明…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
          />
          {error ? (
            <p role="alert" className="form-error">
              {error}
            </p>
          ) : null}
          <Button
            type="primary"
            onClick={() => void add()}
            disabled={!comment.trim()}
            loading={busy}
          >
            添加备注
          </Button>
        </div>
      ) : null}
      <ol className="work-timeline">
        {events.map((e) => (
          <li key={e.id}>
            <div className="timeline-head">
              <strong>{person(data, e.actorId)}</strong>
              <span>
                {
                  {
                    created: '创建任务',
                    updated: '更新任务',
                    comment: '添加备注',
                    effort: '登记工时',
                    attachment_added: '添加附件',
                    attachment_removed: '移除附件',
                  }[e.kind]
                }
              </span>
              <time dateTime={e.createdAt}>
                {new Date(e.createdAt).toLocaleString('zh-CN', {
                  hour12: false,
                })}
              </time>
            </div>
            <p>{e.body}</p>
            {Object.keys(e.changes).length ? (
              <ul className="timeline-changes">
                {Object.entries(e.changes).map(([key, c]) => (
                  <li key={key}>
                    {fieldNames[key] ?? key}：{format(key, c.before)} →{' '}
                    {format(key, c.after)}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </>
  );
}
function EffortEditor({
  data,
  onCommand,
  close,
}: WorkSurfaceProps & { close: () => void }) {
  const today = new Date().toLocaleDateString('en-CA');
  const [entries, setEntries] = useState([
    { key: crypto.randomUUID(), taskId: '', date: today, hours: 1, note: '' },
  ]);
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guard = useUnsavedChanges(entries, close, busy);
  const update = (key: string, field: string, value: unknown) =>
    setEntries((old) =>
      old.map((e) => (e.key === key ? { ...e, [field]: value } : e)),
    );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCommand('log-efforts', {
        requestId,
        entries: entries.map(({ key: _key, ...entry }) => entry),
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {guard.confirmation}
      <Drawer
        open
        title="批量填报工时"
        size={1000}
        onClose={guard.requestClose}
      >
        <p className="muted">
          可同时填报多个项目的任务；每行记录实际投入，整批保存。
        </p>
        <form onSubmit={save}>
          <div className="effort-rows">
            {entries.map((entry, i) => (
              <div className="effort-row" key={entry.key}>
                <span className="effort-index">{i + 1}</span>
                <div className="field">
                  <label htmlFor={`effort-task-${i}`}>项目 / 任务</label>
                  <Select
                    id={`effort-task-${i}`}
                    value={entry.taskId || undefined}
                    showSearch
                    optionFilterProp="label"
                    onChange={(v) => update(entry.key, 'taskId', v)}
                    options={data.tasks
                      .filter((t) => canWriteProject(data, t.projectId))
                      .map((t) => ({
                        value: t.id,
                        label: `${data.projects.find((p) => p.id === t.projectId)?.name} / ${t.name}`,
                      }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`effort-date-${i}`}>工作日期</label>
                  <Input
                    id={`effort-date-${i}`}
                    type="date"
                    value={entry.date}
                    required
                    onChange={(e) => update(entry.key, 'date', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`effort-hours-${i}`}>工时 h</label>
                  <InputNumber
                    id={`effort-hours-${i}`}
                    min={0.1}
                    max={24}
                    step={0.5}
                    value={entry.hours}
                    onChange={(v) => update(entry.key, 'hours', v)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`effort-note-${i}`}>工作说明</label>
                  <Input
                    id={`effort-note-${i}`}
                    value={entry.note}
                    onChange={(e) => update(entry.key, 'note', e.target.value)}
                  />
                </div>
                <Button
                  type="text"
                  aria-label={`移除第${i + 1}行`}
                  disabled={entries.length === 1}
                  onClick={() =>
                    setEntries((old) => old.filter((e) => e.key !== entry.key))
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
          <Button
            onClick={() =>
              setEntries((old) => [
                ...old,
                {
                  key: crypto.randomUUID(),
                  taskId: '',
                  date: today,
                  hours: 1,
                  note: '',
                },
              ])
            }
          >
            ＋ 添加一行
          </Button>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="editor-actions">
            <span className="muted">
              合计 {entries.reduce((n, e) => n + (e.hours || 0), 0)} h
            </span>
            <Button onClick={guard.requestClose}>取消</Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={entries.some((e) => !e.taskId || !e.date || !e.hours)}
            >
              保存工时
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  );
}
function ExternalTasks({ client }: WorkSurfaceProps) {
  const projects = useProductResource<{ projects: ProjectItem[] }>(
    client,
    'projects',
  );
  const [selected, setSelected] = useState('');
  const id = projects.data?.projects.some((p) => p.id === selected)
    ? selected
    : projects.data?.projects[0]?.id || '';
  return (
    <>
      <div className="section-toolbar">
        <p className="muted">
          任务从禅道实时读取。外部写入先形成草案，审批后执行。
        </p>
        <Select<string>
          aria-label="禅道项目"
          value={id || null}
          onChange={(v) => setSelected(v)}
          options={
            projects.data?.projects.map((p) => ({
              value: p.id,
              label: p.name,
            })) ?? []
          }
        />
      </div>
      {projects.error ? (
        <p className="form-error" role="alert">
          {projects.error}
        </p>
      ) : id ? (
        <TasksPanel client={{ ...client, projectId: id }} />
      ) : (
        <WorkEmpty
          title="还没有已连接的禅道项目"
          description="在连接器中授权并绑定项目后，这里可查看和维护外部任务。"
        />
      )}
    </>
  );
}
