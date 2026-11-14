import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { DomainError } from '@tandem/core';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const keyPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Stores opaque blobs only. The application owns metadata and resource authorization. */
export class LocalAttachmentStore {
  private readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root))
      throw new DomainError('INVALID_INPUT', '附件目录必须是绝对路径');
    this.root = resolve(root);
  }

  private async directory() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new DomainError('UNAVAILABLE', '附件目录不可用');
    return realpath(this.root);
  }

  private async path(key: string) {
    if (!keyPattern.test(key))
      throw new DomainError('INVALID_INPUT', '附件标识无效');
    return join(await this.directory(), key);
  }

  async put(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new DomainError('INVALID_INPUT', '附件大小须为 1 字节至 20 MB');
    const key = randomUUID();
    const file = await open(await this.path(key), 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } catch (error) {
      await file.close();
      await this.remove(key);
      throw error;
    }
    await file.close();
    return key;
  }

  async read(key: string, expectedSize?: number): Promise<Uint8Array> {
    const path = await this.path(key);
    let file;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new DomainError('UNAVAILABLE', '附件文件不可用');
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.size < 1 ||
        opened.size > MAX_ATTACHMENT_BYTES ||
        (expectedSize !== undefined && opened.size !== expectedSize)
      )
        throw new DomainError(
          'UNAVAILABLE',
          '附件文件不完整，请联系管理员恢复',
        );
      return await file.readFile();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        throw new DomainError('UNAVAILABLE', '附件文件缺失，请联系管理员恢复');
      throw error;
    } finally {
      await file?.close();
    }
  }

  async remove(key: string): Promise<void> {
    const path = await this.path(key);
    try {
      await unlink(path);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return;
      throw error;
    }
  }
}
