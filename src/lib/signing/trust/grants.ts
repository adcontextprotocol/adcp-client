/**
 * Experimental (AdCP 3.3) demand-side grant evaluation at `sync_accounts`
 * (spec R6, DR-0025).
 */
import { AdcpError } from '../../server/decisioning/async-outcome';
import { eTldPlusOne } from '../agent-resolver/etld';
import { RFC9421_REQUEST_SIGNING_PROFILE, WEB_BOT_AUTH_TAG, type RequestSigningProfile } from '../wba/constants';
import { parseRfc3339 } from '../wba/revocation';
import { tryWebBotAuthOrigin } from '../wba/origin';
import {
  TrustRecordAbsentError,
  TrustRecordError,
  type EvaluatedTrustRecord,
  type TrustRecordEvaluator,
} from './record';

/** `error.details` for an acts-for claim no grant covers. */
export const GRANT_ABSENT_DETAILS = Object.freeze({ scope: 'agent', reason: 'grant_absent' } as const);

/** Scoped claim passed to the seller and legacy authorization hooks. */
export interface GrantRequest {
  agentOrigin: string;
  brandDomain: string;
  accountOperator: string;
  scope: string;
  brandId?: string;
  countries: readonly string[];
}

export interface GrantAuthorization {
  authorized: boolean;
  /**
   * Diagnostic: `grant_absent`, `trust_record_absent`, `trust_record_unavailable`,
   * or `signer_trust_record_unavailable`. Log it; the wire carries only
   * `grant_absent` (see {@link requireGrant}).
   */
  reason?: string;
  /** The brand has never published trust.json, so brand.json may still apply. */
  legacyFallbackAllowed: boolean;
  /** Epoch seconds the authorization stays valid; re-check before spend after it. */
  expiresAt?: number;
}

/**
 * `PERMISSION_DENIED` with `{ scope: "agent", reason: "grant_absent" }`.
 * Emit it only once the signer's identity is established; an unestablished
 * caller gets the bare code under the cross-tenant oracle clamp.
 */
export function grantAbsentError(): AdcpError {
  return new AdcpError('PERMISSION_DENIED', {
    message: 'Agent has no authority for this brand',
    recovery: 'correctable',
    details: { ...GRANT_ABSENT_DETAILS },
  });
}

/** Throw {@link grantAbsentError} unless `result` authorizes. */
export function requireGrant(result: GrantAuthorization): void {
  if (!result.authorized) throw grantAbsentError();
}

export interface TrustGrantCheck {
  /** Verified signer origin (WBA), or the canonical agent URL of an RFC 9421 signer. */
  agentOrigin: string;
  brandDomain: string;
  /** `account.operator` from the account declaration. */
  accountOperator: string;
  /** Default `adcp:media_buying`. */
  scope?: string;
  brandId?: string;
  countries?: readonly string[];
  /** Trusted transport profile, never a request field. Default `web-bot-auth`. */
  signingProfile?: RequestSigningProfile;
}

export interface TrustGrantEvaluatorOptions {
  now?: () => number;
  /**
   * Seller discretion for a claim no grant covers when the brand's record
   * is not exhaustive (`exclusive_grants` absent or false for the scope):
   * the seller's own onboarding records, never brand.json.
   */
  sellerAuthorization?: (request: GrantRequest) => Promise<boolean>;
  /**
   * brand.json `authorized_operators` fallback. Runs only while the brand
   * has never published trust.json and its initial fetch returns 404/410;
   * fetch failures never reach it.
   */
  legacyAuthorization?: (request: GrantRequest) => Promise<boolean>;
}

/**
 * Experimental (AdCP 3.3). Evaluates acts-for authority from the brand's
 * trust record:
 *
 * - implicit when `account.operator`, the brand and the signer's operator
 *   share a registrable domain (the signer's record must still list it with
 *   `adcp:buying`);
 * - otherwise a grant from the brand to the signer's operator, when that is
 *   `account.operator`; or from the brand to `account.operator`, which grants
 *   the signer's operator in its own record. `account.operator` is always on
 *   the chain, and no third link is followed;
 * - every link must cover the scope, brand, countries, agent narrowing and
 *   validity window (intersection); `exclusive_grants` makes the record
 *   exhaustive for the scopes it names;
 * - a 200 from the brand's trust.json disables brand.json for that brand.
 */
export class TrustGrantEvaluator {
  readonly records: TrustRecordEvaluator;
  private readonly now: () => number;
  private readonly seller?: (request: GrantRequest) => Promise<boolean>;
  private readonly legacy?: (request: GrantRequest) => Promise<boolean>;

  constructor(records: TrustRecordEvaluator, options: TrustGrantEvaluatorOptions = {}) {
    this.records = records;
    this.now = options.now ?? records.now;
    this.seller = options.sellerAuthorization;
    this.legacy = options.legacyAuthorization;
  }

  async check(input: TrustGrantCheck): Promise<GrantAuthorization> {
    const deny = (reason: string, legacyFallbackAllowed = false): GrantAuthorization => ({
      authorized: false,
      reason,
      legacyFallbackAllowed,
    });
    const profile = input.signingProfile ?? WEB_BOT_AUTH_TAG;
    if (profile !== WEB_BOT_AUTH_TAG && profile !== RFC9421_REQUEST_SIGNING_PROFILE) {
      throw new TypeError('unsupported authenticated signing profile');
    }
    const origin = tryWebBotAuthOrigin(input.agentOrigin);
    const signerOperator = registrable(origin);
    const brandOperator = registrable(input.brandDomain);
    const operator = registrable(input.accountOperator);
    const scope = input.scope ?? 'adcp:media_buying';
    if (!origin || !signerOperator || !brandOperator || !operator) return deny('grant_absent');
    const request: GrantRequest = {
      agentOrigin: origin,
      brandDomain: input.brandDomain,
      accountOperator: input.accountOperator,
      scope,
      ...(input.brandId !== undefined && { brandId: input.brandId }),
      countries: [...(input.countries ?? [])],
    };

    let signerRecord: EvaluatedTrustRecord | undefined;
    const requireSigner = async (): Promise<EvaluatedTrustRecord | undefined> => {
      try {
        // Authority always requires a current operator role entry.
        return await this.records.evaluate(origin, { role: 'adcp:buying' });
      } catch {
        return undefined;
      }
    };
    if (profile === WEB_BOT_AUTH_TAG) {
      signerRecord = await requireSigner();
      if (!signerRecord) return deny('signer_trust_record_unavailable');
      if (signerOperator === brandOperator && brandOperator === operator) {
        return this.finish([signerRecord], []);
      }
    }
    let brandRecord: EvaluatedTrustRecord;
    try {
      brandRecord = await this.records.evaluate(input.brandDomain);
    } catch (error) {
      if (error instanceof TrustRecordAbsentError) {
        if (this.legacy) {
          return { authorized: (await this.legacy(request)) === true, legacyFallbackAllowed: true };
        }
        return deny('trust_record_absent', true);
      }
      return deny('trust_record_unavailable');
    }
    if (!signerRecord) {
      // RFC 9421 callers keep their onboarding path while the brand has no
      // trust record. Once it serves 200, grants have one source and require
      // the operator's role entry for the signer.
      signerRecord = await requireSigner();
      if (!signerRecord) return deny('signer_trust_record_unavailable');
      if (signerOperator === brandOperator && brandOperator === operator) {
        return this.finish([signerRecord, brandRecord], []);
      }
    }
    const match = { origin, scope, brandId: input.brandId, countries: new Set(input.countries ?? []) };
    const brandGrants = grantsOf(brandRecord);
    let first = brandGrants.filter(grant => grantMatches(grant, operator, match, this.now()));
    const used = [signerRecord, brandRecord];
    let links: GrantEntry[][] = [];
    if (operator === signerOperator) {
      links = [first];
    } else if (first.length > 0) {
      let intermediary: EvaluatedTrustRecord;
      try {
        intermediary = await this.records.evaluate(operator);
      } catch {
        return deny('trust_record_unavailable');
      }
      used.push(intermediary);
      // The intermediary fetch may outlive the first link: evaluate both at
      // decision time.
      const now = this.now();
      first = first.filter(grant => grantMatches(grant, operator, match, now));
      const second = grantsOf(intermediary).filter(grant => grantMatches(grant, signerOperator, match, now));
      links = [first, second];
    }
    if (used.some(record => record.expiresAt <= this.now())) return deny('trust_record_unavailable');
    if (links.length === 0 || links.some(link => link.length === 0)) {
      const exhaustive =
        brandRecord.document.exclusive_grants === true && brandGrants.some(grant => scopeCovers(grant.scopes, scope));
      if (!exhaustive && this.seller) {
        return { authorized: (await this.seller(request)) === true, legacyFallbackAllowed: false };
      }
      return deny('grant_absent');
    }
    return this.finish(used, links);
  }

  private finish(records: EvaluatedTrustRecord[], links: GrantEntry[][]): GrantAuthorization {
    // Each surviving grant on a link covers the same requested dimensions, so
    // the best path's expiry is the minimum of each link's best expiry. Never
    // materialize the cartesian product of untrusted grant arrays.
    const expiry = Math.min(
      ...records.map(record => record.expiresAt),
      ...links.map(link => Math.max(...link.map(grant => validUntil(grant))))
    );
    if (expiry <= this.now()) return { authorized: false, reason: 'grant_absent', legacyFallbackAllowed: false };
    return { authorized: true, legacyFallbackAllowed: false, expiresAt: expiry };
  }
}

interface GrantEntry {
  grantee: string;
  scopes: string[];
  agents?: Array<{ url: string }>;
  countries?: string[];
  valid_from?: string;
  valid_until?: string;
  profiles?: { adcp?: { brands?: string[] } };
}

function grantsOf(record: EvaluatedTrustRecord): GrantEntry[] {
  return Array.isArray(record.document.grants) ? (record.document.grants as GrantEntry[]) : [];
}

function scopeCovers(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope) || scopes.includes('*') || (scope.startsWith('adcp:') && scopes.includes('adcp:all'));
}

function grantMatches(
  grant: GrantEntry,
  grantee: string,
  match: { origin: string; scope: string; brandId: string | undefined; countries: Set<string> },
  nowSeconds: number
): boolean {
  if (grant.grantee !== grantee || !scopeCovers(grant.scopes, match.scope)) return false;
  if (grant.agents !== undefined && !grant.agents.some(agent => tryWebBotAuthOrigin(agent.url) === match.origin)) {
    return false;
  }
  if (grant.countries !== undefined) {
    if (match.countries.size === 0 || [...match.countries].some(country => !grant.countries!.includes(country))) {
      return false;
    }
  }
  const brands = grant.profiles?.adcp?.brands ?? ['*'];
  if (!brands.includes('*') && (match.brandId === undefined || !brands.includes(match.brandId))) return false;
  const now = nowSeconds * 1000;
  if (grant.valid_from !== undefined && now < (parseRfc3339(grant.valid_from) ?? Infinity)) return false;
  if (grant.valid_until !== undefined && now >= (parseRfc3339(grant.valid_until) ?? -Infinity)) return false;
  return true;
}

function validUntil(grant: GrantEntry): number {
  if (grant.valid_until === undefined) return Infinity;
  const ms = parseRfc3339(grant.valid_until);
  return ms === undefined ? -Infinity : Math.floor(ms / 1000);
}

function registrable(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return eTldPlusOne(value);
  } catch {
    return undefined;
  }
}
