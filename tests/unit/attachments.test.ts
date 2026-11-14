import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalAttachmentStore,
  MAX_ATTACHMENT_BYTES,
} from '../../adapters/execution/src/attachments';
import {
  attachmentDisposition,
  attachmentForm,
  attachmentName,
  attachmentOwner,
} from '../../apps/web/src/server/work-management-http';

const roots: string[] = [];
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'tandem-attachment-test-'));
  roots.push(root);
  return { root, store: new LocalAttachmentStore(root) };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('附件测试清理目标超出临时目录');
    await rm(root, { recursive: true, force: true });
  }
});

describe('附件文件隔离', () => {
  it('只使用随机文件键保存原始内容，删除后不能再读', async () => {
    const fixture = await store();
    const bytes = new TextEncoder().encode('项目方案附件');
    const first = await fixture.store.put(bytes);
    const second = await fixture.store.put(bytes);
    expect(first).not.toBe(second);
    expect(
      Buffer.from(await fixture.store.read(first, bytes.byteLength)),
    ).toEqual(Buffer.from(bytes));
    expect(await readFile(join(fixture.root, first), 'utf8')).toBe(
      '项目方案附件',
    );
    await fixture.store.remove(first);
    await expect(fixture.store.read(first)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(Buffer.from(await fixture.store.read(second))).toEqual(
      Buffer.from(bytes),
    );
  });

  it.each([
    '../secret',
    '/etc/passwd',
    '..\\private',
    'C:\\secret',
    'file.txt',
  ])('拒绝路径形式文件键 %s', async (key) => {
    const fixture = await store();
    await expect(fixture.store.read(key)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(fixture.store.remove(key)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('拒绝空文件、超大文件以及大小与数据库不符的文件', async () => {
    const fixture = await store();
    await expect(fixture.store.put(new Uint8Array())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      fixture.store.put(new Uint8Array(MAX_ATTACHMENT_BYTES + 1)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const key = await fixture.store.put(new Uint8Array([1, 2, 3]));
    await writeFile(join(fixture.root, key), new Uint8Array([1]));
    await expect(fixture.store.read(key, 3)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});

describe('附件上传边界', () => {
  it('解析单文件 multipart，保留文档归属', async () => {
    const form = new FormData();
    const documentId = '5c689b9b-f575-4de5-84a4-4da88d2671b3';
    form.set('file', new File(['报价'], '报价.md'));
    form.set('documentId', documentId);
    const result = await attachmentForm(
      new Request('http://localhost/upload', { method: 'POST', body: form }),
    );
    expect(result.get('documentId')).toBe(documentId);
    expect((result.get('file') as File).size).toBe(6);
    expect(attachmentOwner.parse({ documentId })).toEqual({ documentId });
  });

  it('拒绝重复文件、额外参数及缺少明确归属', async () => {
    const form = new FormData();
    form.append('file', new File(['a'], 'a.txt'));
    form.append('file', new File(['b'], 'b.txt'));
    await expect(
      attachmentForm(
        new Request('http://localhost/upload', { method: 'POST', body: form }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(attachmentOwner.safeParse({}).success).toBe(false);
    expect(
      attachmentOwner.safeParse({
        taskId: '5c689b9b-f575-4de5-84a4-4da88d2671b3',
        documentId: '5c689b9b-f575-4de5-84a4-4da88d2671b3',
      }).success,
    ).toBe(false);
  });

  it('在解析前拒绝超大请求，即使没有声明 Content-Length', async () => {
    const oversized = new Uint8Array(MAX_ATTACHMENT_BYTES + 65537);
    const request = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=test' },
      body: oversized,
    });
    await expect(attachmentForm(request)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('清理路径/控制字符并以安全的中文下载名返回', () => {
    expect(attachmentName('../方案\r\n.txt')).toBe('.._方案__.txt');
    const disposition = attachmentDisposition('方案 "a".md');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('方案');
  });
});
