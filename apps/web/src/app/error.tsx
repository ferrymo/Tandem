'use client';
import { Button } from 'antd';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main>
      <h1>页面暂不可用</h1>
      <p>请重试；如果问题持续，请检查本地服务日志。</p>
      <div className="actions">
        <Button onClick={reset}>重新加载</Button>
      </div>
    </main>
  );
}
