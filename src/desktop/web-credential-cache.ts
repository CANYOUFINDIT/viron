import type { DesktopWebCredential } from "./device-identity.js";

export const WEB_CREDENTIAL_CACHE_TTL = 30_000;
const caches = new Set<WebCredentialCache>();
export function clearWebCredentialCaches(): void {
  for (const cache of caches) cache.invalidate();
}

/** One account view owns this main-process-only cache. Returned values are copies. */
export class WebCredentialCache {
  private value: DesktopWebCredential | undefined;
  private expiresAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<DesktopWebCredential> | undefined;
  private generation = 0;
  private disposed = false;
  constructor(private readonly options: {
    load(): Promise<{ credential: DesktopWebCredential; expiresAt: string }>;
    current(): boolean;
  }) { caches.add(this); }

  seed(credential: DesktopWebCredential, expiresAt = Date.now() + WEB_CREDENTIAL_CACHE_TTL): void {
    this.invalidate();
    if (this.disposed || !this.options.current()) return;
    this.store(credential, expiresAt);
  }

  private store(credential: DesktopWebCredential, expiresAt: number): void {
    this.expiresAt = Math.min(Date.now() + WEB_CREDENTIAL_CACHE_TTL, expiresAt);
    if (!Number.isFinite(this.expiresAt) || this.expiresAt <= Date.now()) return;
    this.value = structuredClone(credential);
    this.timer = setTimeout(() => this.invalidate(), this.expiresAt - Date.now());
    this.timer.unref();
  }

  invalidate(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.value) {
      this.value.username = this.value.password = "";
      this.value.customFields = {};
    }
    this.value = undefined;
    this.expiresAt = 0;
    this.pending = undefined;
  }

  dispose(): void { this.disposed = true; this.invalidate(); caches.delete(this); }

  async get(): Promise<DesktopWebCredential> {
    if (this.disposed || !this.options.current()) { this.invalidate(); throw new Error("credential-cache-expired"); }
    if (this.value && Date.now() < this.expiresAt) return structuredClone(this.value);
    if (this.value) this.invalidate();
    const generation = this.generation;
    if (this.pending) {
      const credential = await this.pending;
      this.assertCurrent(generation);
      return structuredClone(credential);
    }
    const task = Promise.resolve().then(() => this.options.load()).then(({ credential, expiresAt }) => {
      this.assertCurrent(generation);
      const deadline = Date.parse(expiresAt);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("credential-lease-expired");
      this.store(credential, deadline);
      return structuredClone(credential);
    });
    this.pending = task;
    try {
      const credential = await task;
      this.assertCurrent(generation);
      return structuredClone(credential);
    }
    finally { if (this.pending === task) this.pending = undefined; }
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || !this.options.current() || this.generation !== generation) throw new Error("credential-cache-invalidated");
  }
}
