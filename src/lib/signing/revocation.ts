import type { RevocationDetail } from '../identity-3.3/types';
import type { RevocationSnapshot } from './types';

export interface RevocationStore {
  isRevoked(keyid: string): Promise<boolean>;
}

export class InMemoryRevocationStore implements RevocationStore {
  private readonly revokedKids = new Set<string>();
  private readonly details = new Map<string, RevocationDetail>();

  constructor(snapshot?: RevocationSnapshot) {
    if (snapshot) this.load(snapshot);
  }

  load(snapshot: RevocationSnapshot): void {
    if (new Set([...this.revokedKids, ...snapshot.revoked_kids]).size > 100000)
      throw new RangeError('Revocation store capacity exceeded');
    for (const kid of snapshot.revoked_kids) {
      this.revokedKids.add(kid);
      const detail = snapshot.revocation_details?.[kid];
      this.details.set(kid, mergeRevocationDetails(this.details.get(kid), (detail as RevocationDetail) ?? {}));
    }
  }

  getDetails(keyid: string): RevocationDetail | undefined {
    const detail = this.details.get(keyid);
    return detail && { ...detail };
  }

  async isRevoked(keyid: string): Promise<boolean> {
    return this.revokedKids.has(keyid);
  }
}

const REASONS = [
  'removeFromCRL',
  'unspecified',
  'superseded',
  'cessationOfOperation',
  'affiliationChanged',
  'certificateHold',
  'privilegeWithdrawn',
  'aACompromise',
  'cACompromise',
  'keyCompromise',
];
/**
 * @internal Permanent facts retain the most severe reason and earliest valid
 * date. A `keyCompromise` entry without an `invalidity_date` exposes every
 * receipt, so no later dated entry can narrow it.
 */
export function mergeRevocationDetails(
  prior: RevocationDetail | undefined,
  detail: RevocationDetail
): RevocationDetail {
  const reason =
    REASONS.indexOf(detail.reason ?? 'unspecified') > REASONS.indexOf(prior?.reason ?? 'unspecified')
      ? detail.reason
      : (prior?.reason ?? detail.reason);
  const hasValidDate = (entry: RevocationDetail | undefined) =>
    !!entry?.invalidity_date && Number.isFinite(Date.parse(entry.invalidity_date));
  if (
    reason === 'keyCompromise' &&
    [prior, detail].some(entry => entry?.reason === 'keyCompromise' && !hasValidDate(entry))
  )
    return { reason };
  const dates = [prior?.invalidity_date, detail.invalidity_date]
    .filter((s): s is string => !!s && Number.isFinite(Date.parse(s)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { ...(reason ? { reason } : {}), ...(dates[0] ? { invalidity_date: dates[0] } : {}) };
}
