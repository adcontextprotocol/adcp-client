import type { AdcpJsonWebKey } from '../types';
import type { JwksResolution, JwksResolver } from '../jwks';
import { AgentResolverError } from './errors';
import { resolveAgent, type AgentProtocol, type AgentResolution, type ResolveAgentOptions } from './resolve-agent';

export interface ResolvedAgentJwksResolverOptions extends Pick<
  ResolveAgentOptions,
  | 'fetchCapabilities'
  | 'agentType'
  | 'agentId'
  | 'expectedBrandJsonUrl'
  | 'legacyWebhookFallback'
  | 'lookup'
  | 'allowPrivateIp'
  | 'bodyCaps'
  | 'timeoutMs'
  | 'now'
  | 'requiredOperatorBrand'
  | 'requiredOperatorScope'
  | 'requiredOperatorCountry'
> {
  /** Positive cache lifetime in seconds. Defaults to 300. */
  cacheTtlSeconds?: number;
  /** Cooldown before an unknown kid can force another discovery. Defaults to 30. */
  unknownKidCooldownSeconds?: number;
  /** Test/custom discovery override. Defaults to {@link resolveAgent}. */
  resolve?: (agentUrl: string, options: ResolveAgentOptions) => Promise<AgentResolution>;
}

/** JWK resolver pinned to one exact seller URL and protocol. */
export class ResolvedAgentJwksResolver implements JwksResolver {
  private readonly now: () => number;
  private readonly cacheTtlSeconds: number;
  private readonly unknownKidCooldownSeconds: number;
  private readonly resolveAgentFn: (agentUrl: string, options: ResolveAgentOptions) => Promise<AgentResolution>;
  private canonicalAgentUrl?: string;
  private legacyWebhookFallback?: boolean;
  private operatorRecord?: JwksResolution['operatorRecord'];
  get resolvedAgentUrl(): string | undefined {
    return this.canonicalAgentUrl;
  }
  private keys = new Map<string, AdcpJsonWebKey>();
  private expiresAt = 0;
  private operatorAuthorizationValidUntil?: number;
  private lastUnknownKidRefresh = Number.NEGATIVE_INFINITY;
  private lastDiscoveryAttemptAt = Number.NEGATIVE_INFINITY;
  private inFlight?: Promise<void>;

  constructor(
    private readonly agentUrl: string,
    private readonly protocol: AgentProtocol,
    private readonly options: ResolvedAgentJwksResolverOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now() / 1000);
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? 300;
    this.unknownKidCooldownSeconds = options.unknownKidCooldownSeconds ?? 30;
    if (!Number.isFinite(this.cacheTtlSeconds) || this.cacheTtlSeconds <= 0) {
      throw new TypeError('cacheTtlSeconds must be a finite positive number.');
    }
    if (!Number.isFinite(this.unknownKidCooldownSeconds) || this.unknownKidCooldownSeconds < 0) {
      throw new TypeError('unknownKidCooldownSeconds must be a finite non-negative number.');
    }
    this.resolveAgentFn = options.resolve ?? resolveAgent;
  }

  async resolve(keyid: string): Promise<AdcpJsonWebKey | null> {
    return (await this.resolveWithMetadata(keyid)).jwk;
  }

  async resolveWithMetadata(keyid: string): Promise<JwksResolution> {
    const now = this.now();
    let refreshed = false;
    if (now >= this.expiresAt) {
      if (!this.inFlight && now - this.lastDiscoveryAttemptAt < 30) {
        const expiredAuthorization =
          this.operatorAuthorizationValidUntil !== undefined && now >= this.operatorAuthorizationValidUntil;
        throw new AgentResolverError(
          expiredAuthorization ? 'request_signature_brand_origin_mismatch' : 'request_signature_brand_json_unreachable',
          'Expired operator mapping cannot be used during the discovery cooldown',
          { agent_url: this.agentUrl },
          ['agent_url']
        );
      }
      await this.refresh();
      refreshed = true;
    }
    const cached = this.keys.get(keyid);
    if (cached) return this.resolution(cached);

    // A freshly fetched JWKS is already authoritative for this miss. The
    // global cooldown (not per attacker-controlled kid) bounds discovery work
    // when a stream of distinct bogus key ids arrives.
    if (refreshed) {
      this.lastUnknownKidRefresh = now;
      return this.resolution(null);
    }
    if (
      now - Math.max(this.lastUnknownKidRefresh, this.lastDiscoveryAttemptAt) <
      Math.max(30, this.unknownKidCooldownSeconds)
    )
      return this.resolution(null);
    await this.refresh();
    this.lastUnknownKidRefresh = now;
    return this.resolution(this.keys.get(keyid) ?? null);
  }

  async forceRefresh(): Promise<void> {
    this.expiresAt = 0;
    await this.refresh();
  }

  private resolution(jwk: AdcpJsonWebKey | null): JwksResolution {
    return {
      jwk,
      ...(this.operatorRecord !== undefined && { operatorRecord: this.operatorRecord }),
      ...(this.legacyWebhookFallback && { legacyWebhookFallback: true }),
      ...(this.resolvedAgentUrl !== undefined && { agentUrl: this.resolvedAgentUrl }),
      ...(this.operatorAuthorizationValidUntil !== undefined && {
        operatorAuthorizationValidUntil: this.operatorAuthorizationValidUntil,
      }),
    };
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastDiscoveryAttemptAt = this.now();
    this.inFlight = (async () => {
      const resolution = await this.resolveAgentFn(this.agentUrl, {
        ...this.options,
        protocol: this.protocol,
      });
      const refreshedAt = this.now();
      if (
        resolution.operatorAuthorizationValidUntil !== undefined &&
        refreshedAt >= resolution.operatorAuthorizationValidUntil
      ) {
        throw new AgentResolverError(
          'request_signature_brand_origin_mismatch',
          'The cross-origin operator delegation expired during key discovery.',
          { agent_url: this.agentUrl },
          ['agent_url']
        );
      }
      const next = new Map<string, AdcpJsonWebKey>();
      for (const candidate of resolution.jwks.keys) {
        if (candidate && typeof candidate === 'object' && typeof candidate.kid === 'string') {
          if (next.has(candidate.kid))
            throw new AgentResolverError(
              'request_signature_key_unknown',
              'JWKS has duplicate key identifiers',
              { agent_url: this.agentUrl },
              ['agent_url']
            );
          next.set(candidate.kid, candidate as unknown as AdcpJsonWebKey);
        }
      }
      this.keys = next;
      this.canonicalAgentUrl = resolution.agentUrl;
      this.operatorRecord =
        resolution.brandJson === undefined
          ? undefined
          : { url: resolution.brandJsonUrl, document: resolution.brandJson };
      this.legacyWebhookFallback = resolution.legacyWebhookFallback;
      this.operatorAuthorizationValidUntil = resolution.operatorAuthorizationValidUntil;
      this.expiresAt = Math.min(
        refreshedAt +
          Math.min(
            this.cacheTtlSeconds,
            1800,
            Math.max(30, cacheLifetime(resolution.brandJsonCacheControl)),
            Math.max(60, cacheLifetime(resolution.jwksCacheControl))
          ),
        resolution.operatorAuthorizationValidUntil ?? Number.POSITIVE_INFINITY
      );
    })().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}

/** Headers inform freshness; the caller applies the minimum safe polling interval. */
function cacheLifetime(cacheControl: string | undefined): number {
  if (!cacheControl) return Infinity;
  if (/\bno-cache\b|\bno-store\b/i.test(cacheControl)) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(cacheControl);
  return match ? Number(match[1]) : Infinity;
}
