import type { Metadata } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { Providers } from '../components/providers';
import './globals.css';
import '@uiw/react-md-editor/markdown-editor.css';
import './management.css';
export const metadata: Metadata = {
  title: 'Tandem · 协作工作台',
  description: '人与 AI Agent 团队协作平台',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <Providers>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
