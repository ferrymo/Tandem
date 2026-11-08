/** 修改禅道密码工具：ZT_ACC=xx ZT_OLD=xx ZT_NEW=xx node --import tsx scripts/change-password.ts */
import { WebBridge } from '@ztp/zentao-sdk'

const BASE = process.env.ZT_BASE_URL ?? 'https://chandao.medon.com.cn'
const ACC = process.env.ZT_ACC
const OLD = process.env.ZT_OLD
const NEW = process.env.ZT_NEW

if (!ACC || !OLD || !NEW) {
  console.error('缺少 ZT_ACC / ZT_OLD / ZT_NEW')
  process.exit(1)
}

const bridge = new WebBridge(BASE)
await bridge.changePassword(ACC, OLD, NEW)
console.log('✓ 密码修改成功且已生效（强制改密标记解除）')
await bridge.login(ACC, NEW)
console.log('✓ 新密码网页会话校验通过')
