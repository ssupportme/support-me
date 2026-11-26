export interface PendingTwitterState {
  codeVerifier: string;
  /** Hex SHA-256 of the browser-binding nonce set as a cookie when the flow starts. */
  bindingHash: string;
  expiresAt: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1_000;

/**
 * In-process store for in-flight Twitter/X OAuth states, keyed by the opaque
 * `state` param round-tripped through the redirect. Holds the PKCE verifier
 * server-side so it is never exposed to the browser or the OAuth provider.
 *
 * Every call to `GET /api/auth/twitter` adds an entry, so without a bound an
 * unauthenticated flood would grow this map without limit (#438). Same
 * bounded, self-sweeping pattern as `ChallengeStore`: abandoned states (a user
 * who starts sign-in and never comes back) are evicted on a timer, and a flood
 * of still-unexpired states is capped by dropping the oldest.
 *
 * Single-instance assumption: this lives in process memory, so a state issued
 * by one instance cannot be completed on another. Keep `/api/auth` on one
 * instance or use sticky sessions, mirroring the ChallengeStore, RateLimiter
 * and TtlCache notes elsewhere in the backend.
 */
export class TwitterStateStore {
  private readonly entries = new Map<string, PendingTwitterState>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS
  ) {}

  set(state: string, entry: PendingTwitterState): void {
    // Delete first so a re-set key moves to the end of the insertion order:
    // the eviction fallback below then drops the genuinely oldest state.
    this.entries.delete(state);
    this.entries.set(state, entry);

    if (this.entries.size > this.maxEntries) {
      this.sweep();
      // Still over the cap (a flood of unexpired states): drop the oldest.
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value as string;
        this.entries.delete(oldest);
      }
    }
  }

  /**
   * Reads and removes an entry. OAuth state is single-use, and an expired
   * entry is indistinguishable from one that was never issued, so both
   * return `undefined`.
   */
  consume(state: string, now = Date.now()): PendingTwitterState | undefined {
    const entry = this.entries.get(state);
    if (!entry) return undefined;
    this.entries.delete(state);
    return entry.expiresAt > now ? entry : undefined;
  }

  /**
   * Reads an entry without removing it, or `undefined` if it is missing or
   * expired. Lets a caller validate the entry (e.g. the browser binding)
   * before spending the single-use `consume`, so a wrong guess cannot burn
   * someone else's in-flight state.
   */
  peek(state: string, now = Date.now()): PendingTwitterState | undefined {
    const entry = this.entries.get(state);
    return entry && entry.expiresAt > now ? entry : undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Removes every expired state. Returns how many were evicted. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [state, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(state);
        removed++;
      }
    }
    return removed;
  }

  /** Starts the periodic sweep. The timer is unref'd so it never keeps the process alive. */
  startSweeping(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref();
  }

  stopSweeping(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  clear(): void {
    this.entries.clear();
  }
}
