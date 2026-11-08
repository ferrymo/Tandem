/**
 * zentao-mcp 回环冒烟测试：spawn stdio 服务器 → initialize → tools/list → 只读工具 → 草稿写入 → 清理
 * 运行：ZT_ACC=xx ZT_PWD=xx node scripts/mcp-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.ZT_BASE_URL ?? 'https://chandao.medon.com.cn'
const ACC = process.env.ZT_ACC
const PWD = process.env.ZT_PWD
if (!ACC || !PWD) {
  console.error('缺少 ZT_ACC / ZT_PWD')
  process.exit(1)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '../dist/index.js')
const EXECUTION_ID = Number(process.env.ZT_EXECUTION ?? 87)

const child = spawn('node', [SERVER], {
  env: { ...process.env, ZT_BASE_URL: BASE, ZT_ACCOUNT: ACC, ZT_PASSWORD: PWD },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderrBuf = ''
child.stderr.on('data', (d) => {
  stderrBuf += d.toString()
})

let buf = ''
let nextId = 1
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
})

function request(method, params, timeoutMs = 90000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`请求超时: ${method}`))
    }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

function textOf(resp) {
  try {
    return JSON.parse(resp.result.content[0].text)
  } catch {
    return resp.result?.content?.[0]?.text ?? JSON.stringify(resp)
  }
}

const results = []
function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  // 1. initialize
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  })
  record('initialize', Boolean(init.result?.serverInfo), `server=${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`)
  notify('notifications/initialized', {})

  // 2. tools/list
  const list = await request('tools/list', {})
  const toolNames = (list.result?.tools ?? []).map((t) => t.name)
  const expectTools = ['whoami', 'list_projects', 'list_executions', 'list_tasks', 'get_task', 'workload', 'propose_changes', 'execute_changes', 'get_draft', 'discard_draft']
  const missing = expectTools.filter((t) => !toolNames.includes(t))
  record('tools/list', missing.length === 0, `${toolNames.length} 个工具${missing.length ? `，缺 ${missing}` : ''}`)

  // 3. whoami
  const me = await request('tools/call', { name: 'whoami', arguments: {} })
  const meData = textOf(me)
  record('whoami', meData.account === ACC, `${meData.realname ?? meData}`)

  // 4. list_projects
  const projects = await request('tools/call', { name: 'list_projects', arguments: {} })
  const pdata = textOf(projects)
  record('list_projects', Array.isArray(pdata) && pdata.length > 0, `${pdata.length} 个项目`)

  // 5. list_tasks
  const tasks = await request('tools/call', {
    name: 'list_tasks',
    arguments: { projectId: 18, status: 'wait,doing', limit: 5 },
  })
  const tdata = textOf(tasks)
  record('list_tasks', Array.isArray(tdata.tasks), `项目18 活跃任务 ${tdata.total} 条，返回 ${tdata.tasks?.length ?? 0}`)

  // 6. propose_changes（创建测试任务草稿）
  const stamp = Date.now().toString().slice(-6)
  const draft = await request('tools/call', {
    name: 'propose_changes',
    arguments: {
      actions: [
        {
          type: 'create_task',
          executionId: EXECUTION_ID,
          name: `[zentao-mcp冒烟] ${stamp}`,
          taskType: 'devel',
          pri: 3,
          estimate: 0.5,
          assignedTo: [ACC],
          deadline: '2026-12-31',
        },
      ],
    },
  })
  const dData = textOf(draft)
  const draftId = dData.draftId
  record('propose_changes', Boolean(draftId) && dData.plan?.[0]?.startsWith('✓'), `draft=${draftId}`)

  // 7. execute_changes
  const exec = await request('tools/call', { name: 'execute_changes', arguments: { draftId } })
  const eData = textOf(exec)
  const execDetail = eData.results?.[0]?.message ?? JSON.stringify(eData).slice(0, 150)
  record('execute_changes', typeof eData.summary === 'string' && eData.summary.startsWith('1/1'), execDetail)

  // 8. 验证任务真实存在（list_tasks 搜名字）
  await new Promise((r) => setTimeout(r, 800))
  const verify = await request('tools/call', {
    name: 'list_tasks',
    arguments: { projectId: 18, keyword: `zentao-mcp冒烟`, limit: 5 },
  })
  const vData = textOf(verify)
  const created = (vData.tasks ?? []).find((t) => t.name.includes(stamp))
  record('创建核验', Boolean(created), created ? `任务 #${created.id} 已在禅道可见` : '未找到')

  // 9. 清理：经网页桥接删除测试任务（若桥接受阻则改名校验）
  if (created) {
    const del = await request('tools/call', {
      name: 'propose_changes',
      arguments: { actions: [{ type: 'update_task_status', taskId: created.id, action: 'close', comment: '冒烟测试完成' }] },
    }).catch(() => null)
    const closeDraft = del ? textOf(del) : null
    if (closeDraft?.draftId) {
      await request('tools/call', { name: 'execute_changes', arguments: { draftId: closeDraft.draftId } })
    }
    // 经 SDK 桥接删除（在服务器进程外，直接用 SDK）
    const { WebBridge, ZentaoClient } = await import('@ztp/zentao-sdk')
    const client = await ZentaoClient.login(BASE, ACC, PWD)
    const bridge = new WebBridge(BASE)
    try {
      await bridge.login(ACC, PWD)
      await bridge.deleteTask(created.id)
      record('清理测试任务', true, `任务 #${created.id} 已删除`)
    } catch (e) {
      await client.editTask(created.id, { name: `【测试任务-请忽略】${created.name}` })
      record('清理测试任务', false, `桥接受阻，已改名为「请忽略」：${e.message?.slice(0, 60)}`)
    }
  }

  // 10. 废草稿错误处理
  const bad = await request('tools/call', { name: 'execute_changes', arguments: { draftId: 'nonexist' } })
  record('错误处理', bad.result?.isError === true, String(textOf(bad)).slice(0, 60))
} catch (e) {
  record('流程异常', false, e.message)
} finally {
  child.kill()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`)
if (stderrBuf) console.log('[server stderr]\n' + stderrBuf.split('\n').slice(0, 12).join('\n'))
process.exit(failed.length ? 1 : 0)
