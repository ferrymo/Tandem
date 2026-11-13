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
    typeof p.summary !== 'string' ||
    p.summary.length > 4000 ||
    !Array.isArray(p.limitations) ||
    p.limitations.some((s) => typeof s !== 'string' || s.length > 1000)
  )
    throw new DomainError('INVALID_INPUT', '工程产物结构或体积不符合要求');
  const seen = new Set<string>();
  let size = 0;
  for (const file of p.files) {
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
  if (
    size > 2000000 ||
    !seen.has(safePath(p.previewPath)) ||
    !p.previewPath.endsWith('.html')
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
        total += bytes.length;
        if (total > 10000000 || files.length >= 300)
          throw new DomainError('INVALID_INPUT', '构建产物超过上限');
        files.push({ path, hash: digest(bytes), size: bytes.length });
      }
    };
    await walk(work);
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (!files.some((file) => file.path === pkg.previewPath && file.size > 0))
      results.push({
        command: ['verify-preview', pkg.previewPath],
        exitCode: 1,
        output: '构建后的预览入口不存在或为空',
      });
    const evidence: DeliveryEvidence = {
      artifactRef: ref,
      contentHash: digest(JSON.stringify(files)),
      files,
      commands: results,
      passed:
        results.length === pkg.testCommands.length + pkg.buildCommands.length &&
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
