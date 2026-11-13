import { zipSync } from 'fflate';
import { DomainError } from '@tandem/core';
import {
  handle,
  requireSession,
  uuid,
} from '../../../../../../../server/collaboration-http';
import {
  executionAdapter,
  productServices,
} from '../../../../../../../server/product';

export function GET(
  request: Request,
  context: {
    params: Promise<{ workspaceId: string; runId: string; path?: string[] }>;
  },
) {
  return handle(async () => {
    const session = await requireSession();
    const params = await context.params;
    const workspaceId = uuid.parse(params.workspaceId);
    const runId = uuid.parse(params.runId);
    const { run } = await productServices(session, workspaceId).delivery.detail(
      session,
      workspaceId,
      runId,
    );
    if (!run.artifact) throw new DomainError('FORBIDDEN', '此运行尚无可读产物');
    const execution = executionAdapter();
    const headers: Record<string, string> = {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy':
        "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    };
    if (new URL(request.url).searchParams.get('download') === '1') {
      const files: Record<string, Uint8Array> = {};
      for (const file of run.artifact.files)
        files[file.path] = (
          await execution.read(run.artifact.artifactRef, file.path)
        ).bytes;
      files['tandem-evidence.json'] = new TextEncoder().encode(
        JSON.stringify(
          {
            runId,
            goal: run.goal,
            acceptance: run.acceptance,
            artifact: run.artifact,
            deployment: run.deployment,
          },
          null,
          2,
        ),
      );
      return new Response(Buffer.from(zipSync(files)), {
        headers: {
          ...headers,
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="tandem-${runId}.zip"`,
        },
      });
    }
    const [kind, ...parts] = params.path ?? [];
    if (kind !== 'preview' && kind !== 'deployment')
      throw new DomainError(
        'INVALID_INPUT',
        '请选择预览、部署入口或下载交付包',
      );
    const artifactRef =
      kind === 'deployment' && run.deployment
        ? run.deployment.artifactRef
        : run.artifact.artifactRef;
    const manifestFile = await execution.read(artifactRef, 'manifest.json');
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestFile.bytes),
    ) as { previewPath: string };
    const filePath = parts.join('/') || 'index.html';
    // The stable entry URL supports relative assets while the package chooses its entry file.
    if (filePath === 'index.html' && manifest.previewPath !== 'index.html') {
      const redirect = new URL(request.url);
      redirect.pathname = `/api/workspaces/${workspaceId}/artifacts/${runId}/${kind}/${manifest.previewPath}`;
      return new Response(null, {
        status: 307,
        headers: { ...headers, Location: redirect.href },
      });
    }
    const path = filePath;
    const file =
      kind === 'deployment' && run.deployment
        ? await execution.deploymentFile(run.deployment.id, path)
        : kind === 'preview'
          ? await execution.read(run.artifact.artifactRef, path)
          : null;
    if (!file) throw new DomainError('FORBIDDEN', '此运行尚无部署记录');
    return new Response(Buffer.from(file.bytes), {
      headers: { ...headers, 'Content-Type': file.contentType },
    });
  });
}
