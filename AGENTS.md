# zentaopro 仓库规则（AGENTS.md）

禅道多项目指挥台：多项目进展总览、工时协同、资源排期、AI 助手（MCP）。禅道是唯一事实源，本系统只做聚合与快捷操作，不复制业务数据。

## 结构

```
packages/
  zentao-sdk/   # 禅道 REST v1 客户端 + 网页会话桥接（记工时/删任务/改密），server 与 mcp 共用
  server/       # Fastify API (:3300)：按用户会话代理禅道（权限继承），聚合接口，会话内缓存
  web/          # Next.js 16 + antd 6 + Tailwind 4 (:3000)，/api 经 rewrite 代理到 3300
  mcp/          # zentao-mcp：MCP Server（stdio），写操作一律草稿-确认
```

## 常用命令

```bash
pnpm install
pnpm dev:server        # API :3300（tsx watch）
pnpm dev:web           # 前端 :3000（next dev）
pnpm build             # 构建前端
pnpm start             # 启动 API（tsx）
pnpm start:web         # 启动前端生产服务
pnpm --filter @ztp/mcp build      # 打包 MCP 单文件 dist/index.js
pnpm --filter @ztp/mcp typecheck  # MCP 类型检查
```

类型检查：各包 `npx tsc --noEmit`（SDK/server/mcp）。

## 约定

- 凭证绝不入库：`.env`、ZCode 用户配置、脚本凭证全走环境变量/本地文件；`data/`（工时日志）、`dist/` 已忽略。
- 每个用户请求都以其禅道会话代理——新增接口不要用服务端全局账号。
- 聚合数据一律走带 TTL 的缓存（`cache.ts` 的 ttlKeyed），写操作后 `drop` 对应缓存。
- 禅道平台实测坑（21.7.9）：REST 无工时接口（记工时走网页桥接 `task-recordWorkhour`，批量数组格式 `date[]/consumed[]/left[]/work[]`）；REST DELETE 不生效；建任务必填 `estStarted`；强制改密策略会让网页会话整体不可用（代码需优雅降级并明确提示）。细节见 zentao-sdk 源码注释。

## 测试

- MCP：`ZT_ACC=xx ZT_PWD=xx node --import tsx scripts/mcp-smoke.mjs`（会真实创建测试任务并尝试清理）
- 工时链路：`packages/server/scripts/verify-effort.ts`（需指定测试任务 ID）
