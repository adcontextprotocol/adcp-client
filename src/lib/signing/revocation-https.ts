import { ssrfSafeFetch } from '../net';
import { RequestSignatureError } from './errors';
import type { RevocationStore } from './revocation';
import type { RevocationSnapshot } from './types';

export interface HttpsRevocationStoreOptions {
  /**
   * Grace period, in seconds, beyond `next_update` during which a cached
   * snapshot is still considered fresh enough to serve. After this grace the
   * store fails closed with `request_signature_revocation_stale` rather than
   * silently returning a possibly-wrong answer. Default 300s.
   */
  graceSeconds?: number;
  /**
   * Minimum seconds between refetch attempts — protects a counterparty
   * revocation endpoint from being hammered when `next_update` lies in the
   * past. Default 30s.
   */
  minRefetchIntervalSeconds?: number;
  /**
   * Reject any incoming snapshot whose `next_update` is more than this many
   * seconds after `updated` — a hostile or misconfigured origin could
   * otherwise return `next_update: "9999-12-31Z"` and disable the grace
   * check indefinitely. Default 7 days (604800s).
   *
   * NOTE: LARGER values LOOSEN the bound. The default 7 days is already
   * tight; only raise it if a specific counterparty publishes longer-lived
   * snapshots for an operationally justified reason. Lowering to hours or
   * minutes is a hardening move; raising to months is not.
   */
  maxValidityWindowSeconds?: number;
  /**
   * Expected issuer. When set, refuses any snapshot whose `issuer` field
   * doesn't match — protects against a mis-pointed revocation URL serving
   * a snapshot from a different authority. When unset, any `issuer` value
   * is accepted.
   */
  expectedIssuer?: string;
  /** Allow `http://` / private-IP revocation URLs (dev loops only). Default false. */
  allowPrivateIp?: boolean;
  /** Clock override for deterministic tests. Returns epoch seconds. */
  now?: () => number;
}

interface SnapshotState {
  revokedKids: Set<string>;
  revokedJtis: Set<string>;
  /** Parsed from `RevocationSnapshot.updated` (epoch seconds). */
  updated: number;
  /** Parsed from `RevocationSnapshot.next_update` (epoch seconds). */
  nextUpdate: number;
}

const DEFAULT_GRACE_SECONDS = 300;
const DEFAULT_MIN_REFETCH_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_VALIDITY_WINDOW_SECONDS = 7 * 24 * 3600;

/**
 * Revocation store that fetches and caches an AdCP revocation snapshot from
 * an HTTPS URL.
 *
 * Behavior:
 *   - Lazy first-fetch on the first `isRevoked()` call.
 *   - Once cached, subsequent `isRevoked()` calls read from memory. When
 *     `now` passes the snapshot's `next_update`, the next call triggers a
 *     refresh (throttled by `minRefetchIntervalSeconds`).
 *   - On refresh failure with an existing snapshot: keep the stale snapshot
 *     until `now > next_update + graceSeconds`, then fail closed with
 *     `request_signature_revocation_stale` — better to reject requests than
 *     silently serve a snapshot we know is past grace.
 *   - Runs through the SSRF-safe fetch primitive: an attacker-supplied
 *     revocation URL can't resolve into the host's private network.
 *
 * Callers that want aggressive background polling can call `refresh()` on
 * their own interval; the store's default pull-model avoids running a timer.
 */
export class HttpsRevocationStore implements RevocationStore {
  private readonly url: string;
  private readonly grace: number;
  private readonly minRefetchInterval: number;
  private readonly maxValidityWindow: number;
  private readonly expectedIssuer: string | undefined;
  private readonly allowPrivateIp: boolean;
  private readonly now: () => number;
  private snapshot: SnapshotState | undefined;
  private lastFetchAttempt = 0;
  private inFlight: Promise<void> | undefined;

  constructor(url: string, options: HttpsRevocationStoreOptions = {}) {
    this.url = url;
    this.grace = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
    this.minRefetchInterval = options.minRefetchIntervalSeconds ?? DEFAULT_MIN_REFETCH_INTERVAL_SECONDS;
    this.maxValidityWindow = options.maxValidityWindowSeconds ?? DEFAULT_MAX_VALIDITY_WINDOW_SECONDS;
    this.expectedIssuer = options.expectedIssuer;
    this.allowPrivateIp = options.allowPrivateIp ?? false;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async isRevoked(keyid: string): Promise<boolean> {
    const now = this.now();
    const shouldRefresh =
      !this.snapshot || (now > this.snapshot.nextUpdate && now - this.lastFetchAttempt >= this.minRefetchInterval);
    if (shouldRefresh) {
      try {
        await this.refresh();
      } catch (err) {
        if (!this.snapshot) throw err;
        // else keep stale snapshot and fall through to grace check
      }
    }

    if (!this.snapshot) {
      throw new RequestSignatureError(
        'request_signature_revocation_stale',
        9,
        `Revocation snapshot unavailable for ${this.url}`
      );
    }

    if (now > this.snapshot.nextUpdate + this.grace) {
      throw new RequestSignatureError(
        'request_signature_revocation_stale',
        9,
        `Revocation snapshot from ${this.url} is stale (next_update exceeded by more than ${this.grace}s grace)`
      );
    }

    return this.snapshot.revokedKids.has(keyid);
  }

  /**
   * Force a refetch. Safe to call during `isRevoked()` — concurrent calls
   * share the same in-flight promise.
   */
  async refresh(): Promise<void> {
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
    this.lastFetchAttempt = this.now();
    const res = await ssrfSafeFetch(this.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      allowPrivateIp: this.allowPrivateIp,
    });

    if (res.status !== 200) {
      throw new Error(`Revocation list fetch ${this.url} returned HTTP ${res.status}`);
    }

    const text = Buffer.from(res.body).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Revocation list fetch ${this.url} returned non-JSON body`);
    }
    const snapshot = parsed as Partial<RevocationSnapshot>;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      !Array.isArray(snapshot.revoked_kids) ||
      !Array.isArray(snapshot.revoked_jtis) ||
      typeof snapshot.next_update !== 'string' ||
      typeof snapshot.updated !== 'string' ||
      typeof snapshot.issuer !== 'string'
    ) {
      throw new Error(`Revocation list fetch ${this.url} is not a valid RevocationSnapshot`);
    }

    if (this.expectedIssuer !== undefined && snapshot.issuer !== this.expectedIssuer) {
      throw new Error(
        `Revocation list fetch ${this.url} returned issuer "${snapshot.issuer}"; expected "${this.expectedIssuer}"`
      );
    }

    const updated = parseIsoSeconds(snapshot.updated);
    const nextUpdate = parseIsoSeconds(snapshot.next_update);
    if (updated === null || nextUpdate === null) {
      throw new Error(`Revocation list fetch ${this.url} has invalid updated/next_update timestamps`);
    }
    if (nextUpdate <= updated) {
      throw new Error(
        `Revocation list fetch ${this.url} returned next_update <= updated; refusing a snapshot that pre-dates itself`
      );
    }
    if (nextUpdate - updated > this.maxValidityWindow) {
      throw new Error(
        `Revocation list fetch ${this.url} returned a ${nextUpdate - updated}s validity window; max ${this.maxValidityWindow}s`
      );
    }

    // Filter non-string entries in both `revoked_kids` and `revoked_jtis`.
    // `revoked_jtis` isn't consumed today, but validating here keeps the
    // SnapshotState shape honest for future callers and stops a hostile
    // snapshot from smuggling non-string values into downstream code.
    this.snapshot = {
      revokedKids: new Set(snapshot.revoked_kids.filter((k): k is string => typeof k === 'string')),
      revokedJtis: new Set(snapshot.revoked_jtis.filter((k): k is string => typeof k === 'string')),
      updated,
      nextUpdate,
    };
  }
}

function parseIsoSeconds(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}
