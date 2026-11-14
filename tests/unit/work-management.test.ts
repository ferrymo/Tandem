import { describe, expect, it, vi } from 'vitest';
import {
  parseWorkCommand,
  WorkManagementService,
} from '../../packages/application/src/work-management';
import type {
  StoredSession,
  WorkManagementRepository,
} from '../../packages/core/src/index';
const actor = 'f0000000-0000-4000-8000-000000000001';
const project = 'f0000000-0000-4000-8000-000000000002';
describe('native collaboration input boundaries', () => {
  it('rejects invalid calendar days and inverted schedules before persistence', () => {
    for (const date of [
      '2026-02-29',
      '2026-13-01',
      '2026-11-31',
      '2026-11-14T00:00:00Z',
    ])
      expect(() =>
        parseWorkCommand(
          {
            command: 'save-task',
            projectId: project,
            name: '任务',
            plannedStart: date,
          },
          actor,
        ),
      ).toThrow(/日期无效/);
    expect(() =>
      parseWorkCommand(
        {
          command: 'save-project',
          name: '项目',
          initiatedOn: '2026-11-14',
          launchOn: '2026-11-13',
        },
        actor,
      ),
    ).toThrow(/结束日期/);
    expect(() =>
      parseWorkCommand(
        {
          command: 'save-task',
          projectId: project,
          name: '任务',
          actualStart: '2026-11-14',
          actualEnd: '2026-11-13',
        },
        actor,
      ),
    ).toThrow(/结束日期/);
  });
  it('requires an explicit cancellation reason and existing content version', () => {
    expect(() =>
      parseWorkCommand(
        {
          command: 'save-task',
          projectId: project,
          name: '任务',
          status: 'cancelled',
          cancellationReason: '   ',
        },
        actor,
      ),
    ).toThrow(/取消原因/);
    expect(() =>
      parseWorkCommand(
        { command: 'save-task', id: project, projectId: project, name: '任务' },
        actor,
      ),
    ).toThrow(/内容版本/);
  });
  it('prevents ambiguous document spaces while making personal files private', () => {
    expect(() =>
      parseWorkCommand(
        { command: 'save-document', title: '项目文档', scope: 'project' },
        actor,
      ),
    ).toThrow(/关联范围/);
    expect(() =>
      parseWorkCommand(
        {
          command: 'save-document',
          title: '私有文档',
          scope: 'personal',
          projectId: project,
        },
        actor,
      ),
    ).toThrow(/关联范围/);
    expect(
      parseWorkCommand(
        {
          command: 'save-document',
          title: '研究',
          scope: 'personal',
          visibility: 'space',
        },
        actor,
      ),
    ).toMatchObject({ visibility: 'private', projectId: null, teamId: null });
  });
  it('keeps credentials out of channel URLs and only accepts credential references', () => {
    for (const baseUrl of [
      'https://user:secret@example.com',
      'https://example.com?key=secret',
      'https://example.com#secret',
      'file:///etc/passwd',
    ])
      expect(() =>
        parseWorkCommand(
          { command: 'save-model-channel', name: '模型渠道', baseUrl },
          actor,
        ),
      ).toThrow();
    expect(() =>
      parseWorkCommand(
        {
          command: 'save-model-channel',
          name: '渠道',
          baseUrl: 'https://example.com',
          credentialRef: 'sk-plaintext-secret',
        },
        actor,
      ),
    ).toThrow(/环境变量/);
  });
  it('rejects malformed worklog batches and nonfinite hours', () => {
    for (const hours of [NaN, Infinity, -1, 0, 24.1])
      expect(() =>
        parseWorkCommand(
          {
            command: 'log-efforts',
            requestId: project,
            entries: [{ taskId: project, date: '2026-11-14', hours, note: '' }],
          },
          actor,
        ),
      ).toThrow();
    expect(() =>
      parseWorkCommand(
        { command: 'log-efforts', requestId: project, entries: [] },
        actor,
      ),
    ).toThrow(/1–100/);
  });
  it('limits custom roles to supported native capabilities and valid member references', () => {
    expect(() =>
      parseWorkCommand(
        {
          command: 'save-role',
          name: '伪造管理员',
          permissions: ['owner'],
          memberIds: [actor],
        },
        actor,
      ),
    ).toThrow(/不支持的权限/);
    expect(() =>
      parseWorkCommand(
        {
          command: 'save-role',
          name: '角色',
          permissions: ['config.manage'],
          memberIds: ['external-user'],
        },
        actor,
      ),
    ).toThrow(/列表无效/);
    expect(
      parseWorkCommand(
        {
          command: 'save-role',
          name: '能力管理',
          permissions: ['config.manage'],
          memberIds: [actor, actor],
        },
        actor,
      ),
    ).toMatchObject({ permissions: ['config.manage'], memberIds: [actor] });
  });
  it('normalizes model lists and refuses control characters that could break routing references', () => {
    expect(
      parseWorkCommand(
        {
          command: 'save-model-channel',
          name: '渠道',
          baseUrl: 'https://example.com/v1',
          models: ['', ' model ', 'model', '   '],
        },
        actor,
      ),
    ).toMatchObject({ models: ['model'] });
    expect(() =>
      parseWorkCommand(
        {
          command: 'save-model-channel',
          name: '渠道',
          baseUrl: 'https://example.com/v1',
          models: ['model\nother'],
        },
        actor,
      ),
    ).toThrow(/控制字符/);
  });
  it('derives execution identity from authenticated session, discarding forged actor fields', async () => {
    const execute = vi.fn<WorkManagementRepository['execute']>(async () => ({
      id: project,
    }));
    const repository = { execute } as unknown as WorkManagementRepository;
    const service = new WorkManagementService(repository);
    const session = { identity: { id: actor } } as StoredSession;
    await service.execute(session, project, {
      command: 'save-project',
      name: '项目',
      actorId: project,
      createdBy: project,
      workspaceId: actor,
    });
    expect(execute.mock.calls[0]?.[0]).toEqual({
      workspaceId: project,
      actorId: actor,
    });
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ ownerId: actor });
    expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('actorId');
  });
});
