import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="standalone-page">
      <h1>页面不存在</h1>
      <p>
        <Link href="/">返回工作台</Link>
      </p>
    </main>
  );
}
