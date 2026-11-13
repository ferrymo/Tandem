import { describe, it, expect, vi } from 'vitest';
import {
  checkReadiness,
  denyAllAuthorization,
} from '../../packages/application/src/index';
import { mayInvokeRead } from '../../packages/capabilities/src/index';
import { executeJob } from '../../packages/agent-runtime/src/index';
import {
  readWebEnv,
  readWorkerEnv,
  safeErrorCode,
} from '../../packages/platform/src/index';
import type { Job, JobQueue } from '../../packages/core/src/index';
const job: Job = {
  id: 'job',
  workspaceId: 'workspace',
  kind: 'test',
  token: '1',
  attempts: 1,
  maxAttempts: 3,
  reference: 'ref',
  checkpoint: {},
};
const queue = () =>
  ({
    claim: vi.fn(),
    renew: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    checkpoint: vi.fn(),
  }) satisfies JobQueue;
describe('安全默认值', () => {
  it('未配置授权时拒绝资源访问', async () => {
    await expect(
      denyAllAuthorization.assertAllowed(
        { workspaceId: 'a', actorId: 'b' },
        { connectionId: 'c', resourceType: 'task', externalId: 'd' },
        'read',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('未知或写工具不能走只读调用', () => {
    expect(mayInvokeRead('unknown', true, true)).toBe(false);
    expect(mayInvokeRead('write', true, true)).toBe(false);
    expect(mayInvokeRead('read', false, true)).toBe(false);
    expect(mayInvokeRead('read', true, false)).toBe(false);
    expect(mayInvokeRead('read', true, true)).toBe(true);
  });
  it('未配置数据库或危险租约直接拒绝', () => {
    expect(() => readWebEnv({})).toThrow();
    expect(() =>
      readWorkerEnv({
        WORKER_DATABASE_URL: 'postgresql://local/db',
        WORKER_LEASE_MS: '10',
      }),
    ).toThrow();
  });
  it('错误消息不作为日志错误码', () => {
    expect(safeErrorCode(new Error('postgres://user:password@host'))).toBe(
      'INTERNAL_ERROR',
    );
  });
});
describe('健康检查', () => {
  it('数据库失败只返回不可用，不泄露异常', async () => {
    expect(
      await checkReadiness({
        check: async () => {
          throw new Error('secret');
        },
      }),
    ).toEqual({ status: 'unavailable' });
    expect(await checkReadiness({ check: async () => true })).toEqual({
      status: 'ready',
    });
  });
});
describe('运行底座', () => {
  it('已经中止的任务不调用处理器', async () => {
    const q = queue();
    const handler = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await executeJob(
      q,
      job,
      'worker',
      new Map([['test', handler]]),
      controller.signal,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(q.complete).not.toHaveBeenCalled();
  });
  it('未知任务拒绝执行', async () => {
    const q = queue();
    await executeJob(q, job, 'worker', new Map(), new AbortController().signal);
    expect(q.fail).toHaveBeenCalledWith(job, 'worker', 'UNSUPPORTED_JOB_KIND');
    expect(q.complete).not.toHaveBeenCalled();
  });
  it('中止后不写完成状态', async () => {
    const q = queue();
    const c = new AbortController();
    await executeJob(
      q,
      job,
      'worker',
      new Map([
        [
          'test',
          async () => {
            c.abort();
          },
        ],
      ]),
      c.signal,
    );
    expect(q.complete).not.toHaveBeenCalled();
  });
  it('处理失败保留失败状态，不自动重试副作用', async () => {
    const q = queue();
    await executeJob(
      q,
      job,
      'worker',
      new Map([
        [
          'test',
          async () => {
            throw new Error('secret');
          },
        ],
      ]),
      new AbortController().signal,
    );
    expect(q.fail).toHaveBeenCalledWith(job, 'worker', 'HANDLER_FAILED');
    expect(q.complete).not.toHaveBeenCalled();
  });
});
