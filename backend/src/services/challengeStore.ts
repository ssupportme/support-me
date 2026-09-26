export interface StoredChallenge {
  message: string;
  expiresAt: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * In-process store for wallet sign-in challenges, with a bounded size and a
 * periodic sweep so abandoned challenges (a wallet that requests `/challenge`
 * and never calls `/verify`) are evicted instead of accumulating forever.
 *
 * Single-instance assumption: this lives in process memory, so a challenge
 * issued by one instance cannot be verified by another. Running more than one
 * API instance behind a load balancer needs a shared store (Redis or the
 * database) with a TTL; until then keep sign-in traffic on one instance or use
 * sticky sessions for `/api/auth`. This mirrors the RateLimiter and TtlCache
 * notes elsewhere in the backend.
 */
export class ChallengeStore {
  private readonly entries = new Map<string, StoredChallenge>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
    private readonly sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS
  ) {}

  set(walletAddress: string, challenge: StoredChallenge): void {
    // Re-insert so a re-issued challenge moves to the "newest" end of the map.
    this.entries.delete(walletAddress);
    this.entries.set(walletAddress, challenge);

    if (this.entries.size > this.maxEntries) {
      this.sweep();
      // Still over the cap (a flood of unexpired challenges): drop the oldest.
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value as string;
        this.entries.delete(oldest);
      }
    }
  }

  get(walletAddress: string): StoredChallenge | undefined {
    return this.entries.get(walletAddress);
  }

  delete(walletAddress: string): void {
    this.entries.delete(walletAddress);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Removes every expired challenge. Returns how many were evicted. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key, challenge] of this.entries) {
      if (challenge.expiresAt <= now) {
        this.entries.delete(key);
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
