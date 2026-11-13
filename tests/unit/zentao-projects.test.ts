import { describe, expect, it, vi } from 'vitest';
import { ZentaoProjectSystem } from '../../adapters/zentao/src/projects';
import type { TaskDraftAction } from '../../packages/core/src/projects';

const original = {
  id: 10,
  project: 1,
  execution: 2,
  name: '任务',
  status: 'wait',
  desc: '<p>任务说明</p>',
  assignedTo: { account: 'zhangsan' },
  pri: 3,
  estimate: 2,
  deadline: '2026-12-01',
  consumed: 0,
  left: 2,
  lastEditedDate: '2026-11-13 00:00:00',
  realStarted: '',
};
function fixture(
  options: {
    admin?: boolean;
    taskProject?: number;
    rights?: Record<string, unknown>;
  } = {},
) {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method !== 'GET') {
      writes.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({
        ...original,
        status: url.endsWith('/start')
          ? 'doing'
          : url.endsWith('/finish')
            ? 'done'
            : url.endsWith('/close')
              ? 'closed'
              : original.status,
      });
    }
    if (url.includes('/user?'))
      return Response.json({
        profile: { id: 7, account: 'zhangsan' },
        rights: { admin: options.admin ?? true, rights: options.rights ?? {} },
      });
    if (url.includes('/tasks/10'))
      return Response.json({ ...original, project: options.taskProject ?? 1 });
    if (url.includes('/executions/2/tasks'))
      return Response.json({ tasks: [original], total: 1, page: 1 });
    if (url.includes('/executions/2'))
      return Response.json({
        id: 2,
        project: 1,
        name: '迭代',
        status: 'doing',
      });
    if (url.includes('/projects/1'))
      return Response.json({ id: 1, name: '项目', status: 'doing' });
    return Response.json({}, { status: 404 });
  });
  return {
    fetch,
    writes,
    system: new ZentaoProjectSystem({
      connectionId: 'primary',
      baseUrl: 'https://zentao.example/',
      accessToken: 'session_token_123456',
      subject: '7',
      fetch,
    }),
  };
}
describe('禅道项目与任务边界', () => {
  it('读权限核验每次使用原账号令牌，且拒绝跨项目任务和执行', async () => {
    const { fetch, system } = fixture({ taskProject: 9 });
    await expect(system.task('1', '10')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    for (const [, init] of fetch.mock.calls)
      expect(init?.headers).toMatchObject({ Token: 'session_token_123456' });
    await expect(system.tasks('9', '2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('任务版本包含正文与工时，避免秒级时间相同导致覆盖', async () => {
    const { system, fetch } = fixture();
    const before = await system.task('1', '10');
    fetch.mockImplementation(async (input) =>
      String(input).includes('/tasks/10')
        ? Response.json({ ...original, consumed: 1, left: 1 })
        : Response.json({ id: 1, name: '项目', status: 'doing' }),
    );
    const after = await system.task('1', '10');
    expect(before.version).not.toBe(after.version);
    expect(before.description).toBe('任务说明');
  });
  it('权限撤销和旧版本都在发送写请求前阻止', async () => {
    const { system, writes } = fixture({ admin: false });
    await expect(
      system.execute('1', {
        kind: 'task.update',
        taskId: '10',
        expectedVersion: 'a'.repeat(64),
        changes: { name: '越权' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(writes).toEqual([]);
    const allowed = fixture();
    await expect(
      allowed.system.execute('1', {
        kind: 'task.update',
        taskId: '10',
        expectedVersion: 'a'.repeat(64),
        changes: { name: '覆盖' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(allowed.writes).toEqual([]);
  });
  it('创建使用实际执行与负责人，正文作为文本转义，重定向被禁用', async () => {
    const { system, writes, fetch } = fixture();
    await system.execute('1', {
      kind: 'task.create',
      executionId: '2',
      name: '新任务',
      description: '<script>x</script>',
      assignedTo: 'zhangsan',
      startDate: '2026-11-13',
      deadline: '2026-12-01',
      priority: 3,
      estimate: 2,
    });
    expect(writes[0]).toMatchObject({
      url: 'https://zentao.example/api.php/v1/executions/2/tasks',
      body: {
        type: 'devel',
        assignedTo: 'zhangsan',
        desc: '&lt;script&gt;x&lt;/script&gt;',
      },
    });
    for (const [, init] of fetch.mock.calls)
      expect(init?.redirect).toBe('error');
  });
  it('登记工时遵循22.7批量表单数组契约，保留明确工作内容', async () => {
    const { system, writes } = fixture();
    const task = await system.task('1', '10');
    const action: TaskDraftAction = {
      kind: 'task.effort',
      taskId: '10',
      expectedVersion: task.version,
      date: '2026-11-12',
      consumed: 1.5,
      left: 0.5,
      work: '编写与运行测试',
    };
    await system.execute('1', action);
    expect(writes[0]).toEqual({
      url: 'https://zentao.example/api.php/v1/tasks/10/estimate',
      body: {
        date: ['2026-11-12'],
        consumed: [1.5],
        left: [0.5],
        work: ['编写与运行测试'],
      },
    });
  });
  it('状态流转使用专用端点，非法流转不发出写入', async () => {
    const { system, writes } = fixture();
    const task = await system.task('1', '10');
    await system.execute('1', {
      kind: 'task.status',
      taskId: '10',
      expectedVersion: task.version,
      transition: 'start',
      consumed: 0,
      left: 2,
      comment: '开始实施',
    });
    expect(writes[0]?.url).toContain('/tasks/10/start');
    await expect(
      system.execute('1', {
        kind: 'task.status',
        taskId: '10',
        expectedVersion: task.version,
        transition: 'pause',
        consumed: 0,
        left: 2,
        comment: '',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(writes).toHaveLength(1);
  });
  it('缺失工时保持未知，真实零值保留，HTML格式变化也会更换版本', async () => {
    const { system, fetch } = fixture();
    const before = await system.task('1', '10');
    fetch.mockImplementation(async (input) =>
      String(input).includes('/tasks/10')
        ? Response.json({
            ...original,
            estimate: null,
            consumed: 0,
            left: null,
            desc: '<p><strong>任务说明</strong></p>',
          })
        : Response.json({ id: 1, name: '项目', status: 'doing' }),
    );
    const after = await system.task('1', '10');
    expect(after.estimate).toBeNull();
    expect(after.left).toBeNull();
    expect(after.consumed).toBe(0);
    expect(after.version).not.toBe(before.version);
  });
});
