import { cpSync, existsSync } from 'node:fs';
const source = 'apps/web/.next/static';
const target = 'apps/web/.next/standalone/apps/web/.next/static';
if (!existsSync(source)) throw new Error('先构建 Next.js');
cpSync(source, target, { recursive: true });
if (existsSync('apps/web/public'))
  cpSync('apps/web/public', 'apps/web/.next/standalone/apps/web/public', {
    recursive: true,
  });
console.log('已为本地 standalone 启动复制静态资源');
