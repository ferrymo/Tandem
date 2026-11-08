/**
 * zentao-mcp：禅道 MCP Server（stdio 传输）
 *
 * 环境变量：
 *   ZT_BASE_URL  禅道地址，如 https://chandao.medon.com.cn
 *   ZT_ACCOUNT   禅道账号（用你自己的账号，权限天然继承）
 *   ZT_PASSWORD  禅道密码
 *
 * 设计：读操作直接执行；写操作一律走「草稿-确认」——AI 提案（propose_changes），
 * 人工审阅确认后由 AI 调用 execute_changes 才真正落库。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebBridge, ZentaoClient } from '@ztp/zentao-sdk'
import { ZtState } from './state.js'
import { registerDraftTools, registerReadTools } from './tools.js'

function log(msg: string) {
  process.stderr.write(`[zentao-mcp] ${msg}\n`)
}

async function main() {
  const baseUrl = (process.env.ZT_BASE_URL ?? '').replace(/\/+$/, '')
  const account = process.env.ZT_ACCOUNT
  const password = process.env.ZT_PASSWORD
  if (!baseUrl || !account || !password) {
    log('缺少环境变量 ZT_BASE_URL / ZT_ACCOUNT / ZT_PASSWORD')
    process.exit(1)
  }

  log(`登录 ${baseUrl} (账号 ${account})…`)
  const client = await ZentaoClient.login(baseUrl, account, password)
  const bridge = new WebBridge(baseUrl)
  let bridgeOk = false
  try {
    await bridge.login(account, password)
    bridgeOk = true
    log('网页桥接就绪（记工时可用）')
  } catch (e) {
    log(`网页桥接不可用：${e instanceof Error ? e.message : e}（记工时工具将不可用，其余不受影响）`)
  }
  const state = new ZtState(account, client, bridge)

  const server = new McpServer({ name: 'zentao', version: '0.3.0' })
  registerReadTools(server, state)
  registerDraftTools(server, state)

  // 记工时依赖网页桥接，不可用时把 log_effort 做成提示型占位（避免 AI 反复试错）
  if (!bridgeOk) {
    log('log_effort 已降级为提示模式')
  }

  await server.connect(new StdioServerTransport())
  log('MCP Server 已就绪 (stdio)')
}

main().catch((e) => {
  log(`启动失败：${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
