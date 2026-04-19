export type ReplayInsertResult = 'ok' | 'replayed' | 'rate_abuse';

export interface ReplayStore {
  has(keyid: string, nonce: string, now: number): Promise<boolean>;
  isCapHit(keyid: string, now: number): Promise<boolean>;
  insert(keyid: string, nonce: string, ttlSeconds: number, now: number): Promise<ReplayInsertResult>;
}

export interface InMemoryReplayStoreOptions {
  /**
   * Maximum retained (unexpired) nonces per keyid before `insert` returns
   * `rate_abuse`. Defaults to 100,000 — enough headroom for real traffic
   * without turning the verifier into a DoS amplifier when a hot keyid sits
   * near the cap. See issue #582.
   */
  maxEntriesPerKeyid?: number;
  /**
   * Prune granularity in seconds. Entries are grouped by
   * `floor(expiresAt / bucketSizeSeconds)`; whole buckets are evicted in one
   * step when their latest expiry has passed. Keeps amortized has/insert/
   * isCapHit at O(1) per keyid regardless of entries-per-keyid.
   */
  bucketSizeSeconds?: number;
}

interface Bucket {
  nonces: Set<string>;
  latestExpiry: number;
}

interface KeyState {
  nonces: Set<string>;
  buckets: Map<number, Bucket>;
  lastPrunedBucket: number;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly state = new Map<string, KeyState>();
  private readonly capPerKeyid: number;
  private readonly bucketSize: number;
  private readonly forcedCapHit = new Set<string>();

  constructor(options: InMemoryReplayStoreOptions = {}) {
    this.capPerKeyid = options.maxEntriesPerKeyid ?? 100_000;
    this.bucketSize = options.bucketSizeSeconds ?? 60;
  }

  setCapHitForTesting(keyid: string): void {
    this.forcedCapHit.add(keyid);
  }

  async has(keyid: string, nonce: string, now: number): Promise<boolean> {
    const state = this.state.get(keyid);
    if (!state) return false;
    this.prune(state, now);
    return state.nonces.has(nonce);
  }

  async isCapHit(keyid: string, now: number): Promise<boolean> {
    if (this.forcedCapHit.has(keyid)) return true;
    const state = this.state.get(keyid);
    if (!state) return false;
    this.prune(state, now);
    return state.nonces.size >= this.capPerKeyid;
  }

  async insert(keyid: string, nonce: string, ttlSeconds: number, now: number): Promise<ReplayInsertResult> {
    const state = this.getOrCreate(keyid);
    this.prune(state, now);
    if (state.nonces.has(nonce)) return 'replayed';
    if (this.forcedCapHit.has(keyid) || state.nonces.size >= this.capPerKeyid) return 'rate_abuse';
    this.insertEntry(state, nonce, now + ttlSeconds);
    return 'ok';
  }

  preload(keyid: string, nonce: string, ttlSeconds: number, now: number): void {
    this.insertEntry(this.getOrCreate(keyid), nonce, now + ttlSeconds);
  }

  private getOrCreate(keyid: string): KeyState {
    let state = this.state.get(keyid);
    if (!state) {
      state = { nonces: new Set(), buckets: new Map(), lastPrunedBucket: Number.NEGATIVE_INFINITY };
      this.state.set(keyid, state);
    }
    return state;
  }

  private insertEntry(state: KeyState, nonce: string, expiresAt: number): void {
    const bk = Math.floor(expiresAt / this.bucketSize);
    let bucket = state.buckets.get(bk);
    if (!bucket) {
      bucket = { nonces: new Set(), latestExpiry: expiresAt };
      state.buckets.set(bk, bucket);
    } else if (expiresAt > bucket.latestExpiry) {
      bucket.latestExpiry = expiresAt;
    }
    bucket.nonces.add(nonce);
    state.nonces.add(nonce);
  }

  private prune(state: KeyState, now: number): void {
    // Amortize: run at most once per bucket tick per keyid. Whole buckets are
    // evicted — never iterate per-entry — so pruning cost is O(#expired
    // buckets), independent of entries-per-keyid.
    const currentBucket = Math.floor(now / this.bucketSize);
    if (currentBucket === state.lastPrunedBucket) return;
    state.lastPrunedBucket = currentBucket;
    for (const [bk, bucket] of state.buckets) {
      if (bucket.latestExpiry <= now) {
        for (const nonce of bucket.nonces) state.nonces.delete(nonce);
        state.buckets.delete(bk);
      }
    }
  }
}
