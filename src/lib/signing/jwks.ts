import type { AdcpJsonWebKey } from './types';

export interface JwksResolver {
  resolve(keyid: string): Promise<AdcpJsonWebKey | null>;
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
