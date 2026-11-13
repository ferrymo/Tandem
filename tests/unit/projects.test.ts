import { describe, expect, it, vi } from 'vitest';
import {
  ProjectReadCache,
  validateTaskAction,
} from '../../packages/application/src/projects';
describe('项目协作规则', () => {
  it('读缓存按完整作用域键隔离且TTL到期重新读取', async () => {
    let now = 0;
    const cache = new ProjectReadCache(15000, () => now);
    const load = vi.fn(async () => ({ total: 3 }));
    await cache.read('workspace:user:project:version1', load);
    await cache.read('workspace:user:project:version1', load);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.read('workspace:other-user:project:version1', load);
    await cache.read('workspace:user:project:version2', load);
    expect(load).toHaveBeenCalledTimes(3);
    now = 15001;
    await cache.read('workspace:user:project:version1', load);
    expect(load).toHaveBeenCalledTimes(4);
  });
  it('不允许隐藏字段修改、非法日期、负数和缺少实际时间的完成', () => {
    const version = 'a'.repeat(64);
    expect(() =>
      validateTaskAction({
        kind: 'task.update',
        taskId: '10',
        expectedVersion: version,
        changes: { name: '名称', status: 'done' } as never,
      }),
    ).toThrow();
    expect(() =>
      validateTaskAction({
        kind: 'task.status',
        taskId: '10',
        expectedVersion: version,
        transition: 'finish',
        consumed: 1,
        left: 0,
        comment: '',
      }),
    ).toThrow();
    expect(() =>
      validateTaskAction({
        kind: 'task.effort',
        taskId: '10',
        expectedVersion: version,
        date: '2026-02-30',
        consumed: 1,
        left: 0,
        work: '测试',
      }),
    ).toThrow();
    expect(() =>
      validateTaskAction({
        kind: 'task.effort',
        taskId: '10',
        expectedVersion: version,
        date: '2026-11-01',
        consumed: -1,
        left: 0,
        work: '测试',
      }),
    ).toThrow();
  });
});
