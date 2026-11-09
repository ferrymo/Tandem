/** 带 TTL 与在途去重的异步缓存（keyed） */
export function ttlKeyed<A, T>(fn: (arg: A) => Promise<T>, ttlMs: number): {
  (arg: A): Promise<T>
  drop: (arg: A) => void
} {
  const map = new Map<A, {p: Promise<T>; expires: number}>()
  const get = (a: A): Promise<T> => {
    const hit = map.get(a)
    if (hit && Date.now() < hit.expires) return hit.p
    const p = fn(a).catch((e) => {
      map.delete(a)
      throw e
    })
    map.set(a, {p, expires: Date.now() + ttlMs})
    return p
  }
  get.drop = (a: A) => map.delete(a)
  return get
}
