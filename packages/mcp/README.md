# zentao-mcp · 禅道 MCP Server

让 AI 助手（ZCode / Claude 等任意支持 MCP 的客户端）直接操作禅道：查项目、查任务、建项目、拆任务、维护状态、登记工时。

核心设计：**写操作走「草稿-确认」**——AI 只能通过 `propose_changes` 生成变更草案（服务端校验、不落库），人工审阅确认后 AI 才调用 `execute_changes` 真正执行。权限完全继承你自己的禅道账号。

## 工具清单

| 工具 | 说明 |
|---|---|
| `whoami` | 当前账号信息 |
| `list_projects` | 我可见的全部项目（状态/进度/延期） |
| `list_executions` | 项目下的执行（迭代/阶段） |
| `list_tasks` | 按项目/执行/状态/指派人/关键词过滤任务 |
| `get_task` | 任务详情 |
| `workload` | 成员负载统计（任务数/预计/消耗/剩余） |
| `propose_changes` | **提交变更草案**（不执行），返回 draftId 与校验结果 |
| `get_draft` / `discard_draft` | 查看/放弃草案 |
| `execute_changes` | **人工确认后执行**草案 |

支持的变更动作（propose_changes 的 actions）：
`create_task`（自动补必填的预计开始）、`update_task_status`（start/pause/restart/finish/close，finish 需带消耗与剩余）、`log_effort`（记工时，走网页桥接）、`create_project`（实验性）。

## 团队成员接入（每人两步）

1. 构建一次（或让同事给你 `dist/index.js`）：

```bash
cd packages/mcp && pnpm install && pnpm build   # 产出 dist/index.js（单文件）
```

2. 在你的 AI 客户端 MCP 配置里加（**填自己的禅道账号密码**，权限即与禅道一致）：

```json
{
  "mcp": {
    "servers": {
      "zentao": {
        "command": "node",
        "args": ["D:/project/zentaopro/packages/mcp/dist/index.js"],
        "env": {
          "ZT_BASE_URL": "https://chandao.medon.com.cn",
          "ZT_ACCOUNT": "你的禅道账号",
          "ZT_PASSWORD": "你的禅道密码"
        }
      }
    }
  }
}
```

ZCode 放在用户级 `~/.zcode/cli/config.json`；其他客户端（Claude Desktop 等）按其 MCP 配置格式放置同样的 server 定义。

## 使用示例（AI 对话）

> "把周会里说的登录页改版拆成 3 个任务建到 SCRM2.0 的当前迭代，指派给张红亮，给我看清单"

AI 会：`list_executions` 找到当前迭代 → `propose_changes` 生成 3 条 create_task 草案并列出清单 → 你说"确认" → `execute_changes` 落库 → 返回每条的任务编号。

## 注意

- 凭证保存在本地配置文件中，**不要提交到仓库**；
- `log_effort` 依赖网页会话桥接：若你的账号被禅道强制改密策略拦截，该工具会明确报错，其余工具不受影响；
- 修改禅道密码后需更新配置里的 `ZT_PASSWORD` 并重启客户端会话。

## 测试

```bash
ZT_ACC=你的账号 ZT_PWD=你的密码 node --import tsx scripts/mcp-smoke.mjs
```

冒烟测试覆盖：initialize / tools/list / 只读工具 / propose→execute 真实建任务 / 错误处理（创建的测试任务自动关闭改名）。
