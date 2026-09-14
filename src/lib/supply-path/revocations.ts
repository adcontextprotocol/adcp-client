import { domain, record } from './validation';

export interface SupplyPathRevocation {
  publisher_domain: string;
  revoked_at: string;
}
/**
 * Atomic, authority-scoped seven-day revocation hold. Durable implementations
 * must preserve the first observation of each (publisher_domain, revoked_at)
 * tuple, and reject on storage failure instead of returning an empty set.
 */
export interface SupplyPathRevocationStore {
  observe(authority: string, revoked: readonly SupplyPathRevocation[]): Promise<readonly SupplyPathRevocation[]>;
}

/** Process-local default. Use a durable shared store across workers/restarts. */
export class InMemorySupplyPathRevocationStore implements SupplyPathRevocationStore {
  private readonly entries = new Map<string, { authority: string; entry: SupplyPathRevocation; expires: number }>();
  async observe(authority: string, revoked: readonly SupplyPathRevocation[]): Promise<readonly SupplyPathRevocation[]> {
    const now = Date.now();
    for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key);
    for (const entry of revoked) {
      const key = JSON.stringify([authority, entry.publisher_domain, entry.revoked_at]);
      if (this.entries.has(key)) continue;
      // Never evict a live revocation to accommodate counterparty-controlled data.
      if (this.entries.size >= 10000) throw new Error('Supply-path revocation store capacity exceeded');
      this.entries.set(key, { authority, entry: { ...entry }, expires: now + 7 * 86400000 });
    }
    return [...this.entries.values()].filter(value => value.authority === authority).map(value => ({ ...value.entry }));
  }
}
export const defaultSupplyPathRevocations = new InMemorySupplyPathRevocationStore();

export function parseRevocations(value: unknown): SupplyPathRevocation[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1024) return null;
  const entries: SupplyPathRevocation[] = [];
  for (const raw of value) {
    const publisher = domain(record(raw) ? raw.publisher_domain : raw);
    if (!publisher) return null;
    const timestamp = record(raw) ? raw.revoked_at : undefined;
    if (timestamp !== undefined && (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))))
      return null;
    // Legacy domain-only revocations still hold from observation, never from a
    // publisher-controlled timestamp. The marker is stable across refreshes.
    entries.push({
      publisher_domain: publisher,
      revoked_at: typeof timestamp === 'string' ? timestamp : 'unspecified',
    });
  }
  return entries;
}
