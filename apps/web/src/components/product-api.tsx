'use client';
import { useEffect, useState } from 'react';
import { Button } from 'antd';
import {
  api,
  ApiError,
  errorMessage,
  type Overview,
} from './collaboration-types';
import { LoadingRows } from './workspace-dialogs';

export type ProjectItem = {
  id: string;
  externalId: string;
  name: string;
  status: string;
  canWrite: boolean;
};
export type ProductClient = {
  workspace: Overview['workspace'];
  team: Overview['team'];
  projectId: string;
  revision: number;
  refresh: () => void;
  onError: (error: unknown) => void;
};
export function productUrl(
  client: Pick<ProductClient, 'workspace'>,
  resource: string,
  params: Record<string, string> = {},
) {
  return (
    `/api/workspaces/${client.workspace.id}/product?` +
    new URLSearchParams({ resource, ...params })
  );
}
export async function actProduct<T>(
  client: ProductClient,
  command: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  try {
    const result = await api<T>(productUrl(client, 'command'), {
      method: 'POST',
      body: JSON.stringify({ command, ...input }),
    });
    client.refresh();
    return result;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401)
      client.onError(cause);
    throw cause;
  }
}
export function useProductResource<T>(
  client: ProductClient,
  resource: string,
  params: Record<string, string> = {},
  poll = false,
) {
  const url = productUrl(client, resource, params);
  const [data, setData] = useState<T | null>(null);
  const [loadedUrl, setLoadedUrl] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<T>(url, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
          setLoadedUrl(url);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setData(null);
          setLoadedUrl(url);
          setError(errorMessage(cause));
          if (cause instanceof ApiError && cause.status === 401)
            client.onError(cause);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [url, client.revision, tick, client.onError]);
  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [poll]);
  return {
    data: loadedUrl === url ? data : null,
    error: loadedUrl === url ? error : '',
    loading: loading || loadedUrl !== url,
    reload: () => setTick((n) => n + 1),
  };
}
export function ResourceState({
  error,
  loading,
  retry,
  children,
}: {
  error: string;
  loading: boolean;
  retry: () => void;
  children?: React.ReactNode;
}) {
  if (error)
    return (
      <div className="notice notice-error" role="alert">
        <p>{error}</p>
        <Button onClick={retry}>重新读取</Button>
      </div>
    );
  if (loading) return <LoadingRows />;
  return children;
}
export function ErrorText({ value }: { value: string }) {
  return value ? (
    <p role="alert" className="form-error">
      {value}
    </p>
  ) : null;
}
export function Timestamp({ value }: { value: string | null | undefined }) {
  if (!value || !Number.isFinite(Date.parse(value)) || value.startsWith('0000'))
    return <span className="muted">待记录</span>;
  return (
    <time dateTime={value}>
      {new Date(value).toLocaleString('zh-CN', { hour12: false })}
    </time>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="product-empty">
      <h3>{title}</h3>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  );
}
