'use client';
import { useState } from 'react';
import { Button, Input, InputNumber, Segmented, Select } from 'antd';
import type {
  WorkTask,
  WorkEffort,
  WorkSurfaceProps,
} from './work-management-types';
import { person } from './work-management-types';
import { WorkEmpty } from './work-shared';
import {
  actualForDay,
  dateDays,
  hasResourceActivity,
  isWorkday,
  plannedForDay,
  projectResourceGroups,
} from './work-analysis-model';

function iso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function week() {
  const at = new Date();
  at.setDate(at.getDate() - ((at.getDay() + 6) % 7));
  const end = new Date(at);
  end.setDate(end.getDate() + 6);
  return [iso(at), iso(end)] as const;
}
type Row = {
  id: string;
  name: string;
  description: string;
  tasks: WorkTask[];
  efforts: WorkEffort[];
  capacity: number | null;
  children: {
    id: string;
    name: string;
    tasks: WorkTask[];
    efforts: WorkEffort[];
  }[];
};
export function ResourceAnalysis({ data }: WorkSurfaceProps) {
  const [mode, setMode] = useState('person');
  const [[start, end], setRange] = useState<[string, string]>(() => [
    ...week(),
  ]);
  const [daily, setDaily] = useState(8);
  const [project, setProject] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const days = dateDays(start, end);
  const rangeTooLong = Date.parse(end) - Date.parse(start) > 30 * 86400000;
  const tasks = data.tasks.filter((t) => !project || t.projectId === project);
  const efforts = data.efforts.filter(
    (e) => !project || e.projectId === project,
  );
  const projectName = (id: string) =>
    data.projects.find((p) => p.id === id)?.name ?? '未分配项目';
  const taskChild = (task: WorkTask, entries = efforts) => ({
    id: task.id,
    name: `${projectName(task.projectId)} · ${task.name}`,
    tasks: [task],
    efforts: entries.filter((e) => e.taskId === task.id),
  });
  let rows: Row[] = [];
  if (mode === 'person')
    rows = data.participants.map((p) => {
      const assigned = tasks.filter((t) => t.assigneeId === p.id);
      const logged = efforts.filter((e) => e.actorId === p.id);
      const related = tasks.filter(
        (t) =>
          assigned.some((a) => a.id === t.id) ||
          logged.some((e) => e.taskId === t.id),
      );
      return {
        id: p.id,
        name: p.name,
        description: p.kind === 'agent' ? 'Agent · 单独统计' : '团队成员',
        tasks: assigned,
        efforts: logged,
        capacity: p.kind === 'human' ? daily : null,
        children: related.map((t) => ({
          ...taskChild(t, logged),
          tasks: t.assigneeId === p.id ? [t] : [],
        })),
      };
    });
  if (mode === 'project')
    rows = data.projects
      .filter((p) => !project || p.id === project)
      .map((p) => {
        const items = tasks.filter((t) => t.projectId === p.id);
        const entries = efforts.filter((e) => e.projectId === p.id);
        return {
          id: p.id,
          name: p.name,
          description: '模块 · 人员',
          tasks: items,
          efforts: entries,
          capacity: null,
          children: projectResourceGroups(items, entries).map((group) => {
            return {
              id: group.key,
              name: `${data.modules.find((m) => m.id === group.moduleId)?.name ?? '未分模块'} · ${person(data, group.participantId ?? null)}`,
              tasks: group.tasks,
              efforts: group.efforts,
            };
          }),
        };
      });
  if (mode === 'team')
    rows = data.teams.flatMap((team) =>
      team.memberIds.map((memberId) => {
        const assigned = tasks.filter((t) => t.assigneeId === memberId);
        const logged = efforts.filter((e) => e.actorId === memberId);
        const keys = [
          ...new Set(
            [
              ...assigned,
              ...tasks.filter((t) => logged.some((e) => e.taskId === t.id)),
            ].map((t) => `${t.projectId}:${t.moduleId ?? ''}`),
          ),
        ];
        return {
          id: `${team.id}:${memberId}`,
          name: person(data, memberId),
          description: team.name,
          tasks: assigned,
          efforts: logged,
          capacity:
            data.participants.find((p) => p.id === memberId)?.kind === 'human'
              ? daily
              : null,
          children: keys.map((key) => {
            const [pid, mid] = key.split(':');
            const related = tasks.filter(
              (t) => t.projectId === pid && (t.moduleId ?? '') === mid,
            );
            return {
              id: key,
              name: `${projectName(pid!)} · ${data.modules.find((m) => m.id === mid)?.name ?? '未分模块'}`,
              tasks: assigned.filter((t) => related.some((r) => r.id === t.id)),
              efforts: logged.filter((e) =>
                related.some((t) => t.id === e.taskId),
              ),
            };
          }),
        };
      }),
    );
  const unscheduled = tasks.filter(
    (t) =>
      t.status !== 'cancelled' &&
      (!t.plannedStart ||
        !t.plannedEnd ||
        t.plannedHours === null ||
        !t.assigneeId),
  );
  return (
    <>
      <div className="analysis-toolbar">
        <Segmented
          aria-label="资源分析维度"
          value={mode}
          onChange={(v) => setMode(String(v))}
          options={[
            { value: 'person', label: '人员' },
            { value: 'project', label: '项目' },
            { value: 'team', label: '团队' },
          ]}
        />
        <div className="date-range">
          <Input
            aria-label="分析开始日期"
            type="date"
            value={start}
            onChange={(e) => setRange([e.target.value, end])}
          />
          <span>至</span>
          <Input
            aria-label="分析结束日期"
            type="date"
            value={end}
            onChange={(e) => setRange([start, e.target.value])}
          />
          <Button onClick={() => setRange([...week()])}>本周</Button>
        </div>
        <Select
          aria-label="分析项目筛选"
          value={project}
          onChange={setProject}
          options={[
            { value: '', label: '全部项目' },
            ...data.projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <label className="capacity-control">
          每日参考容量
          <InputNumber
            aria-label="每日参考容量"
            min={1}
            max={24}
            value={daily}
            onChange={(v) => setDaily(v ?? 8)}
            suffix="h"
          />
        </label>
      </div>
      <div className="analysis-legend">
        <span>
          <i className="legend-plan" />
          计划工时
        </span>
        <span>
          <i className="legend-actual" />
          实际工时
        </span>
        <span>
          <i className="legend-over" />
          超出参考容量
        </span>
        <span className="muted">
          工作日容量 {daily} h / 人 · Agent 单独记录
        </span>
      </div>
      {rangeTooLong ? (
        <p className="notice notice-error" role="alert">
          日期范围超过31天，请缩短范围后查看。
        </p>
      ) : !days.length ? (
        <p className="notice notice-error" role="alert">
          请选择有效日期，结束日期不能早于开始日期。
        </p>
      ) : !rows.length ? (
        <WorkEmpty
          title={mode === 'team' ? '尚未建立团队' : '还没有可分析的资源'}
          description={
            mode === 'team'
              ? '在 Agents 的团队设置中维护成员后，即可按团队查看。'
              : '创建项目、安排任务并填报工时后，这里会形成资源时间轴。'
          }
        />
      ) : (
        <div className="resource-scroll">
          <table className="resource-table">
            <thead>
              <tr>
                <th>
                  {mode === 'project' ? '项目 / 模块 · 人员' : '人员 / 任务'}
                </th>
                {days.map((d) => (
                  <th key={d} className={!isWorkday(d) ? 'weekend' : ''}>
                    <strong>{d.slice(5).replace('-', '/')}</strong>
                    <span>
                      {
                        [
                          '周日',
                          '周一',
                          '周二',
                          '周三',
                          '周四',
                          '周五',
                          '周六',
                        ][new Date(d + 'T00:00:00Z').getUTCDay()]
                      }
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ResourceRows
                  key={row.id}
                  row={row}
                  days={days}
                  collapsed={collapsed.includes(row.id)}
                  toggle={() =>
                    setCollapsed((old) =>
                      old.includes(row.id)
                        ? old.filter((id) => id !== row.id)
                        : [...old, row.id],
                    )
                  }
                  cell={resourceCell}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="analysis-explanation">
        计划按任务执行人在起止日期内的工作日平均分摊，周末不分摊；实际按填报人和日期统计。仅统计当前授权与筛选范围，可能不包含其他项目。容量为你设定的参考值，未计入节假日和请假；多人协助不自动重复分摊工时。一次最多显示31天。
      </p>
      {unscheduled.length ? (
        <details className="unscheduled">
          <summary>{unscheduled.length} 项任务尚缺排期、工时或执行人</summary>
          <ul>
            {unscheduled.map((t) => (
              <li key={t.id}>
                {projectName(t.projectId)} · {t.name}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
export function resourceCell(
  tasks: WorkTask[],
  entries: WorkEffort[],
  date: string,
  capacity: number | null,
  detail = false,
) {
  const number = (n: number) => Number(n.toFixed(1));
  const plan = tasks.reduce((n, task) => n + plannedForDay(task, date), 0),
    actual = actualForDay(entries, date);
  return (
    <td
      key={date}
      className={`${!isWorkday(date) ? 'weekend ' : ''}${capacity !== null && plan > capacity ? 'overloaded' : ''}`}
    >
      {detail ? (
        <span className="cell-hours">
          {plan || actual
            ? `${plan ? number(plan) : '—'} / ${actual ? number(actual) : '—'} h`
            : '—'}
        </span>
      ) : plan || actual ? (
        <div className="resource-bars">
          <div aria-label={plan ? `计划${number(plan)}小时` : '暂无计划'}>
            {plan ? (
              <>
                <span
                  className="planned-bar"
                  style={{
                    width: `${Math.min(100, (plan / (capacity || Math.max(plan, actual, 8))) * 100)}%`,
                  }}
                />
                <b>{number(plan)}h</b>
              </>
            ) : (
              <span className="muted">—</span>
            )}
          </div>
          <div aria-label={actual ? `实际${number(actual)}小时` : '实际未填报'}>
            {actual ? (
              <>
                <span
                  className="actual-bar"
                  style={{
                    width: `${Math.min(100, (actual / (capacity || Math.max(plan, actual, 8))) * 100)}%`,
                  }}
                />
                <b>{number(actual)}h</b>
              </>
            ) : (
              <span className="muted">—</span>
            )}
          </div>
        </div>
      ) : (
        <span className="muted">—</span>
      )}
    </td>
  );
}
function ResourceRows({
  row,
  days,
  collapsed,
  toggle,
  cell,
}: {
  row: Row;
  days: string[];
  collapsed: boolean;
  toggle: () => void;
  cell: (
    tasks: WorkTask[],
    efforts: WorkEffort[],
    date: string,
    capacity: number | null,
    detail?: boolean,
  ) => React.ReactNode;
}) {
  const children = row.children.filter((child) =>
    hasResourceActivity(child.tasks, child.efforts, days),
  );
  const planned = days.reduce(
    (n, date) =>
      n + row.tasks.reduce((sum, task) => sum + plannedForDay(task, date), 0),
    0,
  );
  const reference =
    row.capacity === null ? null : days.filter(isWorkday).length * row.capacity;
  const incomplete = row.tasks.some(
    (task) =>
      task.status !== 'cancelled' &&
      (!task.plannedStart || !task.plannedEnd || task.plannedHours === null),
  );
  const capacityLabel =
    reference === null
      ? ''
      : incomplete
        ? '排期不完整'
        : days.some(
              (date) =>
                row.capacity !== null &&
                row.tasks.reduce(
                  (n, task) => n + plannedForDay(task, date),
                  0,
                ) > row.capacity,
            )
          ? '存在超负载日期'
          : `范围内参考余量 ${Math.max(0, Number((reference - planned).toFixed(1)))} h`;
  return (
    <>
      <tr className="resource-parent">
        <th scope="row">
          <button onClick={toggle} aria-expanded={!collapsed}>
            <svg
              className="disclosure-chevron"
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            >
              <path d={collapsed ? 'm4 2 4 4-4 4' : 'm2 4 4 4 4-4'} />
            </svg>
            <span className="initial-avatar">{row.name.slice(0, 1)}</span>
            <span>
              {row.name}
              <small>{row.description}</small>
              {capacityLabel ? <small>{capacityLabel}</small> : null}
            </span>
          </button>
        </th>
        {days.map((d) => cell(row.tasks, row.efforts, d, row.capacity))}
      </tr>
      {!collapsed
        ? children.map((child) => (
            <tr key={child.id} className="resource-child">
              <th scope="row">{child.name}</th>
              {days.map((d) => cell(child.tasks, child.efforts, d, null, true))}
            </tr>
          ))
        : null}
    </>
  );
}
