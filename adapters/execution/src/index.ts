import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  readdir,
  chmod,
} from 'node:fs/promises';
import { resolve, join, dirname, extname, relative, sep } from 'node:path';
import { DomainError } from '@tandem/core';
import type {
  DeliveryExecution,
  DeliveryFile,
  DeliveryPackage,
  DeploymentReceipt,
  DeliveryEvidence,
} from '@tandem/core';
export type { ExecutionProvider } from '@tandem/core';
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const identifier = (value: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
function safePath(path: string) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 200 ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          !/^[-a-zA-Z0-9_.@]+$/.test(part),
      )
  )
    throw new DomainError('INVALID_INPUT', '产物路径无效');
  return path;
}
export function validateDeliveryPackage(value: unknown): DeliveryPackage {
  if (!value || typeof value !== 'object')
    throw new DomainError('INVALID_INPUT', '工程产物必须是 JSON 对象');
  const p = value as DeliveryPackage;
  if (
    !Array.isArray(p.files) ||
    p.files.length < 2 ||
    p.files.length > 100 ||
    !Array.isArray(p.testCommands) ||
    !p.testCommands.length ||
    p.testCommands.length > 10 ||
    !Array.isArray(p.buildCommands) ||
    p.buildCommands.length > 10 ||
    typeof p.previewPath !== 'string' ||
    typeof p.summary !== 'string' ||
    p.summary.length > 4000 ||
    !Array.isArray(p.limitations) ||
    p.limitations.some((s) => typeof s !== 'string' || s.length > 1000)
  )
    throw new DomainError('INVALID_INPUT', '工程产物结构或体积不符合要求');
  const seen = new Set<string>();
  let size = 0;
  for (const file of p.files) {
    if (!file || typeof file !== 'object')
      throw new DomainError('INVALID_INPUT', '工程文件必须包含路径与文本内容');
    safePath(file.path);
    if (
      file.path.startsWith('.tandem-') ||
      typeof file.content !== 'string' ||
      seen.has(file.path) ||
      file.content.length > 200000
    )
      throw new DomainError('INVALID_INPUT', '文件重复、过大或使用保留路径');
    seen.add(file.path);
    size += Buffer.byteLength(file.content);
  }
  const previewPath = safePath(p.previewPath);
  if (
    size > 2000000 ||
    (!p.buildCommands.length && !seen.has(previewPath)) ||
    previewPath.startsWith('.tandem-') ||
    !previewPath.endsWith('.html')
  )
    throw new DomainError(
      'INVALID_INPUT',
      '请提供两兆以内工程和可运行 HTML 入口',
    );
  for (const command of [...p.testCommands, ...p.buildCommands])
    if (
      !Array.isArray(command) ||
      command.length < 2 ||
      command.length > 20 ||
      !['node', 'npm'].includes(command[0] ?? '') ||
      command.some((arg) => typeof arg !== 'string' || arg.length > 200) ||
      command.some((arg) =>
        ['install', 'i', 'ci', 'exec', 'publish', 'add'].includes(arg),
      )
    )
      throw new DomainError(
        'INVALID_INPUT',
        '仅支持无网络的 node/npm 测试和构建命令',
      );
  if (
    !p.testCommands.some((c) => c[0] === 'node' && c.includes('--test')) ||
    !p.files.some((f) => /\.(test|spec)\.[cm]?js$/.test(f.path))
  )
    throw new DomainError(
      'INVALID_INPUT',
      '必须提供真实 node --test 测试及测试文件',
    );
  return p;
}

type PreviewToken = { kind: 'word' | 'string' | 'punctuation'; value: string };

// This lexer only recognizes common, active API usage. It is deliberately not a
// JavaScript evaluator or a security boundary; the preview CSP remains required.
function previewScriptTokens(source: string): PreviewToken[] {
  const tokens: PreviewToken[] = [];
  let index = 0;
  const quoted = (quote: string) => {
    let value = '';
    index++;
    while (index < source.length) {
      const char = source[index++]!;
      if (char === quote) break;
      if (char === '\\') value += source[index++] ?? '';
      else value += char;
    }
    return value;
  };
  const code = (templateExpression = false) => {
    let braces = 0;
    while (index < source.length) {
      const char = source[index]!;
      if (/\s/.test(char)) {
        index++;
      } else if (source.startsWith('//', index)) {
        const end = source.indexOf('\n', index + 2);
        index = end < 0 ? source.length : end + 1;
      } else if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        index = end < 0 ? source.length : end + 2;
      } else if (char === '"' || char === "'") {
        tokens.push({ kind: 'string', value: quoted(char) });
      } else if (char === '`') {
        index++;
        while (index < source.length) {
          if (source[index] === '\\') index += 2;
          else if (source[index] === '`') {
            index++;
            break;
          } else if (source.startsWith('${', index)) {
            index += 2;
            code(true);
          } else index++;
        }
      } else if (
        char === '/' &&
        (!tokens.length ||
          /^(?:[=(:,!&|?;{>[]|return|throw|case)$/.test(tokens.at(-1)!.value))
      ) {
        // A regexp literal is data, including words such as /localStorage/.
        index++;
        let characterClass = false;
        while (index < source.length) {
          const next = source[index++]!;
          if (next === '\\') index++;
          else if (next === '[') characterClass = true;
          else if (next === ']') characterClass = false;
          else if (next === '/' && !characterClass) break;
        }
        while (/[a-z]/i.test(source[index] ?? '')) index++;
        tokens.push({ kind: 'string', value: '' });
      } else if (/[a-z_$]/i.test(char)) {
        const start = index++;
        while (/[\w$]/.test(source[index] ?? '')) index++;
        tokens.push({ kind: 'word', value: source.slice(start, index) });
      } else {
        index++;
        if (templateExpression && char === '}' && !braces) return;
        if (char === '{') braces++;
        if (char === '}') braces--;
        tokens.push({ kind: 'punctuation', value: char });
      }
    }
  };
  code();
  return tokens;
}

function previewAttribute(value: string) {
  const entities: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    colon: ':',
    Tab: '\t',
    NewLine: '\n',
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);?/gi,
    (full, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity] ?? full;
      const number =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return number > 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : full;
    },
  );
}

/**
 * Compatibility gate for the current single-HTML, inline classic JS/CSS,
 * in-memory preview contract. This is not full JS/DOM or browser validation and
 * does not replace CSP, authorization, Node behavior tests or browser acceptance.
 */
export function deliveryPreviewIssues(html: string): string[] {
  const issues = new Set<string>();
  const embedded = (url: string) => /^(?:data:|#)/i.test(url.trim());
  const script = (source: string) => {
    const tokens = previewScriptTokens(source);
    const unsupported = new Set([
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'sendBeacon',
      'localStorage',
      'sessionStorage',
      'Storage',
      'indexedDB',
      'IDBFactory',
      'caches',
      'Worker',
      'SharedWorker',
      'serviceWorker',
    ]);
    for (const [index, token] of tokens.entries()) {
      const receiver =
        tokens[index - 2]?.value === '?'
          ? tokens[index - 3]
          : tokens[index - 2];
      const propertyString =
        token.kind === 'string' &&
        tokens[index - 1]?.value === '[' &&
        tokens[index + 1]?.value === ']' &&
        (receiver?.kind === 'word' ||
          [')', ']'].includes(receiver?.value ?? ''));
      if (token.kind !== 'word' && !propertyString) continue;
      // Object data keys are not API access; ordinary strings/comments/templates
      // likewise do not make a textual mention into executable API usage.
      if (tokens[index + 1]?.value === ':') continue;
      const member = propertyString || tokens[index - 1]?.value === '.';
      const browserAccess =
        !member ||
        ['window', 'globalThis', 'self', 'navigator'].includes(
          receiver?.value ?? '',
        );
      if (unsupported.has(token.value) && browserAccess)
        issues.add(
          `活跃脚本使用不支持的 ${token.value}；预览仅支持纯内存状态和离线交互，请移除该API`,
        );
      if (
        ['import', 'export'].includes(token.value) &&
        token.kind === 'word' &&
        !member
      )
        issues.add(
          '活跃脚本含 import/export；请在 Node 构建时把共享源内联为经典脚本，最终HTML不能使用模块',
        );
      if (token.value === 'cookie' && tokens[index - 2]?.value === 'document')
        issues.add(
          '活跃脚本访问 document.cookie；隔离预览不提供Cookie，请使用纯内存状态',
        );
      if (token.value === 'storage' && tokens[index - 2]?.value === 'navigator')
        issues.add(
          '活跃脚本访问 navigator.storage；隔离预览不提供持久化存储，请使用纯内存状态',
        );
    }
  };
  const css = (source: string) => {
    // Scan outside comments and standalone strings (e.g. content:"url(x)").
    const pattern =
      /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@import\b|@font-face\b|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi;
    for (const match of source.matchAll(pattern)) {
      if (/^@import/i.test(match[0]))
        issues.add('CSS使用 @import；请把样式内联到最终HTML');
      else if (/^@font-face/i.test(match[0]))
        issues.add(
          'CSS使用 @font-face；当前预览仅支持系统字体，请移除字体资源',
        );
      else if (
        /^url\(/i.test(match[0]) &&
        !embedded(match[1] ?? match[2] ?? match[3] ?? '')
      )
        issues.add('CSS引用非data资源；请内联为data URL或使用文档内SVG片段');
    }
  };
  // Raw script/style/text regions are consumed as a unit so examples in text,
  // JSON data blocks and HTML comments are not treated as active resource tags.
  const tags =
    /<!--[\s\S]*?-->|<(\/?)([a-z][a-z\d:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let templateDepth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (!match[2]) continue;
    const tag = match[2].toLowerCase();
    const closing = match[1] === '/';
    if (tag === 'template') {
      templateDepth = Math.max(0, templateDepth + (closing ? -1 : 1));
      continue;
    }
    if (closing) continue;
    const attributes = new Map<string, string>();
    const attr =
      /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const item of match[3]!.matchAll(attr)) {
      const name = item[1]!.toLowerCase();
      if (!attributes.has(name))
        attributes.set(
          name,
          previewAttribute(item[2] ?? item[3] ?? item[4] ?? ''),
        );
    }
    let body = '';
    if (
      ['script', 'style', 'textarea', 'title', 'xmp', 'noscript'].includes(tag)
    ) {
      const end = new RegExp(`</${tag}\\s*>`, 'gi');
      end.lastIndex = tags.lastIndex;
      const close = end.exec(html);
      body = html.slice(tags.lastIndex, close?.index ?? html.length);
      tags.lastIndex = close ? end.lastIndex : html.length;
      if (!close && !templateDepth && ['script', 'style'].includes(tag))
        issues.add(`最终HTML的 ${tag} 标签未闭合；请修复截断的入口文件`);
    }
    if (templateDepth) continue;
    if (tag === 'script') {
      const type = attributes.get('type')?.trim().toLowerCase() ?? '';
      if (['module', 'importmap', 'speculationrules'].includes(type))
        issues.add('最终HTML使用模块脚本/importmap；请构建为内联经典脚本');
      if (
        [
          '',
          'text/javascript',
          'application/javascript',
          'text/ecmascript',
          'application/ecmascript',
          'module',
        ].includes(type)
      ) {
        if (['src', 'href', 'xlink:href'].some((name) => attributes.has(name)))
          issues.add(
            '最终HTML引用外链script；受保护资源在sandbox内无法携带会话，请在构建时内联JS',
          );
        script(body);
      }
    } else if (tag === 'style') css(body);
    for (const [name, value] of attributes) {
      if (name.startsWith('on')) script(value);
      if (name === 'style') css(value);
      if (
        ['src', 'poster', 'background', 'data', 'xlink:href'].includes(name) &&
        tag !== 'script'
      ) {
        if (
          !(name === 'xlink:href' && tag === 'use'
            ? embedded(value)
            : /^data:/i.test(value.trim()))
        )
          issues.add(
            `标签 ${tag} 的 ${name} 引用非data资源；请把资源内联到最终HTML`,
          );
      }
    }
    if (['iframe', 'object', 'embed'].includes(tag))
      issues.add(
        `最终HTML包含 ${tag}；当前隔离预览不支持嵌套文档或插件，请改为内联内容`,
      );
    if (
      ['audio', 'video', 'source', 'track'].includes(tag) &&
      attributes.has('src')
    )
      issues.add('最终HTML包含媒体资源；当前预览仅支持内联图像和离线交互');
    if (attributes.has('srcset'))
      issues.add(
        '最终HTML使用srcset；请改为单个内联data图像，避免额外资源请求',
      );
    if (tag === 'link' && attributes.has('href')) {
      if (
        (attributes.get('rel') ?? '')
          .toLowerCase()
          .split(/\s+/)
          .includes('stylesheet')
      )
        issues.add(
          '最终HTML引用link stylesheet；请在构建时把CSS内联到style标签',
        );
      else if (!embedded(attributes.get('href')!))
        issues.add('最终HTML的link引用非data资源；请内联或移除');
    }
    if (
      ['image', 'use', 'feimage'].includes(tag) &&
      attributes.has('href') &&
      !embedded(attributes.get('href')!)
    )
      issues.add('SVG引用外部资源；请使用内联data图像或文档内SVG片段');
    if (
      tag === 'a' &&
      attributes.has('href') &&
      !attributes.get('href')!.startsWith('#')
    )
      issues.add(
        '最终HTML包含页面外导航；当前预览仅支持文档内交互，请移除链接或改为页内片段',
      );
    if (attributes.has('download'))
      issues.add(
        '最终HTML请求文件下载；当前sandbox不支持下载，请使用纯内存交互',
      );
    if (
      (tag === 'form' && attributes.has('action')) ||
      attributes.has('formaction')
    )
      issues.add(
        '最终HTML包含表单提交目标；当前预览禁止外部提交，请用preventDefault处理纯内存表单',
      );
    if (
      tag === 'base' ||
      (tag === 'meta' &&
        attributes.get('http-equiv')?.toLowerCase() === 'refresh')
    )
      issues.add('最终HTML包含base或刷新导航；请保留单文档离线交互');
  }
  return [...issues];
}
function command(
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
  timeout = 120000,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolveResult) => {
    execFile(
      binary,
      [...args],
      { signal, timeout, maxBuffer: 1000000, windowsHide: true },
      (error, stdout, stderr) =>
        resolveResult({
          exitCode: error
            ? typeof error.code === 'number'
              ? error.code
              : 1
            : 0,
          output: (stdout + '\n' + stderr).slice(-20000),
        }),
    );
  });
}
export class DockerDeliveryExecution implements DeliveryExecution {
  readonly configured = true;
  private readonly root: string;
  constructor(
    private readonly config: {
      root: string;
      image: string;
      dockerBinary?: string;
    },
  ) {
    this.root = resolve(config.root);
    if (this.root.includes(',') || !/^[-a-zA-Z0-9_./:@]+$/.test(config.image))
      throw new DomainError('INVALID_INPUT', '执行目录或容器镜像无效');
  }
  private location(ref: string) {
    if (!/^artifacts\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(ref))
      throw new DomainError('FORBIDDEN', '产物引用无效');
    return join(this.root, ...ref.split('/'));
  }
  async verify(
    input: Parameters<DeliveryExecution['verify']>[0],
  ): Promise<DeliveryEvidence> {
    if (
      !identifier(input.runId) ||
      !Number.isInteger(input.revision) ||
      input.revision < 0
    )
      throw new DomainError('INVALID_INPUT', '运行标识无效');
    const pkg = validateDeliveryPackage(input.package);
    const ref = `artifacts/${input.runId}/${input.revision}-${randomUUID()}`;
    const folder = this.location(ref);
    const work = join(folder, 'files');
    const available = await command(
      this.config.dockerBinary ?? 'docker',
      ['image', 'inspect', '--format', '{{.Id}}', this.config.image],
      input.signal,
      10000,
    );
    if (available.exitCode !== 0)
      throw new DomainError(
        'UNAVAILABLE',
        '隔离执行镜像不可用；请启动 Docker 并预先拉取固定镜像后续跑',
      );
    await mkdir(work, { recursive: true, mode: 0o700 });
    const save = async (file: DeliveryFile) => {
      const target = join(work, safePath(file.path));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { mode: 0o600, flag: 'wx' });
    };
    for (const file of pkg.files) await save(file);
    for (const file of input.supportFiles ?? [])
      await save({
        path: '.tandem-skills/' + safePath(file.path),
        content: file.content,
      });
    const writable = async (path: string) => {
      await chmod(path, 0o777);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await writable(child);
        else await chmod(child, 0o666);
      }
    };
    await writable(work);
    const results: DeliveryEvidence['commands'][number][] = [];
    // Generated code sees only this one scratch folder. No host socket, network or credentials.
    for (const args of [...pkg.buildCommands, ...pkg.testCommands]) {
      if (input.signal.aborted) throw new DomainError('CONFLICT', '执行已中断');
      const name = 'tandem-' + randomUUID();
      const dockerArgs = [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--network=none',
        '--user',
        '1000:1000',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--read-only',
        '--pids-limit=128',
        '--memory=512m',
        '--cpus=1',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--mount',
        `type=bind,source=${work},target=/workspace`,
        '--workdir',
        '/workspace',
        '--env',
        'HOME=/tmp',
        '--env',
        'npm_config_cache=/tmp/npm',
        this.config.image,
        ...args,
      ];
      const result = await command(
        this.config.dockerBinary ?? 'docker',
        dockerArgs,
        input.signal,
      );
      await command(
        this.config.dockerBinary ?? 'docker',
        ['rm', '-f', name],
        new AbortController().signal,
        10000,
      );
      results.push({ command: args, ...result });
      if (result.exitCode !== 0) break;
    }
    const files: DeliveryEvidence['files'][number][] = [];
    let previewBytes: Buffer | undefined;
    let total = 0;
    const walk = async (folderPath: string) => {
      for (const entry of await readdir(folderPath, { withFileTypes: true })) {
        const full = join(folderPath, entry.name);
        const metadata = await lstat(full);
        if (
          metadata.isSymbolicLink() ||
          (!metadata.isDirectory() && !metadata.isFile())
        )
          throw new DomainError('INVALID_INPUT', '产物不得包含链接或特殊文件');
        if (metadata.isDirectory()) {
          await walk(full);
          continue;
        }
        const path = relative(work, full).split(sep).join('/');
        safePath(path);
        const bytes = await readFile(full);
        if (path === pkg.previewPath) previewBytes = bytes;
        total += bytes.length;
        if (total > 10000000 || files.length >= 300)
          throw new DomainError('INVALID_INPUT', '构建产物超过上限');
        files.push({ path, hash: digest(bytes), size: bytes.length });
      }
    };
    await walk(work);
    files.sort((a, b) => a.path.localeCompare(b.path));
    let previewIssues = ['构建后的预览入口不存在或为空'];
    if (previewBytes?.length) {
      try {
        previewIssues = deliveryPreviewIssues(
          new TextDecoder('utf-8', { fatal: true }).decode(previewBytes),
        );
      } catch {
        previewIssues = [
          '构建后的预览入口不是有效UTF-8 HTML，请输出完整文本入口',
        ];
      }
    }
    results.push({
      command: ['verify-preview', pkg.previewPath],
      exitCode: previewIssues.length ? 1 : 0,
      output: previewIssues.length
        ? previewIssues.join('\n')
        : '构建后的入口符合单HTML、内联经典JS/CSS、纯内存预览的静态契约；仍须浏览器验收，CSP和授权继续生效',
    });
    const evidence: DeliveryEvidence = {
      artifactRef: ref,
      contentHash: digest(JSON.stringify(files)),
      files,
      commands: results,
      execution: {
        kind: 'docker',
        image: this.config.image,
        network: 'none',
        user: '1000:1000',
        browserValidation: 'not_performed',
      },
      passed:
        results.length ===
          pkg.testCommands.length + pkg.buildCommands.length + 1 &&
        results.every((c) => c.exitCode === 0),
      verifiedAt: new Date().toISOString(),
    };
    await writeFile(
      join(folder, 'manifest.json'),
      JSON.stringify({
        evidence,
        previewPath: pkg.previewPath,
        summary: pkg.summary,
        limitations: pkg.limitations,
      }),
      { mode: 0o600 },
    );
    return evidence;
  }
  async read(artifactRef: string, path: string) {
    const folder = this.location(artifactRef);
    const manifest = JSON.parse(
      await readFile(join(folder, 'manifest.json'), 'utf8'),
    ) as { evidence: DeliveryEvidence };
    if (path === 'manifest.json')
      return {
        bytes: Buffer.from(JSON.stringify(manifest, null, 2)),
        contentType: 'application/json; charset=utf-8',
      };
    const expected = manifest.evidence.files.find(
      (f) => f.path === safePath(path),
    );
    if (!expected) throw new DomainError('FORBIDDEN', '文件不属于此产物');
    const bytes = await readFile(join(folder, 'files', path));
    if (digest(bytes) !== expected.hash)
      throw new DomainError('CONFLICT', '产物已变化，请重新验证');
    return {
      bytes,
      contentType: mime[extname(path)] ?? 'application/octet-stream',
    };
  }
  private deploymentPath(id: string) {
    if (!identifier(id)) throw new DomainError('FORBIDDEN', '部署引用无效');
    return join(this.root, 'deployments', id + '.json');
  }
  private async health(
    artifactRef: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const manifest = JSON.parse(
      await readFile(join(this.location(artifactRef), 'manifest.json'), 'utf8'),
    ) as { previewPath: string };
    const server = createServer((request, response) => {
      void this.read(
        artifactRef,
        (request.url ?? '/').slice(1) || manifest.previewPath,
      )
        .then((file) => {
          response.setHeader('Content-Type', file.contentType);
          response.end(file.bytes);
        })
        .catch(() => {
          response.statusCode = 404;
          response.end();
        });
    });
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') return false;
      const result = await fetch(
        `http://127.0.0.1:${address.port}/${manifest.previewPath}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
      );
      return result.ok && (await result.arrayBuffer()).byteLength > 0;
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }
  async inspectDeployment(
    projectId: string,
    deploymentId: string,
    signal: AbortSignal,
  ) {
    let receipt: DeploymentReceipt & { projectId: string };
    try {
      receipt = JSON.parse(
        await readFile(this.deploymentPath(deploymentId), 'utf8'),
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return {
          receipt: null,
          healthy: false,
          verifiedAt: new Date().toISOString(),
        };
      throw error;
    }
    if (receipt.projectId !== projectId)
      throw new DomainError('FORBIDDEN', '部署不属于当前项目');
    const manifest = JSON.parse(
      await readFile(
        join(this.location(receipt.artifactRef), 'manifest.json'),
        'utf8',
      ),
    ) as { evidence: DeliveryEvidence };
    if (manifest.evidence.contentHash !== receipt.contentHash)
      throw new DomainError(
        'CONFLICT',
        '部署内容摘要不匹配，保留未知结果等待检查',
      );
    const healthy =
      receipt.status === 'failed'
        ? false
        : await this.health(receipt.artifactRef, signal);
    return { receipt, healthy, verifiedAt: new Date().toISOString() };
  }
  async deploy(
    input: Parameters<DeliveryExecution['deploy']>[0],
  ): Promise<DeploymentReceipt> {
    if (
      !input.artifact.passed ||
      !identifier(input.runId) ||
      !identifier(input.projectId) ||
      !identifier(input.approvalId)
    )
      throw new DomainError('INVALID_INPUT', '只能部署已验证的获批版本');
    const path = this.deploymentPath(input.approvalId);
    try {
      const receipt = JSON.parse(
        await readFile(path, 'utf8'),
      ) as DeploymentReceipt;
      if (
        receipt.artifactRef !== input.artifact.artifactRef ||
        receipt.contentHash !== input.artifact.contentHash
      )
        throw new DomainError('CONFLICT', '审批已用于其他版本');
      return receipt;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    const manifest = JSON.parse(
      await readFile(
        join(this.location(input.artifact.artifactRef), 'manifest.json'),
        'utf8',
      ),
    ) as { evidence: DeliveryEvidence; previewPath: string };
    if (manifest.evidence.contentHash !== input.artifact.contentHash)
      throw new DomainError('CONFLICT', '审批产物摘要不匹配');
    const healthy = await this.health(input.artifact.artifactRef, input.signal);
    if (input.signal.aborted)
      throw new DomainError('CONFLICT', '部署执行已中断，尚未发布');
    await mkdir(join(this.root, 'deployments'), {
      recursive: true,
      mode: 0o700,
    });
    const active = join(
      this.root,
      'deployments',
      'active-' + input.projectId + '.json',
    );
    let previous: DeploymentReceipt | null;
    try {
      previous = JSON.parse(await readFile(active, 'utf8'));
    } catch {
      previous = null;
    }
    const receipt: DeploymentReceipt = {
      id: input.approvalId,
      artifactRef: input.artifact.artifactRef,
      contentHash: input.artifact.contentHash,
      version: Number(
        input.artifact.artifactRef.split('/').at(-1)?.split('-')[0] ?? 0,
      ),
      status: healthy ? 'healthy' : 'failed',
      environment: 'local-demo',
      healthCheckedAt: new Date().toISOString(),
      previousDeploymentId: previous?.id ?? null,
    };
    await writeFile(
      path,
      JSON.stringify({ ...receipt, projectId: input.projectId }),
      { mode: 0o600, flag: 'wx' },
    );
    if (healthy) {
      const temp = active + '.' + randomUUID();
      await writeFile(temp, JSON.stringify(receipt), { mode: 0o600 });
      await rename(temp, active);
    }
    return receipt;
  }
  async rollback(
    input: Parameters<DeliveryExecution['rollback']>[0],
  ): Promise<DeploymentReceipt> {
    const existing = await this.inspectDeployment(
      input.projectId,
      input.approvalId,
      input.signal,
    );
    if (existing.receipt) {
      if (
        existing.receipt.previousDeploymentId !== input.deploymentId ||
        !['rolled_back', 'failed'].includes(existing.receipt.status)
      )
        throw new DomainError('CONFLICT', '回滚审批已用于其他目标');
      return existing.receipt;
    }
    const current = JSON.parse(
      await readFile(this.deploymentPath(input.deploymentId), 'utf8'),
    ) as DeploymentReceipt & { projectId: string };
    const active = JSON.parse(
      await readFile(
        join(this.root, 'deployments', 'active-' + input.projectId + '.json'),
        'utf8',
      ),
    ) as DeploymentReceipt;
    if (current.projectId !== input.projectId || active.id !== current.id)
      throw new DomainError('CONFLICT', '项目当前部署已变化，请重新提案');
    if (!current.previousDeploymentId)
      throw new DomainError('INVALID_INPUT', '没有可回滚的前一部署版本');
    const previous = JSON.parse(
      await readFile(this.deploymentPath(current.previousDeploymentId), 'utf8'),
    ) as DeploymentReceipt;
    const manifest = JSON.parse(
      await readFile(
        join(this.location(previous.artifactRef), 'manifest.json'),
        'utf8',
      ),
    ) as { evidence: DeliveryEvidence };
    const restored = await this.deploy({
      runId: input.runId,
      projectId: input.projectId,
      artifact: manifest.evidence,
      approvalId: input.approvalId,
      signal: input.signal,
    });
    const receipt: DeploymentReceipt = {
      ...restored,
      status: restored.status === 'healthy' ? 'rolled_back' : 'failed',
      previousDeploymentId: current.id,
    };
    await writeFile(
      this.deploymentPath(input.approvalId),
      JSON.stringify({ ...receipt, projectId: input.projectId }),
      { mode: 0o600 },
    );
    return receipt;
  }
  async deploymentFile(deploymentId: string, path: string) {
    const receipt = JSON.parse(
      await readFile(this.deploymentPath(deploymentId), 'utf8'),
    ) as DeploymentReceipt;
    if (!['healthy', 'rolled_back'].includes(receipt.status))
      throw new DomainError('UNAVAILABLE', '部署未通过健康检查');
    return this.read(receipt.artifactRef, path);
  }
}
