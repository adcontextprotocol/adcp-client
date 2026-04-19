import type { RevocationSnapshot } from './types';

export interface RevocationStore {
  isRevoked(keyid: string): Promise<boolean>;
}

export class InMemoryRevocationStore implements RevocationStore {
  private revokedKids = new Set<string>();

  constructor(snapshot?: RevocationSnapshot) {
    if (snapshot) this.load(snapshot);
  }

  load(snapshot: RevocationSnapshot): void {
    this.revokedKids = new Set(snapshot.revoked_kids);
  }

  async isRevoked(keyid: string): Promise<boolean> {
    return this.revokedKids.has(keyid);
  }
}
