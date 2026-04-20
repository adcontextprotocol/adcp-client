export type ReplayInsertResult = 'ok' | 'replayed' | 'rate_abuse';

/**
 * Replay cache of verified `(keyid, scope, nonce)` tuples, keyed by the
 * canonical `@target-uri` (per adcp#2460). Scoping by endpoint prevents a
 * signature captured on one path (e.g. `/create_media_buy`) from being
 * replayed against another (e.g. `/update_media_buy`) under the same keyid
 * — RFC 9421 §7.2.2 treats `@target-uri` as the endpoint identity, and the
 * signer binds it into the signature base, so the replay cache must scope
 * by the same dimension the signature commits to.
 *
 * Custom implementations MUST partition their storage by `(keyid, scope)`
 * — treating `scope` as part of the primary key — not just by `keyid`.
 */
export interface ReplayStore {
  has(keyid: string, scope: string, nonce: string, now: number): Promise<boolean>;
  isCapHit(keyid: string, scope: string, now: number): Promise<boolean>;
  insert(keyid: string, scope: string, nonce: string, ttlSeconds: number, now: number): Promise<ReplayInsertResult>;
}

export interface InMemoryReplayStoreOptions {
  /**
   * Maximum retained (unexpired) nonces per `(keyid, scope)` before `insert`
   * returns `rate_abuse`. Defaults to 100,000 — enough headroom for real
   * traffic without turning the verifier into a DoS amplifier when a hot
   * `(keyid, scope)` pair sits near the cap. See issue #582.
   */
  maxEntriesPerKeyid?: number;
  /**
   * Prune granularity in seconds. Entries are grouped by
   * `floor(expiresAt / bucketSizeSeconds)`; whole buckets are evicted in one
   * step when their latest expiry has passed. Keeps amortized has/insert/
   * isCapHit at O(1) per `(keyid, scope)` pair regardless of entries-per-pair.
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

/** Join `(keyid, scope)` into the in-memory map key. NUL is never legal in
 * either a JWK kid (RFC 7517) or a URL — using it as a separator makes the
 * join unambiguous without escaping. */
function compositeKey(keyid: string, scope: string): string {
  return `${keyid}\x00${scope}`;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly state = new Map<string, KeyState>();
  private readonly capPerKeyid: number;
  private readonly bucketSize: number;
  /**
   * Forced-cap test hook. Keyed by `compositeKey(keyid, scope)` when a scope
   * is supplied, or just `keyid` when the caller wants every scope under a
   * keyid to report capped. `isCapHit` checks both forms so tests that pre-
   * arm a cap without knowing the exact scope still work.
   */
  private readonly forcedCapHit = new Set<string>();

  constructor(options: InMemoryReplayStoreOptions = {}) {
    this.capPerKeyid = options.maxEntriesPerKeyid ?? 100_000;
    this.bucketSize = options.bucketSizeSeconds ?? 60;
  }

  /**
   * Force `isCapHit` to return true for the given keyid (across every scope)
   * or the specific `(keyid, scope)` pair when `scope` is supplied. Used by
   * conformance vectors to pre-arm the rate-abuse path without actually
   * flooding the cache.
   */
  setCapHitForTesting(keyid: string, scope?: string): void {
    this.forcedCapHit.add(scope === undefined ? keyid : compositeKey(keyid, scope));
  }

  async has(keyid: string, scope: string, nonce: string, now: number): Promise<boolean> {
    const state = this.state.get(compositeKey(keyid, scope));
    if (!state) return false;
    this.prune(state, now);
    return state.nonces.has(nonce);
  }

  async isCapHit(keyid: string, scope: string, now: number): Promise<boolean> {
    if (this.forcedCapHit.has(keyid)) return true;
    if (this.forcedCapHit.has(compositeKey(keyid, scope))) return true;
    const state = this.state.get(compositeKey(keyid, scope));
    if (!state) return false;
    this.prune(state, now);
    return state.nonces.size >= this.capPerKeyid;
  }

  async insert(
    keyid: string,
    scope: string,
    nonce: string,
    ttlSeconds: number,
    now: number
  ): Promise<ReplayInsertResult> {
    const composite = compositeKey(keyid, scope);
    const state = this.getOrCreate(composite);
    this.prune(state, now);
    if (state.nonces.has(nonce)) return 'replayed';
    if (this.forcedCapHit.has(keyid) || this.forcedCapHit.has(composite) || state.nonces.size >= this.capPerKeyid) {
      return 'rate_abuse';
    }
    this.insertEntry(state, nonce, now + ttlSeconds);
    return 'ok';
  }

  preload(keyid: string, scope: string, nonce: string, ttlSeconds: number, now: number): void {
    this.insertEntry(this.getOrCreate(compositeKey(keyid, scope)), nonce, now + ttlSeconds);
  }

  private getOrCreate(composite: string): KeyState {
    let state = this.state.get(composite);
    if (!state) {
      state = { nonces: new Set(), buckets: new Map(), lastPrunedBucket: Number.NEGATIVE_INFINITY };
      this.state.set(composite, state);
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
    // Amortize: run at most once per bucket tick per `(keyid, scope)` pair.
    // Whole buckets are evicted — never iterate per-entry — so pruning cost
    // is O(#expired buckets), independent of entries-per-pair.
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
