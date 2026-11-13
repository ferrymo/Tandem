import Link from 'next/link';
import { FoundationStatus } from '../../components/foundation-status';

export default function HealthPage() {
  return (
    <main className="standalone-page">
      <h1>开发基线</h1>
      <p className="muted">基础依赖与本地启动状态</p>
      <FoundationStatus />
      <p className="health-return">
        <Link href="/">返回工作台</Link>
      </p>
    </main>
  );
}
