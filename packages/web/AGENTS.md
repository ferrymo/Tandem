<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## zentaopro web 约定

- 设计令牌：`globals.css` 的 CSS 变量（--accent: #5b5bd6 等）+ `src/app/layout.tsx` 的 antd ConfigProvider theme，改配色只动这两处
- 所有页面是 `"use client"` 组件；数据一律经 `src/lib/api.ts` 的 `api()` 访问同源 `/api`（开发由 next.config.ts rewrites 代理到 :3300）
- 登录态：`src/lib/user.ts` 的 `fetchMe`；401 由 api 层统一跳 `/login`
- antd v6 注意：Modal styles 用 `body`（无 `content`）；部分图标名与旧版不同（如无 BoardOutlined）
- 新页面放 `src/app/(main)/` 下并在 `(main)/layout.tsx` 的 NAV/TITLE 注册
