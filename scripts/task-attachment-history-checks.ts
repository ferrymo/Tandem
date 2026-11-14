import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type pg from 'pg';
import { LocalAttachmentStore } from '../adapters/execution/src/attachments.js';
import type { WorkManagementService } from '../packages/application/src/work-management.js';
import type { StoredSession } from '../packages/core/src/index.js';
import {
  type PostgresCollaborationRepository,
  withScope,
} from '../packages/storage-postgres/src/index.js';

export async function checkTaskAttachmentHistory(input: {
  app: pg.Pool;
  collaboration: PostgresCollaborationRepository;
  service: WorkManagementService;
  owner: StoredSession;
  member: StoredSession;
  workspaceId: string;
}) {
  const { app, collaboration, service, owner, member, workspaceId: ws } = input;
  const editor = await collaboration.createSession({
    login: {
      providerId: owner.identity.providerId,
      subject: randomUUID(),
      displayName: '孙七',
      canCreateWorkspace: false,
    },
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    encryptedCredential: 'isolated-attachment-history',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await collaboration.setMember(
    owner.identity.id,
    ws,
    editor.identity.id,
    'member',
  );
  const act = (data: Record<string, unknown>) =>
    service.execute(owner, ws, data);
  const project = await act({
    command: 'save-project',
    name: '附件生命周期验证',
  });
  const task = await act({
    command: 'save-task',
    projectId: project.id,
    name: '补充需求资料',
  });
  const grants = [];
  for (const [participantId, canWrite] of [
    [editor.identity.id, true],
    [member.identity.id, false],
  ] as const)
    grants.push(
      await act({
        command: 'save-project-member',
        projectId: project.id,
        participantId,
        role: '研发',
        canWrite,
      }),
    );
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'tandem-attachment-history-'));
  const files = new LocalAttachmentStore(directory);
  const events = async () =>
    (await service.snapshot(owner, ws)).taskEvents.filter(
      (event) => event.taskId === task.id,
    );
  try {
    const bytes = Buffer.from('需求资料\n第二行\n', 'utf8');
    const key = await files.put(bytes);
    const attachment = await service.createAttachment(editor, ws, {
      taskId: task.id!,
      name: '需求资料.txt',
      mime: 'application/octet-stream',
      size: bytes.byteLength,
      storageKey: key,
    });
    assert.deepEqual(await files.read(key, attachment.size), bytes);
    const metadata = {
      id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      size: bytes.byteLength,
    };
    let history = await events();
    assert.equal(history.length, 2);
    const added = history.find((event) => event.kind === 'attachment_added')!;
    assert.equal(added.actorId, editor.identity.id);
    assert.equal(added.body, '添加了附件「需求资料.txt」');
    assert.deepEqual(added.changes, {
      attachment: { before: null, after: metadata },
    });

    const failedKey = await files.put(Buffer.from('denied'));
    try {
      await assert.rejects(
        service.createAttachment(member, ws, {
          taskId: task.id!,
          name: '没有编辑权限.txt',
          mime: 'application/octet-stream',
          size: 6,
          storageKey: failedKey,
        }),
        { code: 'FORBIDDEN' },
      );
    } finally {
      await files.remove(failedKey);
    }
    await assert.rejects(service.deleteAttachment(member, ws, attachment.id), {
      code: 'FORBIDDEN',
    });
    assert.deepEqual(await events(), history);
    assert.equal(
      (await service.attachment(member, ws, attachment.id)).id,
      attachment.id,
    );

    // Both requests reach the real DELETE; only the winning row creates history.
    const removals = await Promise.allSettled([
      service
        .deleteAttachment(owner, ws, attachment.id)
        .then(() => files.remove(key)),
      service
        .deleteAttachment(owner, ws, attachment.id)
        .then(() => files.remove(key)),
    ]);
    assert.equal(
      removals.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      removals.filter(
        (result) =>
          result.status === 'rejected' && result.reason?.code === 'FORBIDDEN',
      ).length,
      1,
    );
    await assert.rejects(files.read(key), { code: 'UNAVAILABLE' });
    await assert.rejects(service.attachment(owner, ws, attachment.id), {
      code: 'FORBIDDEN',
    });
    history = await events();
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.find((event) => event.id === added.id),
      added,
    );
    const removed = history.find(
      (event) => event.kind === 'attachment_removed',
    )!;
    assert.equal(removed.actorId, owner.identity.id);
    assert.equal(removed.body, '移除了附件「需求资料.txt」');
    assert.deepEqual(removed.changes, {
      attachment: { before: metadata, after: null },
    });
    assert.ok(removed.createdAt >= added.createdAt);
    const visible = await service.snapshot(member, ws);
    assert.equal(
      visible.taskEvents.filter((event) => event.taskId === task.id).length,
      3,
    );
    assert.ok(!visible.attachments.some((item) => item.id === attachment.id));
    const serialized = JSON.stringify({
      events: history,
      attachments: visible.attachments,
    });
    assert.ok(!serialized.includes(key));
    assert.ok(!serialized.includes(directory));
    assert.ok(!serialized.includes('storageKey'));

    for (const operation of [
      "UPDATE tandem.wm_task_events SET body='篡改'",
      'DELETE FROM tandem.wm_task_events',
    ])
      await assert.rejects(
        withScope(
          app,
          { workspaceId: ws, actorId: owner.identity.id },
          async (client) => {
            await client.query(`${operation} WHERE id=$1`, [added.id]);
          },
        ),
        { code: '42501' },
      );
    assert.deepEqual(await events(), history);

    // Document attachments have their own scope and must not pollute task history.
    const document = await service.execute(editor, ws, {
      command: 'save-document',
      title: '个人研究材料',
      scope: 'personal',
      body: '# 材料',
    });
    const docKey = await files.put(Buffer.from('document'));
    const docAttachment = await service.createAttachment(editor, ws, {
      documentId: document.id!,
      name: '研究资料.txt',
      mime: 'application/octet-stream',
      size: 8,
      storageKey: docKey,
    });
    assert.equal(
      Buffer.from(await files.read(docKey, 8)).toString(),
      'document',
    );
    await service.deleteAttachment(editor, ws, docAttachment.id);
    await files.remove(docKey);
    assert.deepEqual(await events(), history);
    for (const grant of grants)
      await act({
        command: 'remove-project-member',
        id: grant.id,
        version: grant.version,
      });
  } finally {
    const target = resolve(directory);
    assert.equal(relative(tempRoot, target).startsWith('..'), false);
    assert.equal(
      relative(tempRoot, target).startsWith('tandem-attachment-history-'),
      true,
    );
    await rm(target, { recursive: true, force: true });
  }
  console.log(
    '附件生命周期通过：真实本地文件读写、上传/移除双向历史、操作者、删除后保留、并发只记一次、只读拒绝不留事件、存储路径脱敏及历史不可改删。',
  );
}
