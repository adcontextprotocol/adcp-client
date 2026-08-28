import type { AdcpJsonWebKey } from '../types';
import type { JwksResolution, JwksResolver } from '../jwks';
import { AgentResolverError } from './errors';
import { resolveAgent, type AgentProtocol, type AgentResolution, type ResolveAgentOptions } from './resolve-agent';

export interface ResolvedAgentJwksResolverOptions extends Pick<
  ResolveAgentOptions,
  | 'fetchCapabilities'
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
  private keys = new Map<string, AdcpJsonWebKey>();
  private expiresAt = 0;
  private operatorAuthorizationValidUntil?: number;
  private lastUnknownKidRefresh = Number.NEGATIVE_INFINITY;
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
    if (now - this.lastUnknownKidRefresh < this.unknownKidCooldownSeconds) return this.resolution(null);
    await this.refresh();
    this.lastUnknownKidRefresh = now;
    return this.resolution(this.keys.get(keyid) ?? null);
  }

  private resolution(jwk: AdcpJsonWebKey | null): JwksResolution {
    return {
      jwk,
      ...(this.operatorAuthorizationValidUntil !== undefined && {
        operatorAuthorizationValidUntil: this.operatorAuthorizationValidUntil,
      }),
    };
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const resolution = await this.resolveAgentFn(this.agentUrl, {
        protocol: this.protocol,
        ...(this.options.fetchCapabilities && { fetchCapabilities: this.options.fetchCapabilities }),
        ...(this.options.allowPrivateIp !== undefined && { allowPrivateIp: this.options.allowPrivateIp }),
        ...(this.options.bodyCaps && { bodyCaps: this.options.bodyCaps }),
        ...(this.options.timeoutMs !== undefined && { timeoutMs: this.options.timeoutMs }),
        ...(this.options.now && { now: this.options.now }),
        ...(this.options.requiredOperatorBrand !== undefined && {
          requiredOperatorBrand: this.options.requiredOperatorBrand,
        }),
        ...(this.options.requiredOperatorScope !== undefined && {
          requiredOperatorScope: this.options.requiredOperatorScope,
        }),
        ...(this.options.requiredOperatorCountry !== undefined && {
          requiredOperatorCountry: this.options.requiredOperatorCountry,
        }),
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
          next.set(candidate.kid, candidate as unknown as AdcpJsonWebKey);
        }
      }
      this.keys = next;
      this.operatorAuthorizationValidUntil = resolution.operatorAuthorizationValidUntil;
      this.expiresAt = Math.min(
        refreshedAt + this.cacheTtlSeconds,
        resolution.operatorAuthorizationValidUntil ?? Number.POSITIVE_INFINITY
      );
    })().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}
