'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from 'antd';
export function FoundationStatus() {
  const [state, setState] = useState<'checking' | 'ready' | 'unavailable'>(
    'checking',
  );
  const check = useCallback(async (signal?: AbortSignal) => {
    setState('checking');
    try {
      const result = await fetch('/api/health/ready', {
        cache: 'no-store',
        signal: signal ?? null,
      });
      if (!signal?.aborted) setState(result.ok ? 'ready' : 'unavailable');
    } catch {
      if (!signal?.aborted) setState('unavailable');
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [check]);
  return (
    <section aria-labelledby="status-title">
      <h2 id="status-title">环境状态</h2>
      <div className="status" data-ready={state === 'ready'} role="status">
        <span className="status-dot" aria-hidden="true" />
        {state === 'checking'
          ? '正在检查连接…'
          : state === 'ready'
            ? '基础服务已就绪'
            : '基础服务暂不可用，请检查本地环境'}
      </div>
      <div className="actions">
        <Button onClick={() => void check()} loading={state === 'checking'}>
          重新检查
        </Button>
      </div>
    </section>
  );
}
