'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from 'antd';
import {
  api,
  ApiError,
  errorMessage,
  type Overview,
  type View,
} from './collaboration-types';
import { ResourceState, type ProductClient } from './product-api';
import type { WorkMenu, WorkSnapshot } from './work-management-types';
import { ProjectsManagement } from './work-projects';
import { DocumentsManagement } from './work-documents';
import { TasksManagement } from './work-tasks';
import { ResourceAnalysis } from './work-analysis';
import { ManagementSettings } from './management-settings';

export function WorkManagement({
  view,
  overview,
  onError,
  onMenus,
}: {
  view: View;
  overview: Overview;
  navigate: (view: View) => void;
  onError: (cause: unknown) => void;
  onMenus: (workspaceId: string, menus: WorkMenu[]) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{
    scope: string;
    data: WorkSnapshot;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const scope = overview.workspace.id;
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const client = useMemo<ProductClient>(
    () => ({
      workspace: overview.workspace,
      team: overview.team,
      projectId: '',
      revision,
      refresh,
      onError,
    }),
    [overview, revision, refresh, onError],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<WorkSnapshot>(`/api/workspaces/${scope}/manage`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) {
          setLoaded({ scope, data });
          onMenus(scope, data.menus);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setLoaded(null);
          setError(errorMessage(cause));
          if (cause instanceof ApiError && [401, 403].includes(cause.status))
            onError(cause);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scope, revision, onError, onMenus]);
  const onCommand = useCallback(
    async (command: string, input: Record<string, unknown>) => {
      try {
        const result = await api(`/api/workspaces/${scope}/manage`, {
          method: 'POST',
          body: JSON.stringify({ command, ...input }),
        });
        refresh();
        return result;
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) onError(cause);
        throw cause;
      }
    },
    [scope, refresh, onError],
  );
  const data = loaded?.scope === scope ? loaded.data : null;
  if (!data || error)
    return <ResourceState error={error} loading={loading} retry={refresh} />;
  const props = { data, client, onCommand };
  return (
    <div className="management-workspace" aria-busy={loading}>
      {view === 'projects' ? (
        <ProjectsManagement {...props} />
      ) : view === 'documents' ? (
        <DocumentsManagement {...props} />
      ) : view === 'tasks' ? (
        <TasksManagement {...props} />
      ) : view === 'analysis' ? (
        <ResourceAnalysis {...props} />
      ) : (
        <ManagementSettings
          section={
            view === 'connectors'
              ? 'connectors'
              : view === 'admin'
                ? 'admin'
                : 'agents'
          }
          {...props}
        />
      )}
      <div className="workspace-sync">
        <span>数据保存在当前工作空间 · 按权限显示</span>
        <Button type="text" size="small" loading={loading} onClick={refresh}>
          刷新数据
        </Button>
      </div>
    </div>
  );
}
