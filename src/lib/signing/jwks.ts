import type { AdcpJsonWebKey } from './types';

export interface JwksResolution {
  jwk: AdcpJsonWebKey | null;
  /** Canonical agent identity established by capability-bound discovery. */
  agentUrl?: string;
  /** Exact capability-selected operator document for signed-buyer governance. */
  operatorRecord?: { url: string; document: unknown };
  legacyWebhookFallback?: boolean;
  /** Epoch seconds for a delegated-operator authorization boundary, when applicable. */
  operatorAuthorizationValidUntil?: number;
}

export interface JwksResolver {
  /**
   * Optional signer-origin locator for resolvers serving multiple signers.
   * It is unverified request context, never proof of identity or authority.
   * Origin-aware caches must scope entries by (canonical origin, keyid).
   * Wrappers must forward it on both lookup methods. Existing one-argument
   * implementations remain valid; static and HTTPS resolvers stay pinned to
   * their configured key source and do not attribute identity from this value.
   */
  resolve(keyid: string, signerOrigin?: string): Promise<AdcpJsonWebKey | null>;
  /** Optional metadata-aware lookup used by verifiers that must enforce delegation expiry at acceptance time. */
  resolveWithMetadata?(keyid: string, signerOrigin?: string): Promise<JwksResolution>;
}

export class StaticJwksResolver implements JwksResolver {
  private readonly byKid = new Map<string, AdcpJsonWebKey>();

  constructor(keys: AdcpJsonWebKey[]) {
    for (const k of keys) this.byKid.set(k.kid, k);
  }

  async resolve(keyid: string, _signerOrigin?: string): Promise<AdcpJsonWebKey | null> {
    return this.byKid.get(keyid) ?? null;
  }
}
