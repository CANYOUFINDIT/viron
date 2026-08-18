export interface IdleResourceLease<T> {
  readonly resource: T;
  readonly reused: boolean;
  release(discard?: boolean): Promise<void>;
}

interface IdleResourceEntry<T> {
  readonly key: string;
  readonly resource: T;
  busy: boolean;
  invalid: boolean;
  idleSince: number;
}

export interface IdleResourcePoolOptions<T> {
  idleMs?: number;
  maxIdlePerKey?: number;
  dispose(resource: T): void | Promise<void>;
  usable?(resource: T): boolean;
  now?(): number;
}

export const CONNECTION_REUSE_IDLE_MS = 60_000;

export class IdleResourcePool<T> {
  private readonly entries = new Set<IdleResourceEntry<T>>();
  private generation = 0;
  private readonly idleMs: number;
  private readonly maxIdlePerKey: number;
  private readonly now: () => number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: IdleResourcePoolOptions<T>) {
    this.idleMs = Math.max(1_000, options.idleMs ?? CONNECTION_REUSE_IDLE_MS);
    this.maxIdlePerKey = Math.max(1, options.maxIdlePerKey ?? 2);
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(() => { void this.cleanup(); }, Math.min(this.idleMs, 30_000));
    this.cleanupTimer.unref?.();
  }

  async acquire(key: string, create: () => Promise<T>): Promise<IdleResourceLease<T>> {
    await this.cleanup();
    const existing = [...this.entries]
      .filter((entry) => entry.key === key && !entry.busy && !entry.invalid && this.usable(entry.resource))
      .sort((left, right) => right.idleSince - left.idleSince)[0];
    const generation = this.generation;
    const resource = existing ? existing.resource : await create();
    if (!existing && generation !== this.generation) {
      await this.options.dispose(resource);
      throw new Error("连接在建立期间已失效，请重试");
    }
    const entry = existing ?? { key, resource, busy: false, invalid: false, idleSince: this.now() };
    if (!existing) this.entries.add(entry);
    entry.busy = true;
    let released = false;
    return {
      resource: entry.resource,
      reused: Boolean(existing),
      release: async (discard = false) => {
        if (released) return;
        released = true;
        entry.busy = false;
        entry.invalid ||= discard || !this.usable(entry.resource);
        entry.idleSince = this.now();
        if (entry.invalid) {
          await this.remove(entry);
          return;
        }
        const idleForKey = [...this.entries]
          .filter((candidate) => candidate.key === key && !candidate.busy && !candidate.invalid)
          .sort((left, right) => right.idleSince - left.idleSince);
        await Promise.all(idleForKey.slice(this.maxIdlePerKey).map((candidate) => this.remove(candidate)));
      },
    };
  }

  async invalidate(match?: (key: string, resource: T) => boolean): Promise<void> {
    this.generation += 1;
    const selected = [...this.entries].filter((entry) => !match || match(entry.key, entry.resource));
    for (const entry of selected) entry.invalid = true;
    await Promise.all(selected.map((entry) => this.remove(entry)));
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.invalidate();
  }

  stats(): { total: number; active: number; idle: number } {
    const active = [...this.entries].filter((entry) => entry.busy).length;
    return { total: this.entries.size, active, idle: this.entries.size - active };
  }

  private usable(resource: T): boolean {
    return this.options.usable?.(resource) ?? true;
  }

  private async cleanup(): Promise<void> {
    const cutoff = this.now() - this.idleMs;
    const expired = [...this.entries].filter((entry) => !entry.busy && (entry.invalid || entry.idleSince <= cutoff || !this.usable(entry.resource)));
    await Promise.all(expired.map((entry) => this.remove(entry)));
  }

  private async remove(entry: IdleResourceEntry<T>): Promise<void> {
    if (!this.entries.delete(entry)) return;
    await this.options.dispose(entry.resource);
  }
}
