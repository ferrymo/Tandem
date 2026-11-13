'use client';
import { useEffect, useState } from 'react';
import { Button, Drawer, Input, Modal } from 'antd';
import type {
  ExternalExecution,
  ExternalTask,
  ProjectDraft,
  TaskDraftAction,
  TaskMessage,
} from '@tandem/core';
import { errorMessage } from './collaboration-types';
import {
  actProduct,
  Empty,
  ErrorText,
  ResourceState,
  Timestamp,
  useProductResource,
  type ProductClient,
} from './product-api';
import { DraftsPanel } from './drafts-panel';
import { useUnsavedChanges } from './use-unsaved-changes';

const statusNames: Record<string, string> = {
  wait: '待开始',
  doing: '进行中',
  pause: '已暂停',
  done: '已完成',
  cancel: '已取消',
  closed: '已关闭',
};
const validDate = (value: string | undefined) =>
  !!value && !value.startsWith('0000-') && Number.isFinite(Date.parse(value));
const dateLabel = (value: string) =>
  validDate(value) ? value.slice(0, 10) : '待定';
const hoursLabel = (value: number | null) =>
  value === null || !Number.isFinite(value) ? '未记录' : `${value} 小时`;
const localDay = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const localDateTime = (value?: string) => {
  const date = value && validDate(value) ? new Date(value) : new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
export function TasksPanel({ client }: { client: ProductClient }) {
  const executions = useProductResource<{ executions: ExternalExecution[] }>(
    client,
    'executions',
    { project: client.projectId },
  );
  const [execution, setExecution] = useState('');
  const [page, setPage] = useState(1);
  const [board, setBoard] = useState(false);
  const [task, setTask] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    task?: ExternalTask;
    draft?: ProjectDraft;
  } | null>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (executions.data)
      setExecution((current) =>
        executions.data!.executions.some((e) => e.id === current)
          ? current
          : (executions.data!.executions[0]?.id ?? ''),
      );
  }, [executions.data]);
  const tasks = useProductResource<{
    items: ExternalTask[];
    total: number;
    page: number;
  }>(client, 'tasks', {
    project: client.projectId,
    execution,
    page: String(page),
  });
  const filtered =
    tasks.data?.items.filter((t) =>
      `${t.name} ${t.assignedTo} ${t.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <section className="content-panel">
        <div className="section-heading">
          <div>
            <h2>项目任务</h2>
            <p className="muted">
              实时读取授权项目；线程是团队协作记录，任务变更通过草案写回。
            </p>
          </div>
          <Button
            type="primary"
            disabled={!execution}
            onClick={() => setEditor({})}
          >
            新建任务草案
          </Button>
        </div>
        <div className="product-toolbar">
          <label htmlFor="execution-scope">执行范围</label>
          <select
            id="execution-scope"
            value={execution}
            onChange={(e) => {
              setExecution(e.target.value);
              setPage(1);
            }}
          >
            <option value="" disabled>
              尚无可用执行
            </option>
            {executions.data?.executions.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <Input
            aria-label="搜索本页任务"
            placeholder="搜索本页任务或负责人"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="task-search"
          />
          <Button aria-pressed={board} onClick={() => setBoard((v) => !v)}>
            {board ? '切换列表' : '切换看板'}
          </Button>
        </div>
        <ResourceState
          error={executions.error || (execution ? tasks.error : '')}
          loading={executions.loading || (!tasks.data && tasks.loading)}
          retry={() => {
            executions.reload();
            tasks.reload();
          }}
        >
          {!execution ? (
            <Empty title="项目尚无可用执行">
              请先在连接系统中创建执行范围，再刷新。
            </Empty>
          ) : !filtered.length ? (
            <Empty title={search ? '本页没有匹配任务' : '当前范围没有任务'}>
              可以新建任务草案，批准后写入连接系统。
            </Empty>
          ) : board ? (
            <div className="task-board">
              {[...new Set(filtered.map((t) => t.status))].map((status) => (
                <section key={status}>
                  <h3>
                    {statusNames[status] ?? status}{' '}
                    <span className="muted">
                      {filtered.filter((t) => t.status === status).length}
                    </span>
                  </h3>
                  <ul>
                    {filtered
                      .filter((t) => t.status === status)
                      .map((t) => (
                        <li key={t.id}>
                          <button
                            className="task-card"
                            onClick={() => setTask(t.id)}
                          >
                            <strong>{t.name}</strong>
                            <span className="muted">
                              #{t.id} · {t.assignedTo || '未分配'}
                            </span>
                            <span className="muted">
                              截止日期：{dateLabel(t.deadline)}
                            </span>
                          </button>
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <div className="table-scroll">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>状态</th>
                    <th>负责人</th>
                    <th>截止日期</th>
                    <th>预计工时</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => setTask(t.id)}
                        >
                          #{t.id} {t.name}
                        </button>
                      </td>
                      <td>{statusNames[t.status] ?? t.status}</td>
                      <td>{t.assignedTo || '未分配'}</td>
                      <td>{dateLabel(t.deadline)}</td>
                      <td>{hoursLabel(t.estimate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tasks.data && execution ? (
            <div className="pagination">
              <span className="muted">
                共 {tasks.data.total} 项 · 第 {page} 页
                {search ? ' · 筛选仅作用于本页' : ''}
              </span>
              <Button
                disabled={page <= 1 || tasks.loading}
                onClick={() => setPage((v) => v - 1)}
              >
                上一页
              </Button>
              <Button
                disabled={
                  !tasks.data.items.length ||
                  page * 100 >= tasks.data.total ||
                  tasks.loading
                }
                onClick={() => setPage((v) => v + 1)}
              >
                下一页
              </Button>
            </div>
          ) : null}
        </ResourceState>
      </section>
      <DraftsPanel client={client} revise={(draft) => setEditor({ draft })} />
      {task ? (
        <TaskDetail
          key={task}
          client={client}
          taskId={task}
          close={() => setTask(null)}
          edit={(value) => setEditor({ task: value })}
        />
      ) : null}
      {editor ? (
        <TaskDraftEditor
          client={client}
          executionId={execution}
          executions={executions.data?.executions ?? []}
          {...editor}
          close={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}
function TaskDetail({
  client,
  taskId,
  close,
  edit,
}: {
  client: ProductClient;
  taskId: string;
  close: () => void;
  edit: (task: ExternalTask) => void;
}) {
  const detail = useProductResource<{
    task: ExternalTask;
    messages: TaskMessage[];
  }>(client, 'task', { project: client.projectId, task: taskId }, true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [actionEditor, setActionEditor] = useState<{
    mode: 'status' | 'effort';
    task: ExternalTask;
  } | null>(null);
  const [saved, setSaved] = useState('');
  const { requestClose, confirmation } = useUnsavedChanges(
    message,
    close,
    busy,
  );
  async function send() {
    setBusy(true);
    setError('');
    try {
      await actProduct(client, 'add-message', {
        projectId: client.projectId,
        taskId,
        message,
      });
      setMessage('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const t = detail.data?.task;
  return (
    <Drawer
      title={t ? `#${t.id} ${t.name}` : '任务详情'}
      open
      onClose={() => {
        if (!actionEditor) requestClose();
      }}
      size="large"
    >
      <ResourceState
        error={detail.error}
        loading={!detail.data && detail.loading}
        retry={detail.reload}
      >
        {t ? (
          <>
            <div className="row-heading">
              <span>
                {statusNames[t.status] ?? t.status} · {t.assignedTo || '未分配'}
              </span>
              <Button onClick={detail.reload} loading={detail.loading}>
                刷新任务
              </Button>
            </div>
            <dl className="compact-details">
              <div>
                <dt>截止日期</dt>
                <dd>{dateLabel(t.deadline)}</dd>
              </div>
              <div>
                <dt>预计工时</dt>
                <dd>{hoursLabel(t.estimate)}</dd>
              </div>
              <div>
                <dt>累计耗时</dt>
                <dd>{hoursLabel(t.consumed)}</dd>
              </div>
              <div>
                <dt>剩余工时</dt>
                <dd>{hoursLabel(t.left)}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>
                  <Timestamp
                    value={validDate(t.updatedAt) ? t.updatedAt : null}
                  />
                </dd>
              </div>
            </dl>
            <div className="row-actions">
              <Button onClick={() => edit(t)}>编辑任务草案</Button>
              <Button
                disabled={
                  !['wait', 'doing', 'pause', 'done', 'cancel'].includes(
                    t.status,
                  )
                }
                onClick={() => setActionEditor({ mode: 'status', task: t })}
              >
                状态流转草案
              </Button>
              <Button
                disabled={['closed', 'cancel'].includes(t.status)}
                onClick={() => setActionEditor({ mode: 'effort', task: t })}
              >
                登记工时草案
              </Button>
            </div>
            {saved ? (
              <p role="status" className="form-help">
                {saved}
              </p>
            ) : null}
            <h3 className="subsection-heading">任务说明</h3>
            <p className="plain-text">{t.description || '未填写说明'}</p>
            <h3 className="subsection-heading">协作线程</h3>
            {!detail.data?.messages.length ? (
              <p className="muted">还没有协作记录。</p>
            ) : (
              <ol className="thread-list">
                {detail.data.messages.map((m) => (
                  <li key={m.id}>
                    <strong>{m.displayName}</strong>
                    <span className="muted">
                      {' '}
                      ·{' '}
                      <Timestamp
                        value={validDate(m.createdAt) ? m.createdAt : null}
                      />
                    </span>
                    <p className="plain-text">{m.body}</p>
                  </li>
                ))}
              </ol>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="field">
                添加协作记录
                <Input.TextArea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                  maxLength={20000}
                  rows={3}
                  disabled={busy}
                />
              </label>
              <ErrorText value={error} />
              <div className="row-actions">
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={busy}
                  disabled={!message.trim()}
                >
                  发送记录
                </Button>
              </div>
            </form>
          </>
        ) : null}
      </ResourceState>
      {actionEditor ? (
        <TaskActionDraftEditor
          client={client}
          task={actionEditor.task}
          mode={actionEditor.mode}
          close={() => setActionEditor(null)}
          saved={() => {
            setSaved(
              '草案已保存，请在“草案与决策”中审阅；批准后才会写入任务。',
            );
            setActionEditor(null);
          }}
        />
      ) : null}
      {confirmation}
    </Drawer>
  );
}
const transitions: {
  value: 'start' | 'pause' | 'finish' | 'close';
  label: string;
  from: readonly string[];
}[] = [
  { value: 'start', label: '开始 · 进行中', from: ['wait'] },
  { value: 'pause', label: '暂停', from: ['doing'] },
  { value: 'finish', label: '完成', from: ['wait', 'doing', 'pause'] },
  { value: 'close', label: '关闭', from: ['done', 'cancel'] },
];
function TaskActionDraftEditor({
  client,
  task,
  mode,
  close,
  saved,
}: {
  client: ProductClient;
  task: ExternalTask;
  mode: 'status' | 'effort';
  close: () => void;
  saved: () => void;
}) {
  const available = transitions.filter((t) => t.from.includes(task.status));
  const [transition, setTransition] = useState(available[0]?.value ?? 'finish');
  const [consumed, setConsumed] = useState('');
  const [left, setLeft] = useState(task.left === null ? '' : String(task.left));
  const [comment, setComment] = useState('');
  const [date, setDate] = useState(localDay);
  const [started, setStarted] = useState(() =>
    validDate(task.realStarted) ? localDateTime(task.realStarted) : '',
  );
  const [finished, setFinished] = useState(localDateTime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const { requestClose, confirmation } = useUnsavedChanges(
    { transition, consumed, left, comment, date, started, finished },
    close,
    busy,
  );
  const needsHours =
    mode === 'effort' || transition === 'start' || transition === 'finish';
  const consumesIncrement = mode === 'effort' || transition === 'finish';
  function changeTransition(value: typeof transition) {
    setTransition(value);
    setConsumed(
      value === 'start' && task.consumed !== null ? String(task.consumed) : '',
    );
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      if (
        needsHours &&
        (!consumed.trim() ||
          !Number.isFinite(Number(consumed)) ||
          Number(consumed) < (mode === 'effort' ? 0.01 : 0))
      )
        throw new Error('请填写有效耗时；工时登记必须大于 0。');
      if (
        (mode === 'effort' || transition === 'start') &&
        (!left.trim() || !Number.isFinite(Number(left)) || Number(left) < 0)
      )
        throw new Error('请填写剩余工时，全部完成时可填写 0。');
      const action: TaskDraftAction =
        mode === 'effort'
          ? {
              kind: 'task.effort',
              taskId: task.id,
              expectedVersion: task.version,
              date,
              consumed: Number(consumed),
              left: Number(left),
              work: comment,
            }
          : {
              kind: 'task.status',
              taskId: task.id,
              expectedVersion: task.version,
              transition,
              consumed: needsHours ? Number(consumed) : 0,
              left: transition === 'start' ? Number(left) : 0,
              comment,
              ...(transition === 'finish'
                ? {
                    realStarted: started.replace('T', ' '),
                    finishedDate: finished.replace('T', ' '),
                  }
                : {}),
            };
      await actProduct(client, 'create-draft', {
        projectId: client.projectId,
        title: `${mode === 'effort' ? '登记工时' : (available.find((t) => t.value === transition)?.label ?? '状态流转')}：${task.name}`,
        action,
        requestId,
      });
      saved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        title={`${mode === 'effort' ? '登记工时草案' : '状态流转草案'} · #${task.id}`}
        open
        onCancel={requestClose}
        footer={null}
        width={640}
      >
        <p className="form-help">
          当前状态：{statusNames[task.status] ?? task.status}
          。草案绑定当前任务版本，外部任务变化后须刷新重建。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="form-grid">
            {mode === 'status' ? (
              <label className="field">
                目标状态
                <select
                  value={transition}
                  onChange={(e) =>
                    changeTransition(e.target.value as typeof transition)
                  }
                  disabled={busy}
                  required
                >
                  {available.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                登记日期
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  max={localDay()}
                  required
                  disabled={busy}
                />
              </label>
            )}
            {needsHours ? (
              <label className="field">
                {consumesIncrement
                  ? '本次新增耗时（小时）'
                  : '开始后的累计耗时（小时）'}
                <input
                  type="number"
                  min={
                    mode === 'effort'
                      ? 0.01
                      : transition === 'start'
                        ? (task.consumed ?? 0)
                        : 0
                  }
                  max={100000}
                  step="0.01"
                  value={consumed}
                  onChange={(e) => setConsumed(e.target.value)}
                  required
                  disabled={busy}
                />
              </label>
            ) : null}
            {mode === 'effort' || transition === 'start' ? (
              <label className="field">
                登记后剩余工时（小时）
                <input
                  type="number"
                  min={0}
                  max={100000}
                  step="0.01"
                  value={left}
                  onChange={(e) => setLeft(e.target.value)}
                  required
                  disabled={busy}
                />
              </label>
            ) : null}
            {mode === 'status' && transition === 'finish' ? (
              <>
                <label className="field">
                  实际开始时间
                  <input
                    type="datetime-local"
                    value={started}
                    onChange={(e) => setStarted(e.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  实际完成时间
                  <input
                    type="datetime-local"
                    value={finished}
                    min={started || undefined}
                    onChange={(e) => setFinished(e.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
              </>
            ) : null}
          </div>
          {mode === 'effort' ? (
            <p className="form-help">
              当前累计耗时：{hoursLabel(task.consumed)}。剩余工时填 0
              时，连接系统可能将任务同步为完成。
            </p>
          ) : transition === 'start' ? (
            <p className="form-help">
              当前累计耗时：{hoursLabel(task.consumed)}
              。开始后的累计耗时不能小于现有值。
            </p>
          ) : transition === 'finish' ? (
            <p className="form-help">
              本次耗时会追加到现有记录，完成后的剩余工时为 0。
            </p>
          ) : null}
          <label className="field">
            {mode === 'effort' ? '工作内容' : '流转说明'}
            <Input.TextArea
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              required={mode === 'effort'}
              maxLength={20000}
              disabled={busy}
            />
          </label>
          <ErrorText value={error} />
          <div className="dialog-actions">
            <Button disabled={busy} onClick={requestClose}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={busy}>
              保存待审阅草案
            </Button>
          </div>
        </form>
      </Modal>
      {confirmation}
    </>
  );
}
function TaskDraftEditor({
  client,
  executionId,
  executions,
  task,
  draft,
  close,
}: {
  client: ProductClient;
  executionId: string;
  executions: ExternalExecution[];
  task?: ExternalTask;
  draft?: ProjectDraft;
  close: () => void;
}) {
  const previous = draft?.action.kind === 'task.create' ? draft.action : null;
  const changes =
    draft?.action.kind === 'task.update' ? draft.action.changes : null;
  const editing = !!task || draft?.action.kind === 'task.update';
  const [name, setName] = useState(
    previous?.name ?? changes?.name ?? task?.name ?? '',
  );
  const [description, setDescription] = useState(
    previous?.description ?? changes?.description ?? task?.description ?? '',
  );
  const [assignee, setAssignee] = useState(
    previous?.assignedTo ?? changes?.assignedTo ?? task?.assignedTo ?? '',
  );
  const [execution, setExecution] = useState(
    previous?.executionId ?? executionId,
  );
  const [start, setStart] = useState(previous?.startDate ?? localDay());
  const initialDeadline =
    previous?.deadline ?? changes?.deadline ?? task?.deadline;
  const [deadline, setDeadline] = useState(
    validDate(initialDeadline)
      ? initialDeadline!.slice(0, 10)
      : editing
        ? ''
        : localDay(),
  );
  const [estimate, setEstimate] = useState(
    String(
      previous?.estimate ??
        changes?.estimate ??
        task?.estimate ??
        (editing ? '' : 1),
    ),
  );
  const [priority, setPriority] = useState(
    previous?.priority ?? changes?.priority ?? task?.priority ?? 3,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const { requestClose, confirmation } = useUnsavedChanges(
    {
      name,
      description,
      assignee,
      execution,
      start,
      deadline,
      estimate,
      priority,
    },
    close,
    busy,
  );
  async function save() {
    setBusy(true);
    setError('');
    const action: TaskDraftAction = editing
      ? {
          kind: 'task.update',
          taskId:
            task?.id ??
            (draft!.action as Extract<TaskDraftAction, { kind: 'task.update' }>)
              .taskId,
          expectedVersion:
            task?.version ??
            (draft!.action as Extract<TaskDraftAction, { kind: 'task.update' }>)
              .expectedVersion,
          changes: {
            name,
            description,
            assignedTo: assignee,
            deadline,
            estimate: Number(estimate),
            priority,
          },
        }
      : {
          kind: 'task.create',
          executionId: execution,
          name,
          description,
          assignedTo: assignee,
          startDate: start,
          deadline,
          estimate: Number(estimate),
          priority,
        };
    try {
      await actProduct(client, draft ? 'revise-draft' : 'create-draft', {
        projectId: client.projectId,
        title: `${editing ? '修改' : '新建'}任务：${name}`,
        action,
        requestId,
        ...(draft ? { draftId: draft.id, version: draft.version } : {}),
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
      <Modal
        title={
          draft
            ? `修改草案 · 版本 ${draft.version}`
            : editing
              ? '编辑任务草案'
              : '新建任务草案'
        }
        open
        onCancel={requestClose}
        footer={null}
        width={680}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            任务名称
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              disabled={busy}
            />
          </label>
          <label className="field">
            任务说明
            <Input.TextArea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={20000}
              rows={4}
              disabled={busy}
            />
          </label>
          <div className="form-grid">
            {!editing ? (
              <label className="field">
                执行范围
                <select
                  value={execution}
                  onChange={(e) => setExecution(e.target.value)}
                  disabled={busy}
                  required
                >
                  {executions.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field">
              负责人账号
              <Input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                required
                maxLength={120}
                disabled={busy}
              />
            </label>
            {!editing ? (
              <label className="field">
                计划开始日期
                <input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  required
                  disabled={busy}
                />
              </label>
            ) : null}
            <label className="field">
              截止日期
              <input
                type="date"
                value={deadline.slice(0, 10)}
                onChange={(e) => setDeadline(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label className="field">
              预计工时（小时）
              <input
                type="number"
                min={0}
                max={100000}
                step="0.5"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label className="field">
              优先级
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                disabled={busy}
              >
                {[0, 1, 2, 3, 4].map((p) => (
                  <option key={p} value={p}>
                    {p === 0 ? '未设优先级' : `${p} 级`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="form-help">
            保存为待审阅草案。批准后才会写入，修改后的版本须重新批准。
          </p>
          <ErrorText value={error} />
          <div className="dialog-actions">
            <Button disabled={busy} onClick={requestClose}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={busy}>
              保存草案
            </Button>
          </div>
        </form>
      </Modal>
      {confirmation}
    </>
  );
}
