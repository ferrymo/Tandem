import { describe, it, expect } from 'vitest';
import type {
  WorkTask,
  WorkEffort,
  WorkTaskEvent,
} from '../../packages/core/src/index';
import {
  dateDays,
  plannedForDay,
  actualForDay,
  remainingTasksAt,
  projectResourceGroups,
} from '../../apps/web/src/components/work-analysis-model';
const task = {
  plannedStart: '2026-11-09',
  plannedEnd: '2026-11-15',
  plannedHours: 40,
  status: 'in_progress',
} as WorkTask;
describe('resource planning distribution', () => {
  it('attributes plans to assignees and actual work to the submitting collaborator', () => {
    const tasks = [
      { ...task, id: 'task', moduleId: 'module', assigneeId: '张三' },
    ] as WorkTask[];
    const groups = projectResourceGroups(tasks, [
      { taskId: 'task', actorId: '李四', hours: 4, date: '2026-11-09' },
    ] as WorkEffort[]);
    expect(groups.find((g) => g.participantId === '张三')?.efforts).toEqual([]);
    expect(groups.find((g) => g.participantId === '李四')?.tasks).toEqual([]);
    expect(
      groups.find((g) => g.participantId === '李四')?.efforts[0]?.hours,
    ).toBe(4);
  });
  it('removes cancelled work at its recorded lifecycle transition', () => {
    const tasks = [
      {
        ...task,
        id: 'task',
        createdAt: '2026-11-09T00:00:00Z',
        status: 'cancelled',
      },
    ] as WorkTask[];
    const events = [
      {
        id: 'event',
        actorId: 'actor',
        kind: 'updated',
        body: '任务已取消',
        taskId: 'task',
        createdAt: '2026-11-10T00:00:00Z',
        changes: { status: { before: 'in_progress', after: 'cancelled' } },
      },
    ] as WorkTaskEvent[];
    expect(
      remainingTasksAt(tasks, events, Date.parse('2026-11-09T12:00:00Z')),
    ).toBe(1);
    expect(
      remainingTasksAt(tasks, events, Date.parse('2026-11-10T12:00:00Z')),
    ).toBe(0);
  });
  it('distributes across workdays and preserves total planned hours', () => {
    const days = dateDays('2026-11-09', '2026-11-15');
    expect(days.reduce((n, d) => n + plannedForDay(task, d), 0)).toBe(40);
    expect(plannedForDay(task, '2026-11-14')).toBe(0);
    expect(plannedForDay(task, '2026-11-09')).toBe(8);
  });
  it('preserves complete and reopen history when the latest completion date changes', () => {
    const tasks = [
      {
        ...task,
        id: 'task',
        status: 'completed',
        createdAt: '2026-11-09T00:00:00Z',
        actualEnd: '2026-11-12',
      },
    ] as WorkTask[];
    const events = [
      ['2026-11-10', 'in_progress', 'completed'],
      ['2026-11-11', 'completed', 'in_progress'],
      ['2026-11-12', 'in_progress', 'completed'],
    ].map(([date, before, after]) => ({
      id: `event-${date}`,
      actorId: 'actor',
      kind: 'updated',
      body: '任务状态变更',
      taskId: 'task',
      createdAt: date + 'T00:00:00Z',
      changes: { status: { before, after } },
    })) as WorkTaskEvent[];
    expect(
      remainingTasksAt(tasks, events, Date.parse('2026-11-09T12:00:00Z')),
    ).toBe(1);
    expect(
      remainingTasksAt(tasks, events, Date.parse('2026-11-10T12:00:00Z')),
    ).toBe(0);
    expect(
      remainingTasksAt(tasks, events, Date.parse('2026-11-11T12:00:00Z')),
    ).toBe(1);
    expect(
      remainingTasksAt(tasks, events, Date.parse('2026-11-12T12:00:00Z')),
    ).toBe(0);
  });
  it('does not invent a schedule or count cancelled work', () => {
    expect(plannedForDay({ ...task, plannedHours: null }, '2026-11-09')).toBe(
      0,
    );
    expect(plannedForDay({ ...task, status: 'cancelled' }, '2026-11-09')).toBe(
      0,
    );
    expect(plannedForDay({ ...task, plannedStart: null }, '2026-11-09')).toBe(
      0,
    );
  });
  it('caps display ranges but does not cap distribution denominators', () => {
    expect(dateDays('2026-01-01', '2026-12-31')).toHaveLength(31);
    expect(
      plannedForDay(
        {
          ...task,
          plannedStart: '2026-01-01',
          plannedEnd: '2026-12-31',
          plannedHours: 261,
        },
        '2026-01-01',
      ),
    ).toBe(1);
    expect(dateDays('2026-11-15', '2026-11-09')).toEqual([]);
    expect(actualForDay([], '2026-11-09')).toBe(0);
  });
});
