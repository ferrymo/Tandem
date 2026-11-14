import type { WorkEffort, WorkTask, WorkTaskEvent } from '@tandem/core';
const ms = 86400000;
export function dateDays(start: string, end: string) {
  const a = Date.parse(`${start}T00:00:00Z`),
    b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return [];
  return Array.from(
    { length: Math.min(31, Math.floor((b - a) / ms) + 1) },
    (_, i) => new Date(a + i * ms).toISOString().slice(0, 10),
  );
}
export function isWorkday(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}
export function plannedForDay(task: WorkTask, date: string) {
  if (
    task.status === 'cancelled' ||
    task.plannedHours === null ||
    !task.plannedStart ||
    !task.plannedEnd ||
    date < task.plannedStart ||
    date > task.plannedEnd ||
    !isWorkday(date)
  )
    return 0;
  const a = Date.parse(`${task.plannedStart}T00:00:00Z`),
    b = Date.parse(`${task.plannedEnd}T00:00:00Z`);
  const span = Math.floor((b - a) / ms) + 1;
  if (!Number.isFinite(span) || span <= 0) return 0;
  const weeks = Math.floor(span / 7);
  let count = weeks * 5;
  for (let i = weeks * 7; i < span; i++)
    if (isWorkday(new Date(a + i * ms).toISOString().slice(0, 10))) count++;
  return count ? task.plannedHours / count : 0;
}
export function actualForDay(efforts: WorkEffort[], date: string) {
  return efforts
    .filter((e) => e.date === date)
    .reduce((n, e) => n + e.hours, 0);
}
export function remainingTasksAt(
  tasks: WorkTask[],
  events: WorkTaskEvent[],
  at: number,
) {
  return tasks.filter((task) => {
    if (Date.parse(task.createdAt) > at) return false;
    const statusEvents = events
      .filter((e) => e.taskId === task.id && e.changes.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = statusEvents[0]?.changes.status;
    let status =
      typeof first?.before === 'string'
        ? first.before
        : typeof first?.after === 'string'
          ? first.after
          : task.status;
    for (const event of statusEvents) {
      if (Date.parse(event.createdAt) <= at)
        status = String(event.changes.status!.after);
    }
    if (status === 'cancelled') return false;
    if (['completed', 'closed'].includes(status)) {
      // A later completion date must not rewrite an earlier complete/reopen cycle.
      if (statusEvents.length) return false;
      return Boolean(task.actualEnd) && Date.parse(task.actualEnd!) > at;
    }
    return true;
  }).length;
}
export function projectResourceGroups(
  tasks: WorkTask[],
  efforts: WorkEffort[],
) {
  const keys = [
    ...new Set([
      ...tasks.map((t) => `${t.moduleId ?? ''}:${t.assigneeId ?? ''}`),
      ...efforts.map(
        (e) =>
          `${tasks.find((t) => t.id === e.taskId)?.moduleId ?? ''}:${e.actorId}`,
      ),
    ]),
  ];
  return keys.map((key) => {
    const [moduleId, participantId] = key.split(':');
    return {
      key,
      moduleId,
      participantId,
      tasks: tasks.filter(
        (t) =>
          (t.moduleId ?? '') === moduleId &&
          (t.assigneeId ?? '') === participantId,
      ),
      efforts: efforts.filter(
        (e) =>
          e.actorId === participantId &&
          tasks.some(
            (t) => t.id === e.taskId && (t.moduleId ?? '') === moduleId,
          ),
      ),
    };
  });
}
