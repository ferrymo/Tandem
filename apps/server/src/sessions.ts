import { randomUUID } from 'node:crypto'
import { WebBridge, ZentaoClient } from '@tandem/adapter-zentao'

export interface Session {
  sid: string
  account: string
  realname: string
  /** 仅供网页桥接自动续期使用，仅存在于服务内存 */
  password: string
  client: ZentaoClient
  bridge: WebBridge
  bridgeOk: boolean
  passwordChangeRequired: boolean
  createdAt: number
  lastSeen: number
}

const TTL_MS = 12 * 60 * 60 * 1000
const sessions = new Map<string, Session>()

export function createSession(input: Omit<Session, 'sid' | 'createdAt' | 'lastSeen'>): Session {
  const s: Session = {...input, sid: randomUUID(), createdAt: Date.now(), lastSeen: Date.now()}
  sessions.set(s.sid, s)
  return s
}

export function getSession(sid: string | undefined): Session | undefined {
  if (!sid) return undefined
  const s = sessions.get(sid)
  if (!s) return undefined
  if (Date.now() - s.lastSeen > TTL_MS) {
    sessions.delete(sid)
    return undefined
  }
  s.lastSeen = Date.now()
  return s
}

export function destroySession(sid: string | undefined) {
  if (sid) sessions.delete(sid)
}

export function destroyExpired() {
  const now = Date.now()
  for (const [sid, s] of sessions) if (now - s.lastSeen > TTL_MS) sessions.delete(sid)
}
