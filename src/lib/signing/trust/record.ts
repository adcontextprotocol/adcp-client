/**
 * Experimental (AdCP 3.3) trust-record evaluation (spec R3a).
 *
 * Evaluated only where something is gated on it: binding a principal,
 * evaluating a grant, or `open` onboarding. Nothing in this module runs on
 * the signature path, and key discovery never reads a trust record.
 */
import { parse as parseTld } from 'tldts';
import { ssrfSafeFetch, type SsrfDnsLookup } from '../../net';
import { eTldPlusOne } from '../agent-resolver/etld';
import { parseStrictJson } from '../agent-resolver/strict-json';
import { webBotAuthOrigin, tryWebBotAuthOrigin } from '../wba/origin';
import type { VerifiedWebBotAuthSigner } from '../wba/verifier';
import { identityPreviewSchemaErrors, knownOnboardingRequirementKinds } from './schema';
import type { OriginBindings } from './bindings';

export const TRUST_RECORD_PATH = '/.well-known/trust.json';
/** Streaming body cap for trust records and their one hop. */
export const TRUST_RECORD_MAX_BYTES = 2 * 1024 * 1024;
/** Strict-parse nesting limit. */
export const TRUST_RECORD_MAX_DEPTH = 32;
/** Negative cache for failed trust discovery (at most 60 s). */
const NEGATIVE_CACHE_SECONDS = 60;

/** A missing, invalid, or unavailable trust record. It provides no authority. */
export class TrustRecordError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TrustRecordError';
  }
}

/**
 * 404/410 before any successful discovery of the host. Only this outcome may
 * reach a configured brand.json `authorized_operators` fallback; a fetch
 * failure never does ("a fetch failure is never equivalent to absence").
 */
export class TrustRecordAbsentError extends TrustRecordError {
  constructor(message = 'no trust record is published') {
    super(message);
    this.name = 'TrustRecordAbsentError';
  }
}

/** One trust-record HTTP response. Custom fetchers are a trusted seam and own SSRF policy. */
export interface TrustRecordResponse {
  status: number;
  body: string;
}
export type TrustRecordFetcher = (url: string) => Promise<TrustRecordResponse>;

/**
 * Derive the operator's record: `https://{eTLD+1(host)}/.well-known/trust.json`
 * from the pinned ICANN+PRIVATE PSL snapshot. Never a caller-supplied
 * pointer. An IP literal, a public suffix, or a host with no eTLD+1 has no
 * trust record.
 */
export function trustRecordUrl(originOrDomain: string): string {
  return `https://${operatorDomainOf(originOrDomain)}${TRUST_RECORD_PATH}`;
}

/** The operator of an origin or domain: its registrable domain. */
export function operatorDomainOf(originOrDomain: string): string {
  try {
    return eTldPlusOne(originOrDomain);
  } catch (error) {
    throw new TrustRecordError('identity has no registrable operator domain', { cause: error });
  }
}

/**
 * Whether an origin's registrable domain comes from the PSL PRIVATE section
 * (a tenant subdomain of a hosting platform, such as `team.github.io`).
 * Spec R7: such an origin is eligible for `open` sandbox onboarding only,
 * and automatic-binding quotas count per operator domain.
 */
export function isPrivateSuffixOperator(originOrDomain: string): boolean {
  operatorDomainOf(originOrDomain);
  const host = originOrDomain.includes('://') ? new URL(originOrDomain).hostname : originOrDomain;
  return parseTld(host, { allowPrivateDomains: true, extractHostname: false }).isPrivate === true;
}

/** SSRF-guarded, redirect-free fetch with the 2 MiB cap and a 10 s deadline. */
export async function fetchTrustRecord(
  url: string,
  options: { allowPrivateIp?: boolean; lookup?: SsrfDnsLookup } = {}
): Promise<TrustRecordResponse> {
  assertFetchTarget(url);
  const response = await ssrfSafeFetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    allowPrivateIp: options.allowPrivateIp === true,
    timeoutMs: 10_000,
    maxBodyBytes: TRUST_RECORD_MAX_BYTES,
    ...(options.lookup !== undefined && { lookup: options.lookup }),
  });
  return { status: response.status, body: new TextDecoder('utf-8', { fatal: true }).decode(response.body) };
}

function assertFetchTarget(url: string): void {
  if (typeof url !== 'string' || /[\u0000- \u007f]/.test(url) || !url.startsWith('https://')) {
    throw new TrustRecordError('trust fetches require HTTPS without whitespace');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new TrustRecordError('invalid trust fetch target', { cause: error });
  }
  const authority = /^https:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '';
  if (parsed.username || parsed.password || authority.includes('@') || tryWebBotAuthOrigin(url) === undefined) {
    throw new TrustRecordError('invalid trust fetch target');
  }
}

/**
 * Validate an authored trust record for `operatorDomain` (the host that will
 * serve it): the pinned schema (so no keys in agent entries), one agent per
 * canonical origin, every agent under the operator's registrable domain, and
 * grantees as exact registrable domains. A hosted pointer record is
 * validated by shape only. Returns a deep copy.
 */
export function validateTrustRecord(document: unknown, options: { operatorDomain: string }): Record<string, unknown> {
  return checkTrustRecord(document, options.operatorDomain, false);
}

function checkTrustRecord(document: unknown, operatorDomain: string, reader: boolean): Record<string, unknown> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TrustRecordError('trust record must be an object');
  }
  const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const errors = identityPreviewSchemaErrors(reader ? readerSchemaView(copy) : copy, 'trust/v1/trust.json');
  if (errors.length > 0)
    throw new TrustRecordError('trust record does not conform to the experimental trust.json schema');
  if ('authoritative_location' in copy) return copy;
  const operator = operatorDomainOf(operatorDomain);
  const seen = new Set<string>();
  for (const agent of (copy.agents as Array<{ url: string }> | undefined) ?? []) {
    const origin = tryWebBotAuthOrigin(agent.url);
    if (origin === undefined) throw new TrustRecordError('agent URLs must be HTTPS without userinfo');
    let agentOperator: string | undefined;
    try {
      agentOperator = eTldPlusOne(origin);
    } catch {
      agentOperator = undefined;
    }
    if (agentOperator !== operator) throw new TrustRecordError('agent origin does not belong to the record owner');
    if (seen.has(origin)) throw new TrustRecordError('a trust record must list one agent per origin');
    seen.add(origin);
  }
  for (const grant of (copy.grants as Array<{ grantee: string; agents?: Array<{ url: string }> }> | undefined) ?? []) {
    let registrable: string | undefined;
    try {
      registrable = eTldPlusOne(grant.grantee);
    } catch {
      registrable = undefined;
    }
    if (registrable !== grant.grantee) throw new TrustRecordError('grant grantee must be an exact registrable domain');
    for (const agent of grant.agents ?? []) {
      if (tryWebBotAuthOrigin(agent.url) === undefined)
        throw new TrustRecordError('grant agent URLs must be HTTPS origins');
    }
  }
  return copy;
}

/**
 * Readers keep onboarding requirements whose `kind` they do not know, so an
 * application can fall back to the posture's `message` and `url`. Only those
 * advisory entries are relaxed for validation; authority-bearing fields
 * (agents, roles, grants) stay strict.
 */
function readerSchemaView(document: Record<string, unknown>): Record<string, unknown> {
  const view = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const known = new Set(knownOnboardingRequirementKinds());
  const relax = (profiles: unknown) => {
    const adcp = profiles && typeof profiles === 'object' ? (profiles as Record<string, unknown>).adcp : undefined;
    const posture = adcp && typeof adcp === 'object' ? (adcp as Record<string, unknown>).onboarding : undefined;
    if (!posture || typeof posture !== 'object') return;
    const requirements = (posture as Record<string, unknown>).requirements;
    if (!Array.isArray(requirements)) return;
    (posture as Record<string, unknown>).requirements = requirements.filter(
      requirement =>
        !(
          requirement &&
          typeof requirement === 'object' &&
          typeof (requirement as { kind?: unknown }).kind === 'string' &&
          !known.has((requirement as { kind: string }).kind)
        )
    );
  };
  relax(view.profiles);
  if (Array.isArray(view.agents)) for (const agent of view.agents) relax((agent as Record<string, unknown>)?.profiles);
  return view;
}

/** An evaluated record, valid until `expiresAt` (epoch seconds). */
export interface EvaluatedTrustRecord {
  /** The registrable domain of the evaluated origin: never a value from the document. */
  operatorDomain: string;
  /** URL the document was finally read from (after at most one hop). */
  sourceUrl: string;
  document: Record<string, unknown>;
  expiresAt: number;
}

/**
 * Exactly one `agents[]` entry whose canonical origin is `origin` and that
 * carries `role`. Throws {@link TrustRecordError} otherwise.
 */
export function matchTrustRecordAgent(
  record: EvaluatedTrustRecord,
  origin: string,
  role: string
): Record<string, unknown> {
  const target = tryWebBotAuthOrigin(origin);
  const agents = (record.document.agents as Array<{ url: string; roles: string[] }> | undefined) ?? [];
  const matches = agents.filter(agent => target !== undefined && tryWebBotAuthOrigin(agent.url) === target);
  if (matches.length !== 1 || !matches[0]!.roles.includes(role)) {
    throw new TrustRecordError('record must list exactly one matching agent with the required role');
  }
  return JSON.parse(JSON.stringify(matches[0])) as Record<string, unknown>;
}

export interface TrustRecordEvaluatorOptions {
  /** Trusted transport seam; defaults to {@link fetchTrustRecord}. */
  fetch?: TrustRecordFetcher;
  allowPrivateIp?: boolean;
  lookup?: SsrfDnsLookup;
  /**
   * Freshness bound: the revocation polling interval (seconds, 1–1800).
   * Cached records never outlive it. Default 60.
   */
  pollingIntervalSeconds?: number;
  /** Bound on cached records, negative entries and concurrent fetches. Default 256. */
  maxRecords?: number;
  /** Concurrent fetches per host, including hop targets. Default 4. */
  maxFetchesPerHost?: number;
  /** Epoch-seconds clock. */
  now?: () => number;
}

interface Failure {
  absent: boolean;
  message: string;
  retryAfter: number;
}

/**
 * Experimental (AdCP 3.3). Fetches and evaluates operator trust records:
 * derived location, one `authoritative_location` hop (the target must not
 * point again, and HTTP redirects are never followed), the 2 MiB cap, strict
 * JSON at depth 32, and the pinned schema. Records are cached no longer than
 * the revocation polling interval; failures are cached for 60 seconds and
 * fail closed. A 200 permanently marks the host as published for this
 * evaluator's lifetime, which disables brand.json fallback (spec R4).
 *
 * Fetches coalesce per operator domain and per URL, and are bounded per host,
 * so one slow counterparty does not block another.
 */
export class TrustRecordEvaluator {
  private readonly fetcher: TrustRecordFetcher;
  private readonly interval: number;
  private readonly maxRecords: number;
  private readonly maxPerHost: number;
  readonly now: () => number;
  private readonly cache = new Map<string, EvaluatedTrustRecord>();
  private readonly failures = new Map<string, Failure>();
  private readonly pending = new Map<string, Promise<EvaluatedTrustRecord>>();
  private readonly responses = new Map<string, { expiresAt: number; response: TrustRecordResponse }>();
  private readonly responsePending = new Map<string, Promise<{ expiresAt: number; response: TrustRecordResponse }>>();
  private readonly hostsInflight = new Map<string, number>();
  private readonly hostFailures = new Map<string, number>();
  private readonly published = new Set<string>();

  constructor(options: TrustRecordEvaluatorOptions = {}) {
    this.fetcher =
      options.fetch ??
      (url => fetchTrustRecord(url, { allowPrivateIp: options.allowPrivateIp === true, lookup: options.lookup }));
    this.interval = options.pollingIntervalSeconds ?? 60;
    this.maxRecords = options.maxRecords ?? 256;
    this.maxPerHost = options.maxFetchesPerHost ?? 4;
    if (!(this.interval > 0 && this.interval <= 1800) || !(this.maxRecords > 0) || !(this.maxPerHost > 0)) {
      throw new TypeError('invalid trust cache bounds');
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Whether `domain`'s record has ever returned 200 to this evaluator. */
  hasPublished(originOrDomain: string): boolean {
    return this.published.has(operatorDomainOf(originOrDomain));
  }

  /**
   * Evaluate the record derived from `originOrDomain`. With `role`, also
   * require exactly one matching agent entry carrying it. The returned
   * document is a copy; callers cannot mutate cached authority.
   */
  async evaluate(originOrDomain: string, options: { role?: string } = {}): Promise<EvaluatedTrustRecord> {
    const domain = operatorDomainOf(originOrDomain);
    const url = `https://${domain}${TRUST_RECORD_PATH}`;
    let record = this.cache.get(domain);
    if (!record || record.expiresAt <= this.now()) {
      const failure = this.failures.get(domain);
      if (failure && failure.retryAfter > this.now()) {
        throw failure.absent ? new TrustRecordAbsentError(failure.message) : new TrustRecordError(failure.message);
      }
      let task = this.pending.get(domain);
      if (!task) {
        if (this.pending.size >= this.maxRecords) throw new TrustRecordError('trust discovery capacity exceeded');
        task = this.refresh(domain, url);
        this.pending.set(domain, task);
        task.catch(() => undefined);
      }
      record = await task;
    } else {
      this.cache.delete(domain);
      this.cache.set(domain, record);
    }
    if (record.expiresAt <= this.now()) throw new TrustRecordError('trust record expired while being evaluated');
    if (options.role !== undefined) matchTrustRecordAgent(record, originOrDomain, options.role);
    return { ...record, document: JSON.parse(JSON.stringify(record.document)) as Record<string, unknown> };
  }

  /**
   * Explicitly bind a verified WBA origin to a principal after evaluating its
   * operator's record (spec R5 rule 2): exactly one entry for the origin with
   * `role` (default `adcp:buying`). Discovery never calls this.
   */
  async bind(
    signer: Pick<VerifiedWebBotAuthSigner, 'origin' | 'profile'>,
    options: {
      principalId: string;
      bindings: OriginBindings;
      existingRfc9421Principal?: boolean;
      migrationApproved?: boolean;
      role?: string;
    }
  ): Promise<EvaluatedTrustRecord> {
    if (signer?.profile !== 'web-bot-auth' || typeof signer.origin !== 'string') {
      throw new TrustRecordError('binding requires a verified Web Bot Auth identity');
    }
    const origin = webBotAuthOrigin(signer.origin);
    const record = await this.evaluate(origin, { role: options.role ?? 'adcp:buying' });
    await options.bindings.bind(origin, options.principalId, {
      existingRfc9421Principal: options.existingRfc9421Principal === true,
      migrationApproved: options.migrationApproved === true,
    });
    return record;
  }

  private async refresh(domain: string, url: string): Promise<EvaluatedTrustRecord> {
    try {
      const record = await this.fetchRecord(domain, url);
      this.cache.delete(domain);
      this.cache.set(domain, record);
      this.failures.delete(domain);
      trim(this.cache, this.maxRecords);
      return record;
    } catch (error) {
      const typed =
        error instanceof TrustRecordError ? error : new TrustRecordError('trust record fetch failed', { cause: error });
      this.failures.delete(domain);
      this.failures.set(domain, {
        absent: typed instanceof TrustRecordAbsentError,
        message: typed.message,
        retryAfter: this.now() + NEGATIVE_CACHE_SECONDS,
      });
      trim(this.failures, this.maxRecords);
      throw typed;
    } finally {
      this.pending.delete(domain);
    }
  }

  private async fetchRecord(domain: string, url: string): Promise<EvaluatedTrustRecord> {
    let source = url;
    let expiresAt = this.now() + this.interval;
    for (let hop = 0; hop < 2; hop++) {
      assertFetchTarget(source);
      let fetched;
      try {
        fetched = await this.fetchResponse(source);
      } catch (error) {
        throw new TrustRecordError('trust record fetch failed', { cause: error });
      }
      expiresAt = Math.min(expiresAt, fetched.expiresAt);
      const { response } = fetched;
      if ((response.status === 404 || response.status === 410) && hop === 0 && !this.published.has(domain)) {
        throw new TrustRecordAbsentError();
      }
      if (response.status !== 200 || Buffer.byteLength(response.body, 'utf8') > TRUST_RECORD_MAX_BYTES) {
        throw new TrustRecordError('trust record is unavailable or oversized');
      }
      // A 200 makes trust.json the grantor's only source of grants for the
      // evaluator's lifetime, even if a later fetch fails or disappears.
      this.published.add(domain);
      let document: unknown;
      try {
        document = parseStrictJson(response.body);
        assertDepth(document, TRUST_RECORD_MAX_DEPTH);
      } catch (error) {
        throw new TrustRecordError('trust record is not strict JSON', { cause: error });
      }
      // Validate against the original owner, never the hop target's host.
      const checked = checkTrustRecord(document, domain, true);
      const pointer = checked.authoritative_location;
      if (pointer === undefined) {
        return { operatorDomain: domain, sourceUrl: source, document: document as Record<string, unknown>, expiresAt };
      }
      if (hop === 1) throw new TrustRecordError('a second authoritative-location hop is forbidden');
      source = pointer as string;
    }
    throw new TrustRecordError('trust record resolution failed');
  }

  /** Share transport bytes per URL while each owner validates them separately. */
  private async fetchResponse(url: string): Promise<{ expiresAt: number; response: TrustRecordResponse }> {
    const host = new URL(url).hostname;
    const cached = this.responses.get(url);
    if (cached && cached.expiresAt > this.now()) return cached;
    if ((this.hostFailures.get(host) ?? 0) > this.now()) throw new TrustRecordError('trust fetch host is cooling down');
    let task = this.responsePending.get(url);
    if (!task) {
      if (this.responsePending.size >= this.maxRecords || (this.hostsInflight.get(host) ?? 0) >= this.maxPerHost) {
        throw new TrustRecordError('trust fetch host capacity exceeded');
      }
      this.hostsInflight.set(host, (this.hostsInflight.get(host) ?? 0) + 1);
      task = this.refreshResponse(url, host);
      this.responsePending.set(url, task);
      task.catch(() => undefined);
    }
    return task;
  }

  private async refreshResponse(
    url: string,
    host: string
  ): Promise<{ expiresAt: number; response: TrustRecordResponse }> {
    const started = this.now();
    try {
      const response = await this.fetcher(url);
      if (Buffer.byteLength(response.body, 'utf8') > TRUST_RECORD_MAX_BYTES)
        throw new TrustRecordError('trust record is oversized');
      const entry = {
        // The cache can never extend authority past the interval measured
        // from when this fetch started.
        expiresAt: started + (response.status === 200 ? this.interval : NEGATIVE_CACHE_SECONDS),
        response,
      };
      this.responses.delete(url);
      this.responses.set(url, entry);
      trim(this.responses, this.maxRecords);
      if (response.status >= 500 || response.status === 429) this.coolDown(host);
      return entry;
    } catch (error) {
      this.coolDown(host);
      throw new TrustRecordError('trust record fetch failed', { cause: error });
    } finally {
      this.responsePending.delete(url);
      const remaining = (this.hostsInflight.get(host) ?? 1) - 1;
      if (remaining > 0) this.hostsInflight.set(host, remaining);
      else this.hostsInflight.delete(host);
    }
  }

  private coolDown(host: string): void {
    this.hostFailures.delete(host);
    this.hostFailures.set(host, this.now() + NEGATIVE_CACHE_SECONDS);
    trim(this.hostFailures, this.maxRecords);
  }
}

function trim<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value as K);
}

function assertDepth(value: unknown, max: number): void {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (depth > max) throw new TypeError('JSON nesting exceeds the limit');
    for (const child of Object.values(node as Record<string, unknown>)) stack.push([child, depth + 1]);
  }
}
