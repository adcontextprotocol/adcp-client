import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ssrfSafeFetch, type SsrfFetchOptions } from '../net';
import { canonicalAgentOrigin } from '../signing/agent-resolver/canonicalize';
import { eTldPlusOne } from '../signing/agent-resolver/etld';
import { parseStrictJson } from '../signing/agent-resolver/strict-json';
import { parse as parseDomain } from 'tldts';
import schemas from './schemas.draft';
import type { TrustRecord, TrustAgent, TrustGrant, AgentGrantDeniedDetails } from './types';
const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);
export function validateIdentity33Schema(id: string, value: unknown): boolean {
  return ajv.getSchema(`/schemas/${id}.json`)?.(value) === true;
}
export class IdentityAuthorizationError extends Error {
  readonly code = 'PERMISSION_DENIED';
  readonly details: AgentGrantDeniedDetails | undefined;
  constructor(reason: 'authorization_failed' | 'grant_absent' = 'authorization_failed') {
    super(reason === 'grant_absent' ? 'Agent authority is not granted' : 'Agent authorization failed');
    this.name = 'IdentityAuthorizationError';
    this.details = reason === 'grant_absent' ? { scope: 'agent', reason } : undefined;
  }
}
/**
 * The trust record could not be read (transport error, outage, capacity,
 * invalid content). A fetch failure is never absence or delisting: spend
 * fails closed with a retryable SERVICE_UNAVAILABLE, other calls continue
 * under an existing binding.
 */
export class TrustRecordUnavailableError extends IdentityAuthorizationError {
  readonly transient = true as const;
  /**
   * Set by `match()`: the last record read for this operator listed the origin
   * with the role and is still within the seller's outage bound
   * (`maxOutageContinuationSeconds` past its freshness). Only then may non-spend
   * calls continue under a binding.
   */
  lastKnownListed = false;
  constructor() {
    super();
    this.name = 'TrustRecordUnavailableError';
    this.message = 'Agent trust record is temporarily unavailable';
  }
}
/**
 * The operator's last record read does not list the origin with the required
 * role (`unlisted`; operators retire agents by publishing an empty `agents[]`),
 * or the operator has never published one (`absent`).
 */
export class TrustMembershipError extends IdentityAuthorizationError {
  constructor(readonly membership: 'unlisted' | 'absent' = 'unlisted') {
    super();
    this.name = 'TrustMembershipError';
  }
}
function unavailable(cause?: unknown): never {
  const error = new TrustRecordUnavailableError();
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  throw error;
}
/** Per-host rate exceeded: shared capacity, never cached as an operator failure. */
class TrustHostCapacityError extends Error {}
/** Hops to hosts outside the operator's registrable domain share one per-host budget. */
const FOREIGN_HOST_BUDGET = '\u0000foreign';
const OWN_HOST_REQUESTS_PER_MINUTE = 10;
const FOREIGN_HOST_REQUESTS_PER_MINUTE = 30;
function failure(cause?: unknown): never {
  const error = new IdentityAuthorizationError();
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  throw error;
}
/** Schema plus semantic checks; publication never includes identity keys. */
export function validateTrustRecord(value: unknown): asserts value is TrustRecord {
  if (!validateIdentity33Schema('trust/v1/trust', value)) failure();
  const record = value as TrustRecord;
  const origins = new Set<string>();
  for (const agent of record.agents ?? []) {
    if (agent.jwks_uri !== undefined) failure();
    const origin = canonicalAgentOrigin(agent.url);
    if (origins.has(origin)) failure();
    origins.add(origin);
  }
}
/**
 * The grantee when it is itself a registrable domain under the pinned PSL
 * snapshot (ICANN and PRIVATE sections), otherwise undefined. A host below a
 * registrable domain (`t1.vendor.example`) is not one, and neither is a public
 * suffix (`github.io`); `alice.github.io` is one. Reducing a host to its
 * eTLD+1 would broaden the grant to every tenant of that domain, so a grant
 * whose grantee is not registrable covers no claim (adcp#8169).
 */
function registrableGrantee(grantee: string): string | undefined {
  try {
    // Exact: the schema already requires the canonical lowercase A-label form,
    // so a grantee that only matches after URL parsing is not a registrable domain.
    return eTldPlusOne(grantee) === grantee ? grantee : undefined;
  } catch {
    return undefined;
  }
}
/** A grant's agents[] URL as a canonical origin, or undefined when it cannot be parsed. */
function grantAgentOrigin(url: string): string | undefined {
  try {
    return canonicalAgentOrigin(url);
  } catch {
    return undefined;
  }
}
/**
 * Publication rules beyond the schema: every grant's `grantee` is a
 * registrable domain and every `agents[].url` parses as an agent origin. A
 * relying party ignores a grant that breaks either, so publishing one grants
 * nothing while still making `grants[]` exhaustive for its scopes.
 */
export function assertPublishableTrustRecord(record: TrustRecord): void {
  validateTrustRecord(record);
  for (const grant of record.grants ?? []) {
    if (registrableGrantee(grant.grantee) === undefined)
      throw new TypeError(
        `Grant grantee "${grant.grantee}" is not a registrable domain; name the organization's registrable domain and narrow with agents[]`
      );
    for (const agent of grant.agents ?? [])
      if (grantAgentOrigin(agent.url) === undefined)
        throw new TypeError(`Grant agents[] URL "${agent.url}" is not a valid agent origin`);
  }
}
/** Validate ({@link assertPublishableTrustRecord}) and copy a trust record for publication. */
export function createTrustRecord(record: TrustRecord): TrustRecord {
  assertPublishableTrustRecord(record);
  return structuredClone(record);
}
export type TrustFetchResult =
  | { status: 'present'; operator: string; record: TrustRecord; checkedAt: number; freshUntil: number }
  | { status: 'absent'; operator: string; checkedAt: number; freshUntil: number };
export interface TrustEvaluatorOptions {
  /** Matches configured revocation polling: one minute through thirty minutes. */
  pollingIntervalSeconds?: number;
  /**
   * Seller policy: how long past the last listing record's freshness a bound
   * origin's non-spend calls may continue while its operator's record cannot
   * be read. Spend never continues on an outage. Default four polling
   * intervals.
   */
  maxOutageContinuationSeconds?: number;
  now?: () => number;
  fetchOptions?: Pick<SsrfFetchOptions, 'lookup' | 'trustedFetchFn'>;
  maxEntries?: number;
  /**
   * Process-local authority history only: operators remembered per hosting
   * provider, i.e. per ICANN registrable domain of a PSL PRIVATE-section name
   * (every `*.vercel.app`, `*.s3.<region>.amazonaws.com` or
   * `*.<project>.platformsh.site` operator shares one budget). ICANN
   * registrable domains each count once. Default 32.
   */
  maxAuthoritativeOperatorsPerPrivateSuffix?: number;
  /**
   * Process-local authority history only: total slots all PRIVATE-section
   * operators may hold together, so registrants of ICANN domains always keep
   * headroom. Default half of `maxEntries`.
   */
  maxPrivateAuthoritativeOperators?: number;
  maxConcurrentFetches?: number;
  /** Share authoritative-history across restarts/replicas when legacy fallback is enabled. */
  authorityHistory?: { has(operator: string): Promise<boolean>; mark(operator: string): Promise<void> };
}
/** Used by binding/grants/onboarding, never by cryptographic verification. */
export class TrustEvaluator {
  private readonly cache = new Map<string, TrustFetchResult>();
  private readonly negative = new Map<string, number>();
  private readonly pending = new Map<string, Promise<TrustFetchResult>>();
  private readonly urlRequests = new Map<string, Promise<Awaited<ReturnType<typeof ssrfSafeFetch>>>>();
  /** Keyed by (operator, host): one operator's authoritative_location hops never spend another's budget. */
  private readonly hostRates = new Map<string, { started: number; count: number }>();
  private readonly authoritativeOperators = new Set<string>();
  /** Remembered authoritative operators per budget group (see authorityGroup). */
  private readonly authorityGroups = new Map<string, number>();
  private privateAuthorityOperators = 0;
  readonly pollingIntervalSeconds: number;
  readonly maxOutageContinuationSeconds: number;
  constructor(private readonly options: TrustEvaluatorOptions = {}) {
    this.pollingIntervalSeconds = options.pollingIntervalSeconds ?? 300;
    this.maxOutageContinuationSeconds = options.maxOutageContinuationSeconds ?? 4 * this.pollingIntervalSeconds;
    if (!Number.isFinite(this.maxOutageContinuationSeconds) || this.maxOutageContinuationSeconds < 0)
      throw new TypeError('maxOutageContinuationSeconds must be a finite, non-negative number');
    if (
      !Number.isFinite(this.pollingIntervalSeconds) ||
      this.pollingIntervalSeconds < 60 ||
      this.pollingIntervalSeconds > 1800
    )
      throw new TypeError('Trust polling interval must be 60–1800 seconds');
  }
  async get(domainOrOrigin: string, force = false): Promise<TrustFetchResult> {
    let operator: string;
    try {
      operator = eTldPlusOne(domainOrOrigin);
    } catch {
      return failure();
    }
    const now = this.now();
    const cached = this.cache.get(operator);
    if (!force && cached && cached.freshUntil > now) return cached;
    if ((this.negative.get(operator) ?? 0) > now) unavailable();
    let pending = this.pending.get(operator);
    if (!pending) {
      if (this.pending.size >= (this.options.maxConcurrentFetches ?? 16)) unavailable();
      pending = this.fetch(operator, now);
      this.pending.set(operator, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.pending.get(operator) === pending) this.pending.delete(operator);
    }
  }
  async match(
    origin: string,
    role: string,
    countries?: readonly string[]
  ): Promise<{ operator: string; agent: TrustAgent; record: TrustRecord; freshUntil: number }> {
    const canonical = canonicalAgentOrigin(origin);
    let result: TrustFetchResult;
    try {
      result = await this.get(canonical);
    } catch (error) {
      if (!(error instanceof TrustRecordUnavailableError)) throw error;
      // A known delisting survives an outage: keep the last record read.
      const last = this.cache.get(eTldPlusOne(canonical));
      if (last && !listedAgent(last, canonical, role))
        throw new TrustMembershipError(last.status === 'present' ? 'unlisted' : 'absent');
      error.lastKnownListed = !!last && this.now() <= last.freshUntil + this.maxOutageContinuationSeconds;
      throw error;
    }
    const agent = listedAgent(result, canonical, role);
    if (result.status !== 'present') throw new TrustMembershipError('absent');
    if (!agent) throw new TrustMembershipError();
    if (agent.countries && countries?.length && countries.some(country => !agent.countries!.includes(country)))
      failure();
    return { operator: result.operator, agent, record: result.record, freshUntil: result.freshUntil };
  }
  invalidate(domain: string): void {
    this.cache.delete(eTldPlusOne(domain));
  }
  /**
   * Record that `operator` served a trust record. With durable history the
   * in-memory set is only a cache and may evict; without it, nothing is
   * evicted and an operator over its group budget or the total is refused.
   */
  private rememberAuthority(operator: string, durable: boolean): boolean {
    if (this.authoritativeOperators.has(operator)) return true;
    const max = this.options.maxEntries ?? 1000;
    if (durable) {
      // Durable history answers the legacy question; this set is only a cache.
      if (this.authoritativeOperators.size >= max)
        this.authoritativeOperators.delete(this.authoritativeOperators.values().next().value!);
      this.authoritativeOperators.add(operator);
      return true;
    }
    const group = authorityGroup(operator);
    const hosted = group !== operator;
    if (
      this.authoritativeOperators.size >= max ||
      (hosted &&
        (this.privateAuthorityOperators >= (this.options.maxPrivateAuthoritativeOperators ?? Math.floor(max / 2)) ||
          (this.authorityGroups.get(group) ?? 0) >= (this.options.maxAuthoritativeOperatorsPerPrivateSuffix ?? 32)))
    )
      return false;
    this.authoritativeOperators.add(operator);
    if (hosted) {
      this.privateAuthorityOperators++;
      this.authorityGroups.set(group, (this.authorityGroups.get(group) ?? 0) + 1);
    }
    return true;
  }
  /**
   * Process-local view only. With durable `authorityHistory` this set is a
   * cache and may have evicted an operator that durable history still records.
   */
  hasAuthoritativeRecord(domain: string): boolean {
    return this.authoritativeOperators.has(eTldPlusOne(domain));
  }
  private now(): number {
    return (this.options.now ?? (() => Date.now() / 1000))();
  }
  private async request(url: string, operator: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) failure();
    let own = false;
    try {
      own = eTldPlusOne(parsed.hostname) === operator;
    } catch {
      /* No registrable domain: always foreign. */
    }
    // An operator's own hosts get a per-(operator, host) budget; hops elsewhere
    // share one per-host budget, so foreign hops can neither drain a victim
    // operator's own budget nor multiply fetches to any host.
    const host = JSON.stringify([own ? operator : FOREIGN_HOST_BUDGET, parsed.hostname]);
    const limit = own ? OWN_HOST_REQUESTS_PER_MINUTE : FOREIGN_HOST_REQUESTS_PER_MINUTE;
    const pending = this.urlRequests.get(url);
    if (pending) return pending;
    const now = this.now(),
      rate = this.hostRates.get(host);
    if (rate && now - rate.started < 60 && rate.count >= limit) throw new TrustHostCapacityError();
    if (!rate && this.hostRates.size >= (this.options.maxEntries ?? 1000))
      this.hostRates.delete(this.hostRates.keys().next().value!);
    this.hostRates.set(
      host,
      rate && now - rate.started < 60 ? { ...rate, count: rate.count + 1 } : { started: now, count: 1 }
    );
    const request = ssrfSafeFetch(url, {
      ...this.options.fetchOptions,
      maxBodyBytes: 2 * 1024 * 1024,
      timeoutMs: 10_000,
      headers: { accept: 'application/json' },
    });
    this.urlRequests.set(url, request);
    try {
      return await request;
    } finally {
      if (this.urlRequests.get(url) === request) this.urlRequests.delete(url);
    }
  }
  private async fetch(operator: string, now: number): Promise<TrustFetchResult> {
    try {
      let response = await this.request(`https://${operator}/.well-known/trust.json`, operator);
      let result: TrustFetchResult;
      if (response.status === 404 || response.status === 410) {
        // Once authoritative, an outage/removal cannot resurrect legacy authority.
        if (this.authoritativeOperators.has(operator) || (await this.options.authorityHistory?.has(operator)))
          // A 404/410 after a 200 is a discovery failure, not a removal: the last
          // record read stays authoritative and legacy authority never returns.
          failure();
        result = { status: 'absent', operator, checkedAt: now, freshUntil: now + 60 };
      } else {
        if (response.status !== 200) failure();
        // Persist history before trusting this response; cache eviction must not
        // allow a previously authoritative operator to downgrade to legacy.
        if (this.options.authorityHistory) {
          await this.options.authorityHistory.mark(operator);
          this.rememberAuthority(operator, true);
        } else if (!this.rememberAuthority(operator, false)) {
          // Process-local history is full for this operator's budget: a record
          // that cannot be remembered is not trusted. Never evict another
          // operator's history (that would re-open its legacy fallback).
          failure();
        }
        let record: unknown = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(response.body), 32);
        validateTrustRecord(record);
        if (record.authoritative_location) {
          response = await this.request(record.authoritative_location, operator);
          if (response.status !== 200) failure();
          record = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(response.body), 32);
          validateTrustRecord(record);
          if (record.authoritative_location) failure();
        }
        result = {
          status: 'present',
          operator,
          record: record as TrustRecord,
          checkedAt: now,
          freshUntil: now + this.pollingIntervalSeconds,
        };
      }
      const max = this.options.maxEntries ?? 1000;
      if (this.cache.size >= max && !this.cache.has(operator)) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(operator, result);
      this.negative.delete(operator);
      return result;
    } catch (cause) {
      // Shared capacity is not this operator's failure: retry soon, uncached.
      if (cause instanceof TrustHostCapacityError) return unavailable(cause);
      if (this.negative.size >= (this.options.maxEntries ?? 1000))
        this.negative.delete(this.negative.keys().next().value!);
      this.negative.set(operator, now + 60);
      return unavailable(cause);
    }
  }
}
function listedAgent(result: TrustFetchResult, origin: string, role: string): TrustAgent | undefined {
  if (result.status !== 'present') return undefined;
  const entries = (result.record.agents ?? []).filter(agent => canonicalAgentOrigin(agent.url) === origin);
  return entries.length === 1 && entries[0]!.roles.includes(role) ? entries[0] : undefined;
}
/**
 * Budget group: for a PSL PRIVATE-section name, the hosting provider's ICANN
 * registrable domain (wildcard and multi-rule providers collapse to one
 * group); otherwise the registrable domain itself.
 */
function authorityGroup(operator: string): string {
  if (!parseDomain(operator, { allowPrivateDomains: true }).isPrivate) return operator;
  const provider = parseDomain(operator).domain;
  return `private:${provider ?? operator}`;
}
export interface DemandGrantClaim {
  /** Only pass identity from an actual verifier. */
  signerOrigin: string;
  brand: { domain: string; brand_id?: string; countries?: readonly string[] };
  accountOperator: string;
  scope: string;
}
export interface DemandGrantAuthorization {
  source: 'implicit' | 'trust' | 'seller' | 'legacy';
  operator: string;
  expiresAt?: number;
  checkedAt: number;
  chain: string[];
}
export interface DemandGrantOptions {
  evaluator: TrustEvaluator;
  now?: () => number;
  /** Only evaluated for nonexclusive uncovered claims, never fetch failures. */
  sellerAuthorization?: (claim: DemandGrantClaim) => Promise<boolean>;
  /** Only for authoritative absence; never after a 200 or an exclusive record. */
  legacyAuthorization?: (claim: DemandGrantClaim) => Promise<boolean>;
  /** Seller-verified brand identity resolution, including the house's child-brand ID. Never accept a buyer-selected authorizer. */
  resolveBrandHouse?: (brand: DemandGrantClaim['brand']) => Promise<{ domain: string; brand_id: string } | undefined>;
}
function grantsScope(grant: TrustGrant, scope: string): boolean {
  return grant.scopes.some(
    granted => granted === '*' || granted === scope || (granted === 'adcp:all' && scope.startsWith('adcp:'))
  );
}
function grantMatches(grant: TrustGrant, target: string, claim: DemandGrantClaim, now: number): boolean {
  // Exact match on a registrable grantee: never reduce a host grantee to its eTLD+1.
  if (registrableGrantee(grant.grantee) !== target) return false;
  if (!grantsScope(grant, claim.scope)) return false;
  // An agents[] URL that does not parse lists no agent: the grant fails to
  // match on its own and never throws out of the evaluation of other grants.
  if (
    grant.agents &&
    !grant.agents.some(agent => grantAgentOrigin(agent.url) === canonicalAgentOrigin(claim.signerOrigin))
  )
    return false;
  const brands = grant.profiles?.adcp?.brands;
  if (brands && !brands.includes('*') && (!claim.brand.brand_id || !brands.includes(claim.brand.brand_id)))
    return false;
  if (
    grant.countries &&
    (!claim.brand.countries?.length || claim.brand.countries.some(country => !grant.countries!.includes(country)))
  )
    return false;
  if (grant.valid_from && Date.parse(grant.valid_from) / 1000 > now) return false;
  if (grant.valid_until && Date.parse(grant.valid_until) / 1000 <= now) return false;
  return true;
}
/** Always invoke before sync_accounts side effects and before spend. No account mutation. */
export async function authorizeDemandGrant(
  claim: DemandGrantClaim,
  options: DemandGrantOptions
): Promise<DemandGrantAuthorization> {
  const now = (options.now ?? (() => Date.now() / 1000))();
  const signer = await options.evaluator.match(claim.signerOrigin, 'adcp:buying', claim.brand.countries);
  if (signer.agent.countries && !claim.brand.countries?.length) failure();
  const brand = eTldPlusOne(claim.brand.domain),
    account = eTldPlusOne(claim.accountOperator),
    operator = signer.operator;
  const result = (
    source: DemandGrantAuthorization['source'],
    chain: string[],
    grants: TrustGrant[] = []
  ): DemandGrantAuthorization => ({
    source,
    chain,
    operator,
    checkedAt: now,
    ...(grants.some(g => g.valid_until)
      ? { expiresAt: Math.min(...grants.map(g => (g.valid_until ? Date.parse(g.valid_until) / 1000 : Infinity))) }
      : {}),
  });
  if (brand === operator && account === operator) return result('implicit', [brand]);
  if (brand === operator && account !== operator) throw new IdentityAuthorizationError('grant_absent');
  const house = await options.resolveBrandHouse?.(claim.brand);
  const authoritativeBrand = house ? eTldPlusOne(house.domain) : brand;
  const grantClaim = house ? { ...claim, brand: { ...claim.brand, brand_id: house.brand_id } } : claim;
  // A grantor that once served a record and is now unreachable (404/410
  // included) is an outage, never a grant removal or a legacy fallback.
  const record = await options.evaluator.get(authoritativeBrand);
  if (record.status === 'absent') {
    if (await options.legacyAuthorization?.(claim)) return result('legacy', [brand, account, operator]);
    throw new IdentityAuthorizationError('grant_absent');
  }
  const first = (record.record.grants ?? []).filter(g => grantMatches(g, account, grantClaim, now));
  if (account === operator && first.length) return result('trust', [brand, operator], [first[0]!]);
  // A self-operated brand (brand is its own account.operator) may grant the
  // signer's operator directly: account.operator is on the chain as the brand.
  const selfOperated = account === brand || account === authoritativeBrand;
  if (selfOperated && account !== operator) {
    const direct = (record.record.grants ?? []).find(g => grantMatches(g, operator, grantClaim, now));
    if (direct) return result('trust', [brand, operator], [direct]);
  }
  if (account !== operator && account !== brand && first.length) {
    const intermediary = await options.evaluator.get(account);
    if (intermediary.status === 'present') {
      const second = (intermediary.record.grants ?? []).find(g => grantMatches(g, operator, grantClaim, now));
      if (second) return result('trust', [brand, account, operator], [first[0]!, second]);
    }
  }
  // A grant to account.operator (or, self-operated, to the signer's operator)
  // for this scope that did not match is published narrowing: it blocks the
  // seller's discretion. A grant whose grantee is not a registrable domain
  // covers no claim, so it does not count here; its scopes still count for
  // exclusive_grants, which below refuses every uncovered claim.
  const covered = (record.record.grants ?? []).some(g => {
    const grantee = registrableGrantee(g.grantee);
    return (
      grantee !== undefined &&
      (grantee === account || (selfOperated && grantee === operator)) &&
      grantsScope(g, claim.scope)
    );
  });
  if (!covered && !record.record.exclusive_grants && (await options.sellerAuthorization?.(claim)))
    return result('seller', [brand, account, operator]);
  throw new IdentityAuthorizationError('grant_absent');
}
