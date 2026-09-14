import { domain, record } from './validation';

/** Admission limits protect process-local defaults; existing evidence is never evicted to admit another authority. */
class AuthorityAdmissionBudget {
  private windowStart = Date.now();
  private admitted = 0;
  consume(): void {
    const now = Date.now();
    if (now >= this.windowStart + 60_000) {
      this.windowStart = now;
      this.admitted = 0;
    }
    if (this.admitted >= 128) throw new Error('Supply-path new-authority admission rate exceeded');
    this.admitted++;
  }
}

export interface SupplyPathRevocation {
  publisher_domain: string;
  revoked_at: string;
}
/**
 * Atomic, authority-scoped seven-day revocation hold. Durable implementations
 * must key by authority and publisher_domain, preserving first observation
 * across changed publisher timestamps, and reject on storage failure instead of returning an empty set.
 * Capture tenant identity from trusted application context in the store instance;
 * include that tenant in every key and transaction. Publisher evidence must never select a tenant.
 */
export interface SupplyPathRevocationStore {
  observe(authority: string, revoked: readonly SupplyPathRevocation[]): Promise<readonly SupplyPathRevocation[]>;
}

/** Process-local default. Use a durable shared store across workers/restarts. */
export class InMemorySupplyPathRevocationStore implements SupplyPathRevocationStore {
  private readonly admission = new AuthorityAdmissionBudget();
  private readonly entries = new Map<string, { authority: string; entry: SupplyPathRevocation; expires: number }>();
  async observe(authority: string, revoked: readonly SupplyPathRevocation[]): Promise<readonly SupplyPathRevocation[]> {
    const now = Date.now();
    for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key);
    const scoped = new Set(
      [...this.entries.values()]
        .filter(value => value.authority === authority)
        .map(value => value.entry.publisher_domain)
    );
    const existingAuthority = scoped.size > 0;
    for (const entry of revoked) scoped.add(entry.publisher_domain);
    if (scoped.size > 1024) throw new Error('Supply-path publisher authority revocation capacity exceeded');
    const newEntries = revoked.filter(entry => !this.entries.has(JSON.stringify([authority, entry.publisher_domain])));
    const newCount = new Set(newEntries.map(entry => entry.publisher_domain)).size;
    if (this.entries.size + newCount > 10000) throw new Error('Supply-path revocation store capacity exceeded');
    if (!existingAuthority && scoped.size > 0) this.admission.consume();
    for (const entry of revoked) {
      const key = JSON.stringify([authority, entry.publisher_domain]);
      const prior = this.entries.get(key);
      if (prior) {
        if (Date.parse(entry.revoked_at) < Date.parse(prior.entry.revoked_at))
          prior.entry.revoked_at = entry.revoked_at;
        continue;
      }
      // Never evict a live revocation to accommodate counterparty-controlled data.
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

/**
 * Trust-on-first-successful-use storage. Capture the authenticated tenant in the
 * store instance and namespace every pin by that tenant. Neither a read nor a
 * failed fetch may create a pin. Storage failures must reject.
 */
export interface SupplyPathAuthorityStore {
  /** Read-only precheck: true if absent or equal; false for a different existing pin. */
  check(publisherDomain: string, location: string): Promise<boolean>;
  /**
   * After successful manifest validation, atomically insert if absent or compare
   * with the existing pin. Return false on mismatch, including a concurrent change
   * since check(). A successful precheck is never a reservation or authorization.
   */
  observe(publisherDomain: string, location: string): Promise<boolean>;
}

/** Process-local pointer integrity. Use durable shared storage across workers/restarts. */
export class InMemorySupplyPathAuthorityStore implements SupplyPathAuthorityStore {
  private readonly admission = new AuthorityAdmissionBudget();
  private readonly locations = new Map<string, string>();
  async check(publisherDomain: string, location: string): Promise<boolean> {
    const pinned = this.locations.get(publisherDomain);
    return pinned === undefined || pinned === location;
  }
  async observe(publisherDomain: string, location: string): Promise<boolean> {
    const pinned = this.locations.get(publisherDomain);
    if (pinned !== undefined) return pinned === location;
    if (this.locations.size >= 10000) throw new Error('Supply-path authority store capacity exceeded');
    this.admission.consume();
    this.locations.set(publisherDomain, location);
    return true;
  }
  /** Call only after independently confirming a publisher's migration. Never call from an automatic retry. */
  approveChange(publisherDomain: string, location: string): void {
    if (!this.locations.has(publisherDomain) && this.locations.size >= 10000)
      throw new Error('Supply-path authority store capacity exceeded');
    if (!this.locations.has(publisherDomain)) this.admission.consume();
    this.locations.set(publisherDomain, location);
  }
}
export const defaultSupplyPathAuthorities = new InMemorySupplyPathAuthorityStore();
