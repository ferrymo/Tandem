import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import type {
  WorkTask,
  WorkEffort,
  WorkTaskEvent,
} from '../../packages/core/src/index';
import {
  dateDays,
  plannedForDay,
  actualForDay,
  hasResourceActivity,
  remainingTasksAt,
  projectResourceGroups,
} from '../../apps/web/src/components/work-analysis-model';
// The Web package typechecks JSX; the root unit runner imports it only for SSR.
const cellModule = '../../apps/web/src/components/work-analysis';
const { resourceCell } = (await import(cellModule)) as {
  resourceCell(
    tasks: WorkTask[],
    entries: WorkEffort[],
    date: string,
    capacity: number | null,
    detail?: boolean,
  ): unknown;
};
const { renderToStaticMarkup } = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
)('react-dom/server') as {
  renderToStaticMarkup(node: unknown): string;
};
const task = {
  plannedStart: '2026-11-09',
  plannedEnd: '2026-11-15',
  plannedHours: 40,
  status: 'in_progress',
} as WorkTask;
describe('resource planning distribution', () => {
  it('shows detail only for a plan allocated in the window or an actual entry in it', () => {
    const visibleDays = dateDays('2026-11-16', '2026-11-20');
    expect(hasResourceActivity([task], [], visibleDays)).toBe(false);
    expect(
      hasResourceActivity(
        [{ ...task, plannedStart: '2026-11-23', plannedEnd: '2026-11-27' }],
        [],
        visibleDays,
      ),
    ).toBe(false);
    expect(
      hasResourceActivity(
        [{ ...task, plannedEnd: '2026-11-20' }],
        [],
        visibleDays,
      ),
    ).toBe(true);
    expect(
      hasResourceActivity(
        [],
        [{ date: '2026-11-13', hours: 5 } as WorkEffort],
        visibleDays,
      ),
    ).toBe(false);
    expect(
      hasResourceActivity(
        [],
        [{ date: '2026-11-17', hours: 5 } as WorkEffort],
        visibleDays,
      ),
    ).toBe(true);
  });
  it('retains unscheduled and cancelled actual work, while weekend overlap alone is no allocation', () => {
    const days = dateDays('2026-11-14', '2026-11-15');
    expect(hasResourceActivity([task], [], days)).toBe(false);
    const missingPlan = { ...task, plannedStart: null, plannedHours: null };
    expect(hasResourceActivity([missingPlan], [], days)).toBe(false);
    expect(
      hasResourceActivity(
        [missingPlan],
        [{ date: '2026-11-14', hours: 2 } as WorkEffort],
        days,
      ),
    ).toBe(true);
    expect(
      hasResourceActivity(
        [{ ...task, status: 'cancelled' }],
        [{ date: '2026-11-14', hours: 2 } as WorkEffort],
        days,
      ),
    ).toBe(true);
  });
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

describe('resource cells preserve missing records in rendered output', () => {
  const markup = (
    tasks: WorkTask[],
    entries: WorkEffort[],
    date: string,
    detail = false,
  ) => renderToStaticMarkup(resourceCell(tasks, entries, date, 8, detail));
  it('renders a future plan without a zero actual bar or zero hour label', () => {
    const html = markup(
      [{ ...task, plannedEnd: '2026-11-20', plannedHours: 80 }],
      [],
      '2026-11-16',
    );
    expect(html).toContain('aria-label="计划8小时"');
    expect(html).toContain('planned-bar');
    expect(html).toContain('aria-label="实际未填报"');
    expect(html).not.toContain('actual-bar');
    expect(html).not.toContain('实际0小时');
    expect(html).not.toContain('>0h<');
    expect(
      markup(
        [{ ...task, plannedEnd: '2026-11-20', plannedHours: 80 }],
        [],
        '2026-11-16',
        true,
      ),
    ).toContain('8 / — h');
  });
  it('renders unplanned actual work with missing plan and keeps numeric actual evidence', () => {
    const unplanned = { ...task, plannedStart: null, plannedHours: null };
    const entries = [{ date: '2026-11-12', hours: 5 } as WorkEffort];
    const html = markup([unplanned], entries, '2026-11-12');
    expect(html).toContain('aria-label="暂无计划"');
    expect(html).not.toContain('planned-bar');
    expect(html).toContain('aria-label="实际5小时"');
    expect(html).toContain('actual-bar');
    expect(markup([unplanned], entries, '2026-11-12', true)).toContain(
      '— / 5 h',
    );
    expect(
      markup(
        [task],
        [{ date: '2026-11-12', hours: 3 } as WorkEffort],
        '2026-11-12',
        true,
      ),
    ).toContain('8 / 3 h');
  });
});
