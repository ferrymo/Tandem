import { DomainError } from '@tandem/core';
import type { SkillSource, SkillSourcePort } from '@tandem/core';

async function readBounded(url: string, limit: number, signal: AbortSignal) {
  const response = await fetch(url, {
    signal,
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Tandem/0.1',
    },
  });
  if (!response.ok || !response.body)
    throw new DomainError('UNAVAILABLE', '固定版本技能资源不可访问');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new DomainError('INVALID_INPUT', '技能源文件过大');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit)
        throw new DomainError('INVALID_INPUT', '技能源文件过大');
      parts.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError('INVALID_INPUT', '技能源只接受 UTF-8 文本文件');
  }
}

/** Public GitHub repositories only; no clone hooks, moving branches, or host execution. */
export class GithubSkillSource implements SkillSourcePort {
  async load(
    source: Extract<SkillSource, { kind: 'git' }>,
    signal: AbortSignal,
  ) {
    const url = new URL(source.repository);
    const match = url.pathname.match(
      /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    );
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match ||
      !/^[a-f0-9]{40}$/i.test(source.commit) ||
      /(^|\/)\.\.?(\/|$)|\\|^\//.test(source.path)
    )
      throw new DomainError(
        'INVALID_INPUT',
        '仓库安装仅接受公开 GitHub 仓库、完整提交 SHA 和相对技能目录',
      );
    const owner = match[1]!;
    const repo = match[2]!;
    const prefix = source.path.replace(/\/$/, '');
    const tree = JSON.parse(
      await readBounded(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${source.commit}?recursive=1`,
        2 * 1024 * 1024,
        signal,
      ),
    ) as {
      tree?: { path: string; type: string; size?: number; mode: string }[];
      truncated?: boolean;
    };
    if (!Array.isArray(tree.tree) || tree.truncated)
      throw new DomainError(
        'INVALID_INPUT',
        '仓库目录过大或不可用，请上传限定技能目录',
      );
    const entries = tree.tree.filter(
      (e) => e.type === 'blob' && (!prefix || e.path.startsWith(prefix + '/')),
    );
    if (
      !entries.length ||
      entries.length > 64 ||
      entries.some(
        (e) =>
          (e.size ?? 0) > 128 * 1024 ||
          e.mode === '120000' ||
          /(^|\/)\.env(?:\.|$)/i.test(e.path),
      )
    )
      throw new DomainError(
        'INVALID_INPUT',
        '技能目录须不超过 64 个文本文件，禁止符号链接和凭证文件',
      );
    const files: Record<string, string> = {};
    let total = 0;
    for (const entry of entries) {
      const relative = prefix
        ? entry.path.slice(prefix.length + 1)
        : entry.path;
      const content = await readBounded(
        `https://raw.githubusercontent.com/${owner}/${repo}/${source.commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`,
        128 * 1024,
        signal,
      );
      total += new TextEncoder().encode(relative + content).byteLength;
      if (total > 1024 * 1024)
        throw new DomainError('INVALID_INPUT', '技能资源超过 1 MiB');
      files[relative] = content;
    }
    return files;
  }
}
