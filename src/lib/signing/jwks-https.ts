import { ssrfSafeFetch } from '../net';
import type { AdcpJsonWebKey } from './types';
import type { JwksResolver } from './jwks';

export interface HttpsJwksResolverOptions {
  /**
   * Minimum seconds between refetches, regardless of cache-control or
   * key-unknown triggers. Guards counterparties from being hammered when a
   * mis-configured or rotating keyid drives repeated refresh attempts.
   * Default 30s (AdCP spec floor).
   */
  minCooldownSeconds?: number;
  /**
   * Absolute cap on how long a cached snapshot may be used before a refetch
   * is attempted, even if the counterparty's Cache-Control would allow
   * longer. Default 3600s (1 hour).
   */
  maxAgeSeconds?: number;
  /** Allow `http://` / private-IP JWKS URLs (dev loops only). Default false. */
  allowPrivateIp?: boolean;
  /** Clock override for deterministic tests. Returns epoch seconds. */
  now?: () => number;
}

interface CacheSnapshot {
  keys: Map<string, AdcpJsonWebKey>;
  etag?: string;
  fetchedAt: number;
  /** Epoch seconds at which the cache is considered expired (from Cache-Control max-age, capped by maxAgeSeconds). */
  expiresAt: number;
}

const DEFAULT_MIN_COOLDOWN_SECONDS = 30;
const DEFAULT_MAX_AGE_SECONDS = 3600;

/**
 * JWKS resolver that fetches and caches a JSON Web Key Set from an HTTPS URL.
 *
 * Behavior:
 *   - Lazy first-fetch on the first `resolve()` call.
 *   - Caches keyed by `kid`. A resolve() for an unknown kid triggers a
 *     lazy refetch (honoring the minimum cooldown), so a counterparty that
 *     rotates keys mid-session is picked up without a process restart.
 *   - Honors `ETag` (sends `If-None-Match` on refetch) and `Cache-Control:
 *     max-age=N` (uses whichever expires sooner: the server's max-age or
 *     `maxAgeSeconds`).
 *   - Keeps stale entries on transient fetch failures — verification goes
 *     down only when we have no snapshot at all.
 *   - Runs through the SSRF-safe fetch primitive: an attacker-supplied JWKS
 *     URL can't resolve to IMDS or the server's private network.
 *
 * Not a ReplayStore-style singleton: construct one per counterparty URL (or
 * keyed by `iss`) and pass into `verifyRequestSignature.jwks`.
 */
export class HttpsJwksResolver implements JwksResolver {
  private readonly url: string;
  private readonly minCooldown: number;
  private readonly maxAge: number;
  private readonly allowPrivateIp: boolean;
  private readonly now: () => number;
  private cache: CacheSnapshot | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(url: string, options: HttpsJwksResolverOptions = {}) {
    this.url = url;
    this.minCooldown = options.minCooldownSeconds ?? DEFAULT_MIN_COOLDOWN_SECONDS;
    this.maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    this.allowPrivateIp = options.allowPrivateIp ?? false;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async resolve(keyid: string): Promise<AdcpJsonWebKey | null> {
    if (!this.cache) {
      await this.refresh();
    } else if (this.cache.keys.has(keyid)) {
      // Fast path — known kid in a non-expired snapshot.
      if (this.now() <= this.cache.expiresAt) {
        return this.cache.keys.get(keyid) ?? null;
      }
      // Cache past its expiry; refresh if cooldown elapsed. When the cooldown
      // hasn't elapsed we deliberately serve the expired key: the `minCooldown`
      // protects the counterparty's JWKS endpoint from being hammered, and the
      // spec's 30-second floor is also the maximum staleness a verifier may
      // tolerate in this path.
      if (this.now() - this.cache.fetchedAt >= this.minCooldown) {
        await this.refresh().catch(() => {
          /* keep stale on transient failure */
        });
      }
    } else if (this.now() - this.cache.fetchedAt >= this.minCooldown) {
      // Unknown kid and cooldown elapsed — counterparty may have rotated.
      await this.refresh().catch(() => {
        /* keep stale on transient failure */
      });
    }
    return this.cache?.keys.get(keyid) ?? null;
  }

  /**
   * Force a refetch, bypassing the cooldown. Primarily for tests and for
   * operator-triggered rotation flushes; normal callers should rely on the
   * lazy key-unknown refresh path.
   */
  async forceRefresh(): Promise<void> {
    this.cache = undefined;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const headers: Record<string, string> = {
      accept: 'application/jwk-set+json, application/json',
    };
    if (this.cache?.etag) headers['if-none-match'] = this.cache.etag;

    // SSRF refusals and transport errors both propagate here; the caller path
    // in `resolve()` decides whether to swallow them (keep stale) or surface
    // them (first-fetch).
    const res = await ssrfSafeFetch(this.url, {
      method: 'GET',
      headers,
      allowPrivateIp: this.allowPrivateIp,
    });

    if (res.status === 304 && this.cache) {
      // Not modified — extend cache lifetime using the new response's
      // cache-control (or fall back to maxAgeSeconds). RFC 7232 permits the
      // origin to emit a new, stronger ETag on a 304; adopt it so our next
      // If-None-Match matches what the origin is currently willing to
      // validate against.
      this.cache = {
        ...this.cache,
        etag: res.headers['etag'] ?? this.cache.etag,
        fetchedAt: this.now(),
        expiresAt: this.computeExpiry(res.headers),
      };
      return;
    }

    if (res.status !== 200) {
      throw new Error(`JWKS fetch ${this.url} returned HTTP ${res.status}`);
    }

    const text = Buffer.from(res.body).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`JWKS fetch ${this.url} returned non-JSON body`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`JWKS fetch ${this.url} returned a non-object body`);
    }
    const keysField = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(keysField)) {
      throw new Error(`JWKS fetch ${this.url} response missing \`keys\` array`);
    }

    const byKid = new Map<string, AdcpJsonWebKey>();
    for (const entry of keysField) {
      if (entry && typeof entry === 'object' && typeof (entry as AdcpJsonWebKey).kid === 'string') {
        const jwk = entry as AdcpJsonWebKey;
        byKid.set(jwk.kid, jwk);
      }
    }

    this.cache = {
      keys: byKid,
      etag: res.headers['etag'],
      fetchedAt: this.now(),
      expiresAt: this.computeExpiry(res.headers),
    };
  }

  private computeExpiry(headers: Record<string, string>): number {
    const cacheCtl = headers['cache-control']?.toLowerCase() ?? '';
    // `no-store` / `no-cache` → treat as "expires immediately"; the next
    // resolve() will refresh past the cooldown, which is the spec-mandated
    // floor (30s) for not hammering the counterparty.
    if (/\bno-store\b|\bno-cache\b/.test(cacheCtl)) return this.now();
    const match = /max-age\s*=\s*(\d+)/.exec(cacheCtl);
    if (match) {
      const serverMax = Number(match[1]);
      if (Number.isFinite(serverMax)) return this.now() + Math.min(serverMax, this.maxAge);
    }
    return this.now() + this.maxAge;
  }
}
