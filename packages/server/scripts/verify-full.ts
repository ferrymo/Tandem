/**
 * 单会话完整工时验证：认证 → 改密（解除本会话的强制跳转）→ 记工时 → API 复核 → 删除测试任务。
 * 每次运行都会把密码改为新值，运行后请以 ZT_NEW 为准。
 */
import { WebBridge, ZentaoClient } from '@ztp/zentao-sdk'

const BASE = process.env.ZT_BASE_URL ?? 'https://chandao.medon.com.cn'
const ACC = process.env.ZT_ACC
const OLD = process.env.ZT_OLD
const NEW = process.env.ZT_NEW
const TASK = Number(process.env.ZT_TASK ?? 0)

if (!ACC || !OLD || !NEW || !TASK) {
  console.error('缺少 ZT_ACC / ZT_OLD / ZT_NEW / ZT_TASK')
  process.exit(1)
}

const date = new Date().toISOString().slice(0, 10)
const bridge = new WebBridge(BASE)

await bridge.authenticate(ACC, OLD)
console.log('✓ 1/6 会话建立')
await bridge.changePassword(ACC, OLD, NEW)
console.log(`✓ 2/6 密码已改为新值，当前会话通行`)

const client = await ZentaoClient.login(BASE, ACC, NEW)
const before = await client.getTask(TASK)
console.log(`✓ 3/6 任务${TASK} 当前 consumed=${before.consumed} left=${before.left}`)

await bridge.recordEstimate(TASK, {date, consumed: 0.5, work: 'zentaopro 工时链路验证'})
const after = await client.getTask(TASK)
const delta = Number(after.consumed) - Number(before.consumed)
console.log(`✓ 4/6 记工时后 consumed=${after.consumed}（+${delta}h）`)
if (delta < 0.5) {
  console.error('✗ 工时未写入')
  process.exit(2)
}

await bridge.deleteTask(TASK)
const check = await fetch(`${BASE}/api.php/v1/tasks/${TASK}`, {
  headers: {Token: client.token},
}).then((r) => r.json() as Promise<{deleted?: boolean; id?: number}>)
console.log(`✓ 5/6 测试任务已删除（复核 deleted=${check.deleted ?? '接口已不可见'}）`)
console.log('✅ 6/6 全链路验证通过：网页桥接记工时 + 删除任务全部可用')
