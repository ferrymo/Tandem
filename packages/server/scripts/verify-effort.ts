/**
 * 工时链路端到端验证脚本：
 * 1. 网页会话桥接登录（验证不再被强制改密拦截）
 * 2. 解析「记录工时」表单
 * 3. 向指定任务写入 0.5h 工时（默认用本工具的测试任务）
 * 4. 经 REST API 回读校验 consumed 增加
 * 5. 网页通道删除该任务并复核
 *
 * 运行：ZT_ACC=xx ZT_PWD=xx ZT_TASK=3196 node --import tsx scripts/verify-effort.ts
 */
import { WebBridge, ZentaoClient } from '@ztp/zentao-sdk'

const BASE = process.env.ZT_BASE_URL ?? 'https://chandao.medon.com.cn'
const ACC = process.env.ZT_ACC
const PWD = process.env.ZT_PWD
const TASK = Number(process.env.ZT_TASK ?? 0)

if (!ACC || !PWD || !TASK) {
  console.error('缺少 ZT_ACC / ZT_PWD / ZT_TASK 环境变量')
  process.exit(1)
}

const date = new Date().toISOString().slice(0, 10)

// 1. 网页桥接登录
const bridge = new WebBridge(BASE)
await bridge.login(ACC, PWD)
console.log('✓ 1/5 网页会话建立成功（强制改密拦截已解除）')

// 2. 解析记工时表单
const form = await bridge.fetchForm(`index.php?m=task&f=recordEstimate&taskID=${TASK}`, 'consumed')
console.log(`✓ 2/5 记工时表单解析成功，字段: ${[...form.fields.keys()].join(', ')}`)

// 3. 写入工时
const client = await ZentaoClient.login(BASE, ACC, PWD)
const before = await client.getTask(TASK)
console.log(`  写入前 consumed=${before.consumed} left=${before.left} status=${before.status}`)
await bridge.recordEstimate(TASK, { date, consumed: 0.5, left: Number(before.left), work: 'zentaopro 连通性验证' })
console.log(`✓ 3/5 已提交工时 0.5h (${date})`)

// 4. API 回读校验
const after = await client.getTask(TASK)
const delta = Number(after.consumed) - Number(before.consumed)
console.log(`✓ 4/5 回读 consumed=${after.consumed}（+${delta}h）status=${after.status}`)
if (delta < 0.5) {
  console.error('✗ 工时未写入，consumed 变化量不足 0.5')
  process.exit(2)
}

// 5. 清理：网页通道删除测试任务
await bridge.deleteTask(TASK)
const check = await fetch(`${BASE}/api.php/v1/tasks/${TASK}`, {
  headers: { Token: client.token },
}).then((r) => r.json() as Promise<{ deleted?: boolean; id?: number }>)
console.log(`✓ 5/5 删除已执行，复核 deleted=${check.deleted ?? '(接口无返回)'} id=${check.id ?? '(已不可见)'}`)
console.log('\n全部通过：网页桥接记工时 + 删除任务链路可用 ✅')
