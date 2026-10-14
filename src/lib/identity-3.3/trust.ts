import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ssrfSafeFetch, type SsrfFetchOptions } from '../net';
import { canonicalAgentOrigin } from '../signing/agent-resolver/canonicalize';
import { eTldPlusOne } from '../signing/agent-resolver/etld';
import { parseStrictJson } from '../signing/agent-resolver/strict-json';
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
  /** @internal The operator answered 404/410 after publishing a record. */
  removed = false;
  /**
   * Set by `match()`: the last record read for this operator listed the origin
   * with the role and is still within outage grace (four polling intervals
   * past its freshness). Only then may non-spend calls continue under a binding.
   */
  lastKnownListed = false;
  constructor() {
    super();
    this.name = 'TrustRecordUnavailableError';
    this.message = 'Agent trust record is temporarily unavailable';
  }
}
/** The operator's current record definitively does not list the origin with the required role. */
export class TrustMembershipError extends IdentityAuthorizationError {
  constructor() {
    super();
    this.name = 'TrustMembershipError';
  }
}
function unavailable(cause?: unknown, removed = false): never {
  const error = new TrustRecordUnavailableError();
  error.removed = removed;
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  throw error;
}
/** Per-host rate exceeded: shared capacity, never cached as an operator failure. */
class TrustHostCapacityError extends Error {}
/** 404/410 from an operator that has published a record before. */
class TrustRecordRemovedError extends Error {}
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
export function createTrustRecord(record: TrustRecord): TrustRecord {
  validateTrustRecord(record);
  return structuredClone(record);
}
export type TrustFetchResult =
  | { status: 'present'; operator: string; record: TrustRecord; checkedAt: number; freshUntil: number }
  | { status: 'absent'; operator: string; checkedAt: number; freshUntil: number };
export interface TrustEvaluatorOptions {
  /** Matches configured revocation polling: one minute through thirty minutes. */
  pollingIntervalSeconds?: number;
  now?: () => number;
  fetchOptions?: Pick<SsrfFetchOptions, 'lookup' | 'trustedFetchFn'>;
  maxEntries?: number;
  maxConcurrentFetches?: number;
  /** Share authoritative-history across restarts/replicas when legacy fallback is enabled. */
  authorityHistory?: { has(operator: string): Promise<boolean>; mark(operator: string): Promise<void> };
}
/** Used by binding/grants/onboarding, never by cryptographic verification. */
export class TrustEvaluator {
  private readonly cache = new Map<string, TrustFetchResult>();
  private readonly negative = new Map<string, { until: number; removed: boolean }>();
  private readonly pending = new Map<string, Promise<TrustFetchResult>>();
  private readonly urlRequests = new Map<string, Promise<Awaited<ReturnType<typeof ssrfSafeFetch>>>>();
  /** Keyed by (operator, host): one operator's authoritative_location hops never spend another's budget. */
  private readonly hostRates = new Map<string, { started: number; count: number }>();
  private readonly authoritativeOperators = new Set<string>();
  private authorityHistoryOverflowed = false;
  readonly pollingIntervalSeconds: number;
  constructor(private readonly options: TrustEvaluatorOptions = {}) {
    this.pollingIntervalSeconds = options.pollingIntervalSeconds ?? 300;
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
    const negative = this.negative.get(operator);
    if (negative && negative.until > now) unavailable(undefined, negative.removed);
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
      // A removed record (404/410 after a 200) is a delisting on every replica,
      // whether or not this process remembers the earlier 200.
      if (error.removed) throw new TrustMembershipError();
      // A known delisting survives an outage: keep the last record read.
      const last = this.cache.get(eTldPlusOne(canonical));
      if (last && !listedAgent(last, canonical, role)) throw new TrustMembershipError();
      error.lastKnownListed = !!last && this.now() <= last.freshUntil + 4 * this.pollingIntervalSeconds;
      throw error;
    }
    const agent = listedAgent(result, canonical, role);
    if (!agent || result.status !== 'present') throw new TrustMembershipError();
    if (agent.countries && countries?.length && countries.some(country => !agent.countries!.includes(country)))
      failure();
    return { operator: result.operator, agent, record: result.record, freshUntil: result.freshUntil };
  }
  invalidate(domain: string): void {
    this.cache.delete(eTldPlusOne(domain));
  }
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
        if (
          this.authorityHistoryOverflowed ||
          this.authoritativeOperators.has(operator) ||
          (await this.options.authorityHistory?.has(operator))
        )
          throw new TrustRecordRemovedError();
        result = { status: 'absent', operator, checkedAt: now, freshUntil: now + 60 };
      } else {
        if (response.status !== 200) failure();
        if (
          !this.authoritativeOperators.has(operator) &&
          this.authoritativeOperators.size >= (this.options.maxEntries ?? 1000)
        ) {
          if (!this.options.authorityHistory) this.authorityHistoryOverflowed = true;
          this.authoritativeOperators.delete(this.authoritativeOperators.values().next().value!);
        }
        // Persist history before trusting this response; cache eviction must not
        // allow a previously authoritative operator to downgrade to legacy.
        await this.options.authorityHistory?.mark(operator);
        this.authoritativeOperators.add(operator);
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
      const removed = cause instanceof TrustRecordRemovedError;
      if (this.negative.size >= (this.options.maxEntries ?? 1000))
        this.negative.delete(this.negative.keys().next().value!);
      this.negative.set(operator, { until: now + 60, removed });
      return unavailable(cause, removed);
    }
  }
}
function listedAgent(result: TrustFetchResult, origin: string, role: string): TrustAgent | undefined {
  if (result.status !== 'present') return undefined;
  const entries = (result.record.agents ?? []).filter(agent => canonicalAgentOrigin(agent.url) === origin);
  return entries.length === 1 && entries[0]!.roles.includes(role) ? entries[0] : undefined;
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
function grantMatches(grant: TrustGrant, target: string, claim: DemandGrantClaim, now: number): boolean {
  if (eTldPlusOne(grant.grantee) !== target) return false;
  if (
    !grant.scopes.some(
      scope => scope === '*' || scope === claim.scope || (scope === 'adcp:all' && claim.scope.startsWith('adcp:'))
    )
  )
    return false;
  if (
    grant.agents &&
    !grant.agents.some(agent => canonicalAgentOrigin(agent.url) === canonicalAgentOrigin(claim.signerOrigin))
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
  const covered = (record.record.grants ?? []).some(
    g =>
      (eTldPlusOne(g.grantee) === account || (selfOperated && eTldPlusOne(g.grantee) === operator)) &&
      g.scopes.some(
        scope => scope === '*' || scope === claim.scope || (scope === 'adcp:all' && claim.scope.startsWith('adcp:'))
      )
  );
  if (!covered && !record.record.exclusive_grants && (await options.sellerAuthorization?.(claim)))
    return result('seller', [brand, account, operator]);
  throw new IdentityAuthorizationError('grant_absent');
}
