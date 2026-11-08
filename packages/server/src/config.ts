import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 向上查找 .env（兼容从仓库根或 packages/server 启动） */
function loadEnv() {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    try {
      const raw = readFileSync(resolve(dir, '.env'), 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
        if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
      }
      return
    } catch {
      dir = dirname(dir)
    }
  }
}
loadEnv()

export const config = {
  port: Number(process.env.PORT ?? 3300),
  ztBaseUrl: (process.env.ZT_BASE_URL ?? '').replace(/\/+$/, ''),
  leadAccounts: new Set(
    (process.env.ZT_LEAD_ACCOUNTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  dataDir: resolve(process.cwd(), 'data'),
}

if (!config.ztBaseUrl) {
  console.error('缺少 ZT_BASE_URL 配置，请参考 .env.example 创建 .env')
  process.exit(1)
}
