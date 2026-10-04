import { classifyDiscoveryFailure, isPermanentDiscoveryFailure } from './agent-resolver/fetch-helpers';
/** Capability-confirmed sender key discovery and SSRF-safe brand.json fetching. */
import { ssrfSafeFetch, type SsrfDnsLookup } from '../net';
import type { JwksResolver } from './jwks';
import { type HttpsJwksResolverOptions } from './jwks-https';
import type { AdcpJsonWebKey } from './types';
import { ResolvedAgentJwksResolver } from './agent-resolver/resolved-agent-jwks';
import type { AgentProtocol, FetchCapabilitiesFn } from './agent-resolver/resolve-agent';
import { parseStrictJson } from './agent-resolver/strict-json';
import type { JwksResolution } from './jwks';
import { canonicalAgentUrl } from './agent-resolver/select-agent';

export type BrandAgentType =
  | 'brand'
  | 'rights'
  | 'measurement'
  | 'governance'
  | 'creative'
  | 'sales'
  | 'buying'
  | 'signals';

export type BrandJsonResolverErrorCode =
  | 'invalid_url'
  | 'invalid_house'
  | 'redirect_loop'
  | 'redirect_depth_exceeded'
  | 'fetch_failed'
  | 'invalid_body'
  | 'schema_invalid'
  | 'agent_not_found'
  | 'agent_ambiguous'
  | 'jwks_origin_mismatch';

/**
 * Typed error surfaced by the resolver pipeline. Verifier callers can fold
 * these into `webhook_signature_key_unknown` (or treat ambiguous/schema
 * errors as config bugs) without parsing error message strings.
 */
export class BrandJsonResolverError extends Error {
  readonly code: BrandJsonResolverErrorCode;
  readonly recovery: 'terminal' | 'transient';
  override readonly cause?: unknown;
  /** HTTP status for `fetch_failed` responses, when a response was received. */
  readonly httpStatus?: number;
  constructor(
    code: BrandJsonResolverErrorCode,
    message: string,
    details: { httpStatus?: number; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'BrandJsonResolverError';
    this.code = code;
    this.httpStatus = details.httpStatus;
    this.cause = details.cause;
    this.recovery =
      code !== 'fetch_failed' || isPermanentDiscoveryFailure(classifyDiscoveryFailure(this)) ? 'terminal' : 'transient';
  }
}

export interface BrandJsonJwksResolverOptions {
  /** Expected agent URL. Prefer supplying it; legacy configurations infer one onboarding URL, then confirm it through capabilities and canonical matching. */
  agentUrl?: string;
  /** Capabilities transport. Defaults to MCP; A2A integrations must set 'a2a'. */
  protocol?: AgentProtocol;
  /** Enable the 3.x webhook-only domain-derived fallback. Default true. Request verification refuses these keys. */
  legacyWebhookFallback?: boolean;
  fetchCapabilities?: FetchCapabilitiesFn;
  /** Functional role of the agent whose keys we want to resolve. */
  agentType: BrandAgentType;
  /**
   * Agent id from `agents[].id`, used only to narrow canonical URL matches.
   */
  agentId?: string;
  /** @deprecated Used only to infer an onboarding URL when agentUrl is absent. Canonical verification searches all operator collections. */
  brandId?: string;
  /**
   * Minimum seconds between brand.json refetches. Mirrors the JWKS cooldown
   * and protects counterparties from being hammered by unknown-kid refreshes.
   * Default 30s (AdCP JWKS floor).
   */
  minCooldownSeconds?: number;
  /**
   * Absolute cap on how long a cached brand.json snapshot may be used before
   * a refetch is attempted, even if the counterparty's Cache-Control would
   * allow longer. Default 3600s (1 hour).
   */
  maxAgeSeconds?: number;
  /** @deprecated Only controls legacy onboarding indirection. Explicit capability URLs allow no redirects; webhook fallback allows one document hop. */
  maxRedirects?: number;
  /**
   * Allow `http://` / private-IP brand.json and JWKS URLs (dev loops only).
   * Default false. Forwarded to both the brand.json fetch and the inner
   * HttpsJwksResolver so a single flag unlocks the whole chain.
   */
  allowPrivateIp?: boolean;
  /**
   * DNS resolver used for both brand.json and JWKS fetches. Every returned
   * address remains subject to SSRF classification and connection pinning.
   */
  lookup?: SsrfDnsLookup;
  /** Existing settings remain accepted. maxAgeSeconds/minCooldownSeconds configure caching; protocol floors and fail-closed behavior replace other settings. */
  jwksOptions?: Omit<HttpsJwksResolverOptions, 'allowPrivateIp' | 'lookup' | 'now'>;
  /** Clock override for deterministic tests. Returns epoch seconds. */
  now?: () => number;
}

const DEFAULT_MIN_COOLDOWN_SECONDS = 30;
const DEFAULT_MAX_AGE_SECONDS = 3600;
const DEFAULT_MAX_REDIRECTS = 3;
const BARE_HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Confirmed operator mapping. The supplied brand.json URL must agree with
 * capabilities on every cache refresh. Prefer ResolvedAgentJwksResolver
 * when the application's onboarding record holds only the seller URL.
 */
export class BrandJsonJwksResolver implements JwksResolver {
  private resolver?: ResolvedAgentJwksResolver;
  private onboarding?: Promise<ResolvedAgentJwksResolver>;
  private lastOnboardingAttempt = Number.NEGATIVE_INFINITY;
  private lastOnboardingError?: unknown;
  constructor(
    private readonly brandJsonUrl: string,
    private readonly options: BrandJsonJwksResolverOptions
  ) {
    for (const lifetime of [options.maxAgeSeconds, options.jwksOptions?.maxAgeSeconds]) {
      if (lifetime !== undefined && (!Number.isFinite(lifetime) || lifetime <= 0))
        throw new TypeError('maxAgeSeconds must be a finite positive number.');
    }
    for (const cooldown of [options.minCooldownSeconds, options.jwksOptions?.minCooldownSeconds]) {
      if (cooldown !== undefined && (!Number.isFinite(cooldown) || cooldown < 0))
        throw new TypeError('minCooldownSeconds must be a finite non-negative number.');
    }
    if (options.agentUrl !== undefined) this.resolver = this.createResolver(options.agentUrl, brandJsonUrl);
  }
  private createResolver(agentUrl: string, operatorUrl: string): ResolvedAgentJwksResolver {
    const options = this.options;
    return new ResolvedAgentJwksResolver(agentUrl, options.protocol ?? 'mcp', {
      agentType: options.agentType,
      agentId: options.agentId,
      expectedBrandJsonUrl: operatorUrl,
      fetchCapabilities: options.fetchCapabilities,
      legacyWebhookFallback: options.legacyWebhookFallback ?? true,
      allowPrivateIp: options.allowPrivateIp,
      lookup: options.lookup,
      now: options.now,
      cacheTtlSeconds: Math.min(
        options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
        options.jwksOptions?.maxAgeSeconds ?? 1800
      ),
      unknownKidCooldownSeconds:
        options.minCooldownSeconds ?? options.jwksOptions?.minCooldownSeconds ?? DEFAULT_MIN_COOLDOWN_SECONDS,
    });
  }
  private async confirmedResolver(): Promise<ResolvedAgentJwksResolver> {
    if (this.resolver) return this.resolver;
    if (this.onboarding) return this.onboarding;
    const now = this.options.now?.() ?? Date.now() / 1000;
    // Negative onboarding attempts use the fixed protocol backoff, independently
    // of the configurable positive-cache and unknown-kid refresh intervals.
    if (now - this.lastOnboardingAttempt < 30)
      throw (
        this.lastOnboardingError ??
        new BrandJsonResolverError('fetch_failed', 'Operator onboarding discovery is in its retry cooldown.')
      );
    this.lastOnboardingAttempt = now;
    this.onboarding = (async () => {
      const record = await fetchBrandJson({
        startUrl: this.brandJsonUrl,
        maxRedirects: this.options.maxRedirects,
        allowPrivateIp: this.options.allowPrivateIp,
        lookup: this.options.lookup,
      });
      // This is an onboarding shortcut from trusted configuration, not a key
      // selector. No key from this document is accepted until resolveAgent
      // confirms the agent -> operator mapping and canonical URL match.
      const agentUrl = inferOnboardingAgentUrl(record.data, this.options);
      const resolver = this.createResolver(agentUrl, record.finalUrl);
      await resolver.forceRefresh();
      this.resolver = resolver;
      this.lastOnboardingError = undefined;
      return resolver;
    })()
      .catch(error => {
        this.lastOnboardingError = error;
        throw error;
      })
      .finally(() => {
        this.onboarding = undefined;
      });
    return this.onboarding;
  }
  async resolve(keyid: string): Promise<AdcpJsonWebKey | null> {
    return (await this.confirmedResolver()).resolve(keyid);
  }
  async resolveWithMetadata(keyid: string): Promise<JwksResolution> {
    return (await this.confirmedResolver()).resolveWithMetadata(keyid);
  }
  get agentUrl(): string | undefined {
    return this.resolver?.resolvedAgentUrl;
  }
  async forceRefresh(): Promise<void> {
    if (this.resolver) await this.resolver.forceRefresh();
    else await this.confirmedResolver();
  }
}

/** Preserve legacy onboarding selectors, then pin their unique canonical URL. */
function inferOnboardingAgentUrl(document: unknown, selector: BrandJsonJwksResolverOptions): string {
  const record = document as Record<string, unknown>;
  const candidates = (agents: unknown): string[] =>
    !Array.isArray(agents)
      ? []
      : agents
          .filter(
            entry =>
              entry?.type === selector.agentType &&
              (selector.agentId === undefined || entry.id === selector.agentId) &&
              typeof entry.url === 'string'
          )
          .flatMap(entry => {
            try {
              return [canonicalAgentUrl(entry.url)];
            } catch {
              return [];
            }
          });
  let urls: string[];
  if (isPortfolioHouse(record.house)) {
    const house = record.house as Record<string, unknown>;
    urls = [];
    if (selector.brandId !== undefined && Array.isArray(record.brands)) {
      const brands = record.brands.filter(brand => brand?.id === selector.brandId);
      if (brands.length > 1)
        throw new BrandJsonResolverError('agent_ambiguous', 'Onboarding brand selector is ambiguous.');
      urls = candidates(brands[0]?.agents);
    }
    if (urls.length === 0) urls = candidates(house.agents);
  } else urls = candidates(record.agents);
  const unique = [...new Set(urls)];
  if (unique.length !== 1)
    throw new BrandJsonResolverError(
      unique.length === 0 ? 'agent_not_found' : 'agent_ambiguous',
      'Onboarding must identify exactly one agent URL; supply agentUrl explicitly.'
    );
  return unique[0]!;
}

export interface FetchedBrandJson {
  status: 'ok' | 'not_modified';
  finalUrl: string;
  data: unknown;
  etag?: string;
  cacheControl?: string;
}

export interface FetchBrandJsonOptions {
  /** Entry-point URL. HTTPS and public addresses are required by default. */
  startUrl: string;
  /** ETag sent only to the entry URL for cache revalidation. */
  currentEtag?: string;
  /** Initial domain-derived fetch may redirect only between host and exact www counterpart. */
  domainDerived?: boolean;
  /** Maximum JSON-level `authoritative_location` / `house` hops. Default 3, hard maximum 10. */
  maxRedirects?: number;
  /** Permit HTTP and private addresses for controlled development environments. */
  allowPrivateIp?: boolean;
  /** DNS resolver forwarded to every SSRF-safe fetch in the redirect chain. */
  lookup?: SsrfDnsLookup;
  /** Whole-request deadline per hop. Default and hard maximum 10 seconds. */
  timeoutMs?: number;
  /** Response-body cap per hop. Default and hard maximum 256 KiB. */
  maxBodyBytes?: number;
}

const MAX_BRAND_JSON_TIMEOUT_MS = 10_000;
const MAX_BRAND_JSON_BODY_BYTES = 262_144;
const MAX_BRAND_JSON_REDIRECTS = 10;

/**
 * Fetch brand.json from `startUrl`, following `authoritative_location` and
 * `house` string redirect variants up to `maxRedirects` hops. Each hop goes
 * through the SSRF-safe fetch primitive so an attacker-supplied chain can't
 * land on a private address or IMDS. Redirect targets are structurally
 * validated before dispatch — an attacker-controlled brand.json that emits
 * `{"house": "evil.com\\@victim.com"}` or `{"authoritative_location":
 * "http://169.254.169.254/..."}` is rejected at parse time rather than
 * relying on `ssrfSafeFetch` to catch every pathological shape.
 *
 * This low-level function is intentionally stateless. Callers MUST add
 * response caching and a minimum refresh cooldown rather than invoking it on
 * every authorization request. Prefer `BrandJsonJwksResolver` when resolving
 * signing keys; it provides both safeguards.
 */
export async function fetchBrandJson(args: FetchBrandJsonOptions): Promise<FetchedBrandJson> {
  const maxRedirects = boundedIntegerOption('maxRedirects', args.maxRedirects ?? DEFAULT_MAX_REDIRECTS, {
    min: 0,
    max: MAX_BRAND_JSON_REDIRECTS,
  });
  const timeoutMs = boundedIntegerOption('timeoutMs', args.timeoutMs ?? MAX_BRAND_JSON_TIMEOUT_MS, {
    min: 1,
    max: MAX_BRAND_JSON_TIMEOUT_MS,
  });
  const maxBodyBytes = boundedIntegerOption('maxBodyBytes', args.maxBodyBytes ?? MAX_BRAND_JSON_BODY_BYTES, {
    min: 1,
    max: MAX_BRAND_JSON_BODY_BYTES,
  });
  const allowPrivateIp = args.allowPrivateIp === true;
  const seen = new Set<string>();
  let url = canonicalizeUrl(args.startUrl, allowPrivateIp);

  const initial = new URL(url);
  let httpRedirects = 0;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (seen.has(url)) {
      throw new BrandJsonResolverError('redirect_loop', `brand.json redirect loop detected`);
    }
    seen.add(url);

    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    // Only attach If-None-Match on the entry URL: a 304 short-circuits the
    // whole chain, so revalidating a deeper hop with a stale ETag would be
    // a lie about the redirect target.
    if (hop === 0 && args.currentEtag) headers['if-none-match'] = args.currentEtag;

    let res: Awaited<ReturnType<typeof ssrfSafeFetch>>;
    try {
      res = await ssrfSafeFetch(url, {
        method: 'GET',
        headers,
        allowPrivateIp,
        lookup: args.lookup,
        timeoutMs,
        maxBodyBytes,
      });
    } catch (cause) {
      throw new BrandJsonResolverError('fetch_failed', 'Unable to fetch brand.json', { cause });
    }

    if (args.domainDerived && hop === 0 && [301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.location;
      if (!location || httpRedirects++ >= 3)
        throw new BrandJsonResolverError('fetch_failed', 'Invalid domain-derived redirect');
      const target = new URL(location, url);
      const baseHost = initial.hostname.startsWith('www.') ? initial.hostname.slice(4) : initial.hostname;
      if (
        (target.hostname !== baseHost && target.hostname !== `www.${baseHost}`) ||
        target.port !== initial.port ||
        target.protocol !== initial.protocol ||
        target.username ||
        target.password
      ) {
        throw new BrandJsonResolverError('invalid_url', 'brand.json redirect leaves its original host/www boundary');
      }
      url = canonicalizeUrl(target.href, allowPrivateIp);
      hop--;
      continue;
    }
    if (hop === 0 && res.status === 304) {
      return {
        status: 'not_modified',
        finalUrl: url,
        data: null,
        ...(res.headers['etag'] && { etag: res.headers['etag'] }),
        ...(res.headers['cache-control'] && { cacheControl: res.headers['cache-control'] }),
      };
    }
    if (res.status !== 200) {
      throw new BrandJsonResolverError('fetch_failed', `brand.json fetch returned HTTP ${res.status}`, {
        httpStatus: res.status,
      });
    }

    const text = Buffer.from(res.body).toString('utf8');
    let parsed: unknown;
    try {
      parsed = parseStrictJson(text);
    } catch {
      throw new BrandJsonResolverError('invalid_body', `brand.json response is not valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new BrandJsonResolverError('invalid_body', `brand.json response is not an object`);
    }

    const obj = parsed as Record<string, unknown>;
    const authoritative = typeof obj.authoritative_location === 'string' ? obj.authoritative_location : undefined;
    const house = typeof obj.house === 'string' ? obj.house : undefined;

    if (authoritative !== undefined) {
      if (hop === maxRedirects) {
        throw new BrandJsonResolverError('redirect_depth_exceeded', `brand.json redirect depth exceeded`);
      }
      url = canonicalizeUrl(authoritative, allowPrivateIp);
      continue;
    }
    if (house !== undefined) {
      // The "house string" redirect variant: a bare domain pointing at the
      // authoritative portfolio. Reject anything that isn't a bare hostname
      // so an attacker can't inject userinfo, paths, or ports via the
      // interpolation.
      if (!BARE_HOSTNAME.test(house)) {
        throw new BrandJsonResolverError('invalid_house', `brand.json "house" is not a bare hostname`);
      }
      if (hop === maxRedirects) {
        throw new BrandJsonResolverError('redirect_depth_exceeded', `brand.json redirect depth exceeded`);
      }
      url = canonicalizeUrl(`https://${house}/.well-known/brand.json`, allowPrivateIp);
      continue;
    }

    // Narrow shape validation on the terminal document. Full BrandJsonSchema
    // validation is stricter than we need (it enforces `^https://` on URLs,
    // which ssrfSafeFetch already polices) and fails too readily on trailing
    // portfolio fields the resolver doesn't touch. What we MUST reject: a
    // document whose shape would let an attacker smuggle a non-string url or
    // jwks_uri past the selector.
    assertBrandJsonShape(obj);

    return {
      status: 'ok',
      finalUrl: url,
      data: obj,
      ...(res.headers['etag'] && { etag: res.headers['etag'] }),
      ...(res.headers['cache-control'] && { cacheControl: res.headers['cache-control'] }),
    };
  }

  throw new BrandJsonResolverError('redirect_depth_exceeded', `brand.json redirect depth exceeded`);
}

function boundedIntegerOption(name: string, value: number, bounds: { min: number; max: number }): number {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new TypeError(`fetchBrandJson: ${name} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

/**
 * Structurally validate a URL and return it in a canonical form for the
 * loop-detection `Set`. Rejects URLs that `ssrfSafeFetch` would later refuse
 * anyway — but catching them here gives a clearer error code and prevents
 * a malformed `authoritative_location` from silently bypassing the hop cap
 * because its string form differed from a prior seen URL.
 */
function canonicalizeUrl(raw: string, allowPrivateIp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrandJsonResolverError('invalid_url', `brand.json URL is malformed`);
  }
  if (parsed.username || parsed.password) {
    throw new BrandJsonResolverError('invalid_url', `brand.json URL must not include userinfo`);
  }
  if (parsed.protocol !== 'https:' && !(allowPrivateIp && parsed.protocol === 'http:')) {
    throw new BrandJsonResolverError('invalid_url', `brand.json URL must use https://`);
  }
  // Fragments are not sent on the wire and must not smuggle loop-detection
  // aliases — strip them before stashing in `seen`.
  parsed.hash = '';
  return parsed.toString();
}

function isPortfolioHouse(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * Walk every `agents[]` array we might consult and reject entries where
 * `url` or `jwks_uri` are present but non-string. A permissive walk here
 * catches a malformed document that `pickAgent` would otherwise silently
 * skip (a non-string url gets filtered out, so an attacker who declares
 * two agents of a type — one well-formed and one with a poisoned shape —
 * couldn't change the selector outcome, but schema-invalid payloads are
 * still a strong signal of compromise).
 */
function assertBrandJsonShape(obj: Record<string, unknown>): void {
  const queues: unknown[] = [obj.agents];
  if (isPortfolioHouse(obj.house)) {
    const house = obj.house as Record<string, unknown>;
    queues.push(house.agents);
    if (Array.isArray(obj.brands)) {
      for (const brand of obj.brands as Record<string, unknown>[]) {
        if (brand) queues.push(brand.agents);
      }
    }
  }
  for (const q of queues) {
    if (q === undefined) continue;
    if (!Array.isArray(q)) {
      throw new BrandJsonResolverError('schema_invalid', 'brand.json `agents` must be an array');
    }
    for (const entry of q) {
      if (entry && typeof entry === 'object') {
        const e = entry as AgentEntry;
        if (e.url !== undefined && typeof e.url !== 'string') {
          throw new BrandJsonResolverError('schema_invalid', 'brand.json agent.url must be a string');
        }
        if (e.jwks_uri !== undefined && typeof e.jwks_uri !== 'string') {
          throw new BrandJsonResolverError('schema_invalid', 'brand.json agent.jwks_uri must be a string');
        }
      }
    }
  }
}

/** An agent entry as declared in brand.json `agents[]`. */
interface AgentEntry {
  type?: string;
  url?: string;
  id?: string;
  jwks_uri?: string;
}
