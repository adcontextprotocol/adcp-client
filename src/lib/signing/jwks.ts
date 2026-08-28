import type { AdcpJsonWebKey } from './types';

export interface JwksResolution {
  jwk: AdcpJsonWebKey | null;
  /** Epoch seconds for a delegated-operator authorization boundary, when applicable. */
  operatorAuthorizationValidUntil?: number;
}

export interface JwksResolver {
  resolve(keyid: string): Promise<AdcpJsonWebKey | null>;
  /** Optional metadata-aware lookup used by verifiers that must enforce delegation expiry at acceptance time. */
  resolveWithMetadata?(keyid: string): Promise<JwksResolution>;
}

export class StaticJwksResolver implements JwksResolver {
  private readonly byKid = new Map<string, AdcpJsonWebKey>();

  constructor(keys: AdcpJsonWebKey[]) {
    for (const k of keys) this.byKid.set(k.kid, k);
  }

  async resolve(keyid: string): Promise<AdcpJsonWebKey | null> {
    return this.byKid.get(keyid) ?? null;
  }
}
