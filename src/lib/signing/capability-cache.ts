import { createHash } from 'node:crypto';
import type { VerifierCapability } from './types';

export interface CachedCapability {
  /** RFC 9421 request-signing capability block as advertised by the agent. */
  requestSigning: VerifierCapability | undefined;
  /** AdCP major version associated with the capability response, when known. */
  adcpVersion: number | undefined;
  /** Epoch seconds when this entry was written. */
  fetchedAt: number;
  /**
   * Optional explicit epoch-seconds deadline at which this entry becomes
   * stale. Overrides the cache's default TTL — used to give negative
   * (failed-discovery) entries a shorter refresh window than positive
   * entries so a transient seller outage doesn't block signing decisions
   * for the full 5-minute TTL.
   */
  staleAt?: number;
}

export interface CapabilityCacheOptions {
  /** Seconds before a cached capability is considered stale. Default 300. */
  ttlSeconds?: number;
  now?: () => number;
}

const DEFAULT_TTL_SECONDS = 300;

/**
 * Per-agent cache of the `request_signing` capability block returned by
 * `get_adcp_capabilities`. Keyed by a caller-supplied `cacheKey` (typically
 * `agent_uri + auth-token-hash`) so that different credentials or URLs get
 * independent entries.
 *
 * Staleness is TTL-based; callers may also invalidate explicitly — e.g. after
 * a seller rotates its advertisement mid-session — so the next outbound call
 * re-fetches before deciding whether to sign.
 */
export class CapabilityCache {
  private readonly entries = new Map<string, CachedCapability>();
  /**
   * In-flight priming fetches keyed by `cacheKey`. Lives on the instance so
   * two `CapabilityCache` objects — e.g., one per tenant in a multi-tenant
   * embedding — don't share an `ensureCapabilityLoaded` promise map across
   * instances and race each other's writes. The default process-global
   * cache uses its own map via `defaultCapabilityCache`.
   */
  private readonly inFlight = new Map<string, Promise<CachedCapability>>();
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(options: CapabilityCacheOptions = {}) {
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get(cacheKey: string): CachedCapability | undefined {
    return this.entries.get(cacheKey);
  }

  set(cacheKey: string, entry: CachedCapability): void {
    this.entries.set(cacheKey, entry);
  }

  invalidate(cacheKey: string): void {
    this.entries.delete(cacheKey);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  isStale(entry: CachedCapability | undefined): boolean {
    if (!entry) return true;
    const now = this.now();
    if (entry.staleAt !== undefined) return now >= entry.staleAt;
    return now - entry.fetchedAt > this.ttlSeconds;
  }

  /** @internal Pending-fetch table used by `ensureCapabilityLoaded`. */
  _getInFlight(cacheKey: string): Promise<CachedCapability> | undefined {
    return this.inFlight.get(cacheKey);
  }

  /** @internal */
  _setInFlight(cacheKey: string, promise: Promise<CachedCapability>): void {
    this.inFlight.set(cacheKey, promise);
  }

  /** @internal */
  _deleteInFlight(cacheKey: string): void {
    this.inFlight.delete(cacheKey);
  }
}

/**
 * Process-global capability cache. Shared by the ProtocolClient priming path
 * and the transport-level signing fetch wrappers so that a single
 * `get_adcp_capabilities` call serves every subsequent signing decision for
 * an agent.
 */
export const defaultCapabilityCache = new CapabilityCache();

/**
 * Build a stable cache key from an agent URI, an optional auth-token hash,
 * and an optional signer-key fingerprint. Two callers pointing at the same
 * agent URI under different signing identities get separate entries — a
 * seller can advertise different policies per counterparty key.
 *
 * Hash is a cache-key disambiguator, not a security boundary; a hypothetical
 * collision across users would still transmit only the original caller's
 * token (the cache key is not the auth credential itself).
 */
export function buildCapabilityCacheKey(agentUri: string, authToken?: string, signerFingerprint?: string): string {
  const tokenSuffix = authToken ? `::${createHash('sha256').update(authToken).digest('hex').slice(0, 16)}` : '';
  const signerSuffix = signerFingerprint ? `::sig=${signerFingerprint}` : '';
  return `${agentUri}${tokenSuffix}${signerSuffix}`;
}
