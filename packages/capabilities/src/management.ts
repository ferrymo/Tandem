import { DomainError } from '@tandem/core';
import type { SkillBundle } from '@tandem/core';

const names = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const permission = /^[a-z][a-z0-9_.:-]{0,99}$/;
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const hasControl = (value: string) =>
  Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
export function validateSkillBundle(bundle: SkillBundle): SkillBundle {
  if (
    !names.test(bundle.name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(bundle.version)
  )
    throw new DomainError(
      'INVALID_INPUT',
      '技能名称和版本只能包含字母、数字、点、横线与下划线',
    );
  if (!bundle.description.trim() || bundle.description.length > 2000)
    throw new DomainError('INVALID_INPUT', '技能用途须为 1–2000 字符');
  if (
    bundle.permissions.length > 32 ||
    bundle.dependencies.length > 32 ||
    bundle.permissions.some((p) => !permission.test(p)) ||
    bundle.dependencies.some((p) => !permission.test(p))
  )
    throw new DomainError('INVALID_INPUT', '技能权限或依赖声明无效');
  const paths = Object.keys(bundle.files);
  if (
    !paths.length ||
    paths.length > 64 ||
    !Object.hasOwn(bundle.files, 'SKILL.md')
  )
    throw new DomainError(
      'INVALID_INPUT',
      '技能包须包含 SKILL.md，且最多 64 个文本文件',
    );
  let total = 0;
  for (const path of paths) {
    if (
      !path ||
      path.length > 200 ||
      path.includes('\\') ||
      path.includes(':') ||
      path.startsWith('/') ||
      path
        .split('/')
        .some(
          (p) =>
            !p ||
            p === '.' ||
            p === '..' ||
            reserved.test(p) ||
            p.toLowerCase().startsWith('.env') ||
            p === '.git',
        ) ||
      hasControl(path)
    )
      throw new DomainError('INVALID_INPUT', '技能资源路径超出允许范围');
    const value = bundle.files[path];
    if (
      typeof value !== 'string' ||
      value.includes('\u0000') ||
      new TextEncoder().encode(value).byteLength > 128 * 1024
    )
      throw new DomainError(
        'INVALID_INPUT',
        '技能资源须为不超过 128 KiB 的文本',
      );
    total += new TextEncoder().encode(path + value).byteLength;
    if (
      /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|sk-(?:proj-)?[A-Za-z0-9_-]{32,}/.test(
        value,
      )
    )
      throw new DomainError(
        'INVALID_INPUT',
        '技能包包含疑似私钥或 API 凭证，请先脱敏',
      );
  }
  if (total > 1024 * 1024)
    throw new DomainError('INVALID_INPUT', '技能包总大小不得超过 1 MiB');
  const markdown = bundle.files['SKILL.md']!;
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter)
    throw new DomainError(
      'INVALID_INPUT',
      'SKILL.md 须包含 name 和 description 元信息',
    );
  const fields = new Map<string, string>();
  for (const line of frontmatter[1]!.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*?)\s*$/);
    if (match) fields.set(match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, '$2'));
  }
  if (fields.get('name') !== bundle.name || !fields.get('description'))
    throw new DomainError(
      'INVALID_INPUT',
      'SKILL.md 的 name 必须与安装名称一致，并声明 description',
    );
  if (bundle.source.kind === 'git') {
    let source: URL;
    try {
      source = new URL(bundle.source.repository);
    } catch {
      throw new DomainError('INVALID_INPUT', '技能仓库地址无效');
    }
    if (
      source.protocol !== 'https:' ||
      source.username ||
      source.password ||
      source.search ||
      source.hash ||
      !/^[a-f0-9]{40}$/i.test(bundle.source.commit) ||
      /(^|\/)\.\.?(\/|$)|\\|^\//.test(bundle.source.path)
    )
      throw new DomainError(
        'INVALID_INPUT',
        '仓库技能须固定 HTTPS 来源、完整提交 SHA 和相对目录',
      );
  } else if (!bundle.source.label.trim() || bundle.source.label.length > 200) {
    throw new DomainError('INVALID_INPUT', '请说明技能包来源');
  }
  return {
    ...bundle,
    permissions: [...new Set(bundle.permissions)].sort(),
    dependencies: [...new Set(bundle.dependencies)].sort(),
    files: Object.fromEntries(
      paths.sort().map((path) => [path, bundle.files[path]!]),
    ),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) +
          ':' +
          canonicalJson((value as Record<string, unknown>)[key]),
      )
      .join(',') +
    '}'
  );
}
