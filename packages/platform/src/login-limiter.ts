import { createHash } from 'node:crypto';

/** Single-web-process budget. Never trust client-controlled forwarding headers. */
export class LoginLimiter {
  private readonly accounts = new Map<
    string,
    { count: number; until: number }
  >();
  private global = { count: 0, until: 0 };
  private active = 0;
  constructor(private readonly now: () => number = Date.now) {}

  acquire(account: string): (() => void) | null {
    const now = this.now();
    for (const [key, value] of this.accounts)
      if (value.until <= now) this.accounts.delete(key);
    if (this.global.until <= now)
      this.global = { count: 0, until: now + 60_000 };
    if (this.global.count >= 60 || this.active >= 5) return null;
    const key = createHash('sha256')
      .update(account.trim().toLowerCase())
      .digest('hex');
    const entry = this.accounts.get(key) ?? { count: 0, until: now + 60_000 };
    if (
      entry.count >= 5 ||
      (!this.accounts.has(key) && this.accounts.size >= 2000)
    )
      return null;
    entry.count++;
    this.global.count++;
    this.accounts.set(key, entry);
    this.active++;
    let released = false;
    return () => {
      if (!released) this.active--;
      released = true;
    };
  }
}
