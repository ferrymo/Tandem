# zentaopro · 禅道多项目指挥台

面向"一人多项目"团队的禅道增强层：多项目进展总览、跨项目工时快捷记录、工时时间轴、资源排期，并为 AI 助手（MCP Server，二期）提供统一的 `zentao-sdk`。

## 结构

```
packages/
  zentao-sdk/   # 禅道 REST v1 客户端 + 网页会话桥接（记工时），server 与 MCP 共用
  server/       # Fastify API (:3300)：会话代理、聚合看板数据、工时批量提交
  web/          # Next.js 16 + Ant Design 6 + Tailwind 4 (:3000)，/api 经 rewrite 代理到 3300
```

## 页面

| 路由 | 说明 |
|---|---|
| `/` 指挥台 | 统计卡 + 项目卡片（进度/延期/收藏），负责人附团队全貌表 |
| `/board` 任务看板 | 跨项目按状态看板，支持项目/人员/关键词过滤，卡片可直接开始/完成（带工时） |
| `/effort` 工时中心 | 跨项目任务一屏批量记工时写回禅道，本周记录/团队记录/按项目累计 |
| `/timeline` 工时时间轴 | 人员 × 日期热力横轴（本周/本月/近30天/自定义），含日合计与明细弹层 |
| `/plan` 资源排期 | 人员甘特：参与项目、任务排期条、逾期红框、预计空闲时间（负责人可见全员） |

## 快速开始

```bash
pnpm install
cp .env.example .env   # 按需修改 ZT_BASE_URL / ZT_LEAD_ACCOUNTS

pnpm dev:server        # API http://localhost:3300
pnpm dev:web           # 前端 http://localhost:3000（开发模式，/api 代理到 3300）

# 生产：构建前端后 next start
pnpm build && pnpm start & pnpm start:web
```

## 设计原则

- **禅道是唯一事实源**：本系统不复制业务数据，任务/项目状态一律以禅道为准；工时提交直接写入禅道。
- **权限天然继承**：每人用本人禅道账号登录，后端以各用户自己的凭证代理请求，看到什么由禅道权限决定；`ZT_LEAD_ACCOUNTS` 额外解锁团队工时视图。
- **工时读取来源可插拔**：当前为"本工具提交记录 + 任务累计工时（API）"；接入禅道只读数据库后自动升级为全量 `zt_effort` 明细（待管理员开账号）。

## 已知限制（实测于禅道 21.7.9）

- REST v1 无独立工时(effort)接口：工时写入走网页会话桥接（`task-recordEstimate`），读取走本工具提交日志 + 任务累计工时。
- REST v1 的 `DELETE /tasks/{id}` 在该实例上返回 success 但不生效，任务删除走网页桥接。
- 禅道开启强制改密策略时，网页桥接不可用：前端会明确提示"请先登录禅道网页修改密码"。
