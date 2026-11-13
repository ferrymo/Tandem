import type { Job, JobQueue } from '@tandem/core';
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;
export type HandlerRegistry = ReadonlyMap<string, JobHandler>;
export async function executeJob(
  queue: JobQueue,
  job: Job,
  workerId: string,
  handlers: HandlerRegistry,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const handler = handlers.get(job.kind);
  if (!handler) {
    await queue.fail(job, workerId, 'UNSUPPORTED_JOB_KIND');
    return;
  }
  try {
    await handler(job, signal);
    if (!signal.aborted) await queue.complete(job, workerId);
  } catch {
    if (!signal.aborted) await queue.fail(job, workerId, 'HANDLER_FAILED');
  }
}
export * from './delivery';
