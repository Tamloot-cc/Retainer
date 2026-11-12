/**
 * The first gate at webhook ingress: a per-process, per-address and
 * per-callback count in one-minute windows, checked before any database
 * access. It stops one source from flooding a callback, and it caps how many
 * failed or in-flight verifications one source can add to the callback's
 * durable failure budget, so junk from one address cannot exhaust it for the provider.
 *
 * It is a best-effort guard, not an exact count: each process (or Lambda
 * instance) keeps its own windows, and the map is bounded.
 */
export class IngressLimiter {
  private readonly windows = new Map<
    string,
    { start: number; requests: number; failures: number }
  >();
  /** Failed verifications one source may cause per window: a tenth of the budget, at least one. */
  readonly failureLimit: number;
  constructor(
    readonly limit: number,
    private readonly windowMs = 60000,
    private readonly maxKeys = 10000,
  ) {
    this.failureLimit = Math.max(1, Math.floor(limit / 10));
  }
  private entry(key: string, now: number) {
    const start = now - (now % this.windowMs);
    let entry = this.windows.get(key);
    if (!entry || entry.start !== start) {
      if (!entry && this.windows.size >= this.maxKeys) this.sweep(start);
      entry = { start, requests: 0, failures: 0 };
      this.windows.set(key, entry);
    }
    return entry;
  }
  /**
   * Counts a request and reserves one of its source's failures until
   * `settle`, so concurrent junk cannot outrun the failure cap. False, with
   * nothing reserved, when the source has used its requests or failures.
   */
  admit(key: string, now = Date.now()) {
    const entry = this.entry(key, now);
    entry.requests++;
    if (entry.requests > this.limit || entry.failures >= this.failureLimit) return false;
    entry.failures++;
    return true;
  }
  /** Keeps the reservation as a failure, or releases it when verification did not fail. */
  settle(key: string, failed: boolean, now = Date.now()) {
    const entry = this.windows.get(key);
    if (failed || !entry || entry.start !== now - (now % this.windowMs)) return;
    entry.failures = Math.max(0, entry.failures - 1);
  }
  private sweep(start: number) {
    for (const [key, entry] of this.windows) if (entry.start !== start) this.windows.delete(key);
    // Still full of current windows: forget the oldest sources first.
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }
}
