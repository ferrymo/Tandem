<div align="center">

# Tandem 🚲

**面向多团队、多项目，让人与 AI Agent 共同规划、执行和交付的开源协作平台**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

不替代你的协作系统，做它们之上的协同层。

</div>

---

## 这是什么

一人多项目成为常态，AI Agent 正在成为执行者，而协作工具仍以单项目视角组织一切。Tandem 在你既有的协作系统（禅道 / Jira / 飞书项目…）之上，提供：

- **多项目指挥台** —— 跨项目进展、团队负载、任务看板，一屏全览；
- **工时协同** —— 跨项目一屏批量填报、人员×日期时间轴、多维统计；
- **资源排期** —— 人员甘特与空档规划，谁什么时候有空一目了然；
- **人机协同** —— AI 经 MCP 接入代你规划执行：拆任务、建项目、维护状态、记工时，**一切写操作走"草案 → 人工审阅 → 执行"**，人只负责审阅和纠正。

**下游系统是唯一事实源**：Tandem 不复制业务数据，权限完全继承你的下游账号。禅道是第一个官方连接器（[adapters/zentao](adapters/zentao)），更多连接器在路上。

## 结构

```
apps/
  web/        # Next.js 16 + Ant Design 6（:3000）：工作台/任务/工时/排期 + ⌘K
  server/     # Fastify API（:3300）：会话代理、聚合接口、草案引擎
  mcp/        # tandem-mcp：MCP Server（stdio），AI 助手接入
packages/
  core/       # 领域模型 + 适配器端口（产品层零下游知识）
adapters/
  zentao/     # 禅道连接器：REST v1 + 网页会话桥接（记工时/删除/改密）
```

> 当前仓库处于 v1.0 架构分离阶段（原 `packages/*` → `apps/* + adapters/*`），设计文档见 [docs](docs/)。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 配置下游连接（当前：禅道地址）

pnpm dev:server        # API http://localhost:3300
pnpm dev:web           # 前端 http://localhost:3000
```

AI 助手接入（每人自己的账号，权限即本人）：见 [apps/mcp/README.md](apps/mcp/README.md)。

## 文档

- [产品设计文档](docs/01-产品设计文档.md) —— 定位、概念模型、功能架构、开源策略
- [技术架构文档](docs/02-技术架构文档.md) —— 三层分离、端口定义、连接器准入、ADR
- [设计规范](docs/03-设计规范.md) —— dsh 同源设计令牌、视觉语言、Logo
- [开发进度与计划](docs/04-开发进度与计划.md) —— 已完成盘点与后续路线（滚动更新）

## 设计原则

1. **产品是产品，对接是对接** —— 产品层不出现任何下游系统词汇，一切经适配层端口注入；
2. **下游为事实源** —— 只聚合（带 TTL 缓存）不复制，写操作直写下游；
3. **权限穿透** —— 不自建账号体系，你的下游权限就是 Tandem 权限；
4. **写必经草案** —— AI 与人统一 `propose → review → execute`，可审阅、可追溯。

## License

Apache-2.0 © Tandem Contributors
