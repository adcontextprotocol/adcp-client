/**
 * Receiver-side ergonomic: resolve a sender's JWKS by fetching their
 * `brand.json`, extracting the `jwks_uri` for the agent whose webhooks we're
 * verifying, and delegating to {@link HttpsJwksResolver}.
 *
 * Hand the resulting instance to `verifyWebhookSignature.jwks` (or
 * `verifyRequestSignature.jwks`) and the receiver never has to know where the
 * sender hosts their keys — brand.json is the single source of truth.
 *
 * Follows the two documented redirect variants of `brand.json`
 * (`authoritative_location` and `house`) up to a caller-configurable hop
 * depth. When the selected agent has no `jwks_uri`, falls back to
 * `/.well-known/jwks.json` on the origin of the agent's `url` — but only
 * when that origin matches the final brand.json origin. The spec's
 * well-known fallback exists so publishers hosting brand.json and their
 * agents on the same origin can skip the explicit `jwks_uri`; accepting a
 * cross-origin fallback would let an attacker pivot the trust anchor to a
 * controlled host with a permissive JWKS.
 *
 * Caching is stacked with the inner {@link HttpsJwksResolver}: brand.json
 * honors its own `Cache-Control`/`ETag` (bounded by `maxAgeSeconds`), and
 * unknown-kid refreshes cascade — first to the JWKS endpoint, then (if the
 * JWKS still doesn't have the kid and the brand.json cooldown has elapsed) to
 * brand.json itself, in case the sender rotated `jwks_uri`.
 */
import { ssrfSafeFetch } from '../net';
import type { JwksResolver } from './jwks';
import { HttpsJwksResolver, type HttpsJwksResolverOptions } from './jwks-https';
import type { AdcpJsonWebKey } from './types';

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
  constructor(code: BrandJsonResolverErrorCode, message: string) {
    super(message);
    this.name = 'BrandJsonResolverError';
    this.code = code;
  }
}

export interface BrandJsonJwksResolverOptions {
  /** Functional role of the agent whose keys we want to resolve. */
  agentType: BrandAgentType;
  /**
   * Agent id from `agents[].id`. Required when brand.json declares more than
   * one agent of the requested type (otherwise the selector is ambiguous).
   * Optional when the type is unique.
   */
  agentId?: string;
  /**
   * Brand id within a house portfolio (`brands[].id`). When omitted on a
   * portfolio brand.json, the resolver looks at `house.agents[]`. When set,
   * the resolver looks at `brands[brandId].agents[]` first and falls back to
   * `house.agents[]` if no agent of the requested type is declared on the
   * brand itself.
   */
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
  /**
   * Maximum redirect hops to follow through `authoritative_location` /
   * `house` variants. Default 3 — enough for `authoritative_location → house
   * → portfolio` without inviting loops.
   */
  maxRedirects?: number;
  /**
   * Allow `http://` / private-IP brand.json and JWKS URLs (dev loops only).
   * Default false. Forwarded to both the brand.json fetch and the inner
   * HttpsJwksResolver so a single flag unlocks the whole chain.
   */
  allowPrivateIp?: boolean;
  /**
   * Forwarded to the inner {@link HttpsJwksResolver} constructor.
   * `allowPrivateIp` and `now` are set from the outer options and should not
   * be passed here.
   */
  jwksOptions?: Omit<HttpsJwksResolverOptions, 'allowPrivateIp' | 'now'>;
  /** Clock override for deterministic tests. Returns epoch seconds. */
  now?: () => number;
}

interface BrandSnapshot {
  /** The JWKS URL we resolved from the brand.json agent entry. */
  jwksUri: string;
  /** The agent's `url` — stable result attribution for verified webhooks. */
  agentUrl: string;
  etag?: string;
  fetchedAt: number;
  expiresAt: number;
}

interface SelectedAgent {
  url: string;
  jwksUri: string;
}

const DEFAULT_MIN_COOLDOWN_SECONDS = 30;
const DEFAULT_MAX_AGE_SECONDS = 3600;
const DEFAULT_MAX_REDIRECTS = 3;

// Bare hostname pattern: lowercase labels separated by dots, no userinfo,
// no path, no control characters. Matches the `house` domain regex used in
// the brand.json schema (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]…)*$`).
const BARE_HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * JWKS resolver backed by a sender's `brand.json`. Construct one per
 * counterparty (or keyed by `brand.json` URL + agent selector) and hand it to
 * the webhook/request verifier as the `jwks` dependency.
 */
export class BrandJsonJwksResolver implements JwksResolver {
  private readonly url: string;
  private readonly selector: {
    agentType: BrandAgentType;
    agentId?: string;
    brandId?: string;
  };
  private readonly minCooldown: number;
  private readonly maxAge: number;
  private readonly maxRedirects: number;
  private readonly allowPrivateIp: boolean;
  private readonly jwksOptions: Omit<HttpsJwksResolverOptions, 'allowPrivateIp' | 'now'>;
  private readonly now: () => number;
  private snapshot: BrandSnapshot | undefined;
  private inner: HttpsJwksResolver | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(brandJsonUrl: string, options: BrandJsonJwksResolverOptions) {
    this.url = brandJsonUrl;
    this.selector = {
      agentType: options.agentType,
      ...(options.agentId !== undefined && { agentId: options.agentId }),
      ...(options.brandId !== undefined && { brandId: options.brandId }),
    };
    this.minCooldown = options.minCooldownSeconds ?? DEFAULT_MIN_COOLDOWN_SECONDS;
    this.maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.allowPrivateIp = options.allowPrivateIp ?? false;
    this.jwksOptions = options.jwksOptions ?? {};
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Resolve a JWK by `kid`. On a cold cache, fetches brand.json first; on an
   * expired brand.json snapshot, refreshes respecting the cooldown. Unknown
   * kids cascade: first ask the inner HttpsJwksResolver (which will refetch
   * its own URL if cooldown has elapsed); if still unknown, refresh
   * brand.json in case `jwks_uri` rotated.
   */
  async resolve(keyid: string): Promise<AdcpJsonWebKey | null> {
    if (!this.snapshot || !this.inner) {
      await this.refresh();
    } else if (this.now() > this.snapshot.expiresAt && this.now() - this.snapshot.fetchedAt >= this.minCooldown) {
      await this.refresh().catch(() => {
        /* keep stale on transient failure */
      });
    }
    if (!this.inner) return null;

    const hit = await this.inner.resolve(keyid);
    if (hit) return hit;

    if (this.snapshot && this.now() - this.snapshot.fetchedAt >= this.minCooldown) {
      await this.refresh().catch(() => {
        /* keep stale on transient failure */
      });
      return this.inner ? this.inner.resolve(keyid) : null;
    }
    return null;
  }

  /**
   * The agent URL we resolved `jwks_uri` from. Populated after the first
   * successful refresh; useful for verifier result attribution
   * (`VerifyWebhookOptions.agentUrlForKeyid`).
   */
  get agentUrl(): string | undefined {
    return this.snapshot?.agentUrl;
  }

  /** Force a refetch of both brand.json and the inner JWKS, bypassing the cooldown. */
  async forceRefresh(): Promise<void> {
    this.snapshot = undefined;
    this.inner = undefined;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const fetched = await fetchBrandJson({
      startUrl: this.url,
      currentEtag: this.snapshot?.etag,
      maxRedirects: this.maxRedirects,
      allowPrivateIp: this.allowPrivateIp,
    });

    // 304 on the entry URL: extend the lifetime, keep the inner resolver.
    if (fetched.status === 'not_modified' && this.snapshot) {
      this.snapshot = {
        ...this.snapshot,
        ...(fetched.etag && { etag: fetched.etag }),
        fetchedAt: this.now(),
        expiresAt: this.now() + computeLifetime(fetched.cacheControl, this.maxAge),
      };
      return;
    }

    const agent = selectAgent(fetched.data, fetched.finalUrl, this.selector);

    if (!this.inner || this.snapshot?.jwksUri !== agent.jwksUri) {
      this.inner = new HttpsJwksResolver(agent.jwksUri, {
        ...this.jwksOptions,
        allowPrivateIp: this.allowPrivateIp,
        now: this.now,
      });
    }
    this.snapshot = {
      jwksUri: agent.jwksUri,
      agentUrl: agent.url,
      ...(fetched.etag && { etag: fetched.etag }),
      fetchedAt: this.now(),
      expiresAt: this.now() + computeLifetime(fetched.cacheControl, this.maxAge),
    };
  }
}

interface FetchedBrandJson {
  status: 'ok' | 'not_modified';
  finalUrl: string;
  data: unknown;
  etag?: string;
  cacheControl?: string;
}

/**
 * Fetch brand.json from `startUrl`, following `authoritative_location` and
 * `house` string redirect variants up to `maxRedirects` hops. Each hop goes
 * through the SSRF-safe fetch primitive so an attacker-supplied chain can't
 * land on a private address or IMDS. Redirect targets are structurally
 * validated before dispatch — an attacker-controlled brand.json that emits
 * `{"house": "evil.com\\@victim.com"}` or `{"authoritative_location":
 * "http://169.254.169.254/..."}` is rejected at parse time rather than
 * relying on `ssrfSafeFetch` to catch every pathological shape.
 */
async function fetchBrandJson(args: {
  startUrl: string;
  currentEtag?: string;
  maxRedirects: number;
  allowPrivateIp: boolean;
}): Promise<FetchedBrandJson> {
  const seen = new Set<string>();
  let url = canonicalizeUrl(args.startUrl, args.allowPrivateIp);

  for (let hop = 0; hop <= args.maxRedirects; hop++) {
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

    const res = await ssrfSafeFetch(url, {
      method: 'GET',
      headers,
      allowPrivateIp: args.allowPrivateIp,
    });

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
      throw new BrandJsonResolverError('fetch_failed', `brand.json fetch returned HTTP ${res.status}`);
    }

    const text = Buffer.from(res.body).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
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
      if (hop === args.maxRedirects) {
        throw new BrandJsonResolverError('redirect_depth_exceeded', `brand.json redirect depth exceeded`);
      }
      url = canonicalizeUrl(authoritative, args.allowPrivateIp);
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
      if (hop === args.maxRedirects) {
        throw new BrandJsonResolverError('redirect_depth_exceeded', `brand.json redirect depth exceeded`);
      }
      url = canonicalizeUrl(`https://${house}/.well-known/brand.json`, args.allowPrivateIp);
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

function selectAgent(
  data: unknown,
  finalBrandUrl: string,
  selector: { agentType: BrandAgentType; agentId?: string; brandId?: string }
): SelectedAgent {
  if (!data || typeof data !== 'object') {
    throw new BrandJsonResolverError(
      'agent_not_found',
      `brand.json has no agent matching ${describeSelector(selector)}`
    );
  }
  const obj = data as Record<string, unknown>;

  let picked: SelectedAgent | undefined;
  if (isPortfolioHouse(obj.house)) {
    const house = obj.house as Record<string, unknown>;
    if (selector.brandId !== undefined) {
      const brands = Array.isArray(obj.brands) ? (obj.brands as Record<string, unknown>[]) : [];
      const brand = brands.find(b => b && b.id === selector.brandId);
      if (brand) picked = pickAgent(brand.agents, finalBrandUrl, selector);
    }
    picked ??= pickAgent(house.agents, finalBrandUrl, selector);
  } else {
    picked = pickAgent(obj.agents, finalBrandUrl, selector);
  }

  if (!picked) {
    throw new BrandJsonResolverError(
      'agent_not_found',
      `brand.json has no agent matching ${describeSelector(selector)}`
    );
  }
  return picked;
}

function pickAgent(
  agents: unknown,
  finalBrandUrl: string,
  selector: { agentType: BrandAgentType; agentId?: string }
): SelectedAgent | undefined {
  if (!Array.isArray(agents)) return undefined;
  const matches = agents.filter((a): a is AgentEntry => {
    if (!a || typeof a !== 'object') return false;
    const e = a as AgentEntry;
    if (e.type !== selector.agentType) return false;
    if (selector.agentId !== undefined && e.id !== selector.agentId) return false;
    return typeof e.url === 'string';
  });
  if (matches.length === 0) return undefined;
  if (matches.length > 1 && selector.agentId === undefined) {
    throw new BrandJsonResolverError(
      'agent_ambiguous',
      `brand.json declares ${matches.length} agents of type "${selector.agentType}"; ` +
        `pass \`agentId\` to disambiguate (choices: ${matches.map(m => m.id ?? '<no-id>').join(', ')})`
    );
  }
  const agent = matches[0]!;
  const url = agent.url!;
  const jwksUri = agent.jwks_uri ?? defaultJwksUri(url, finalBrandUrl);
  return { url, jwksUri };
}

/**
 * Spec fallback: "When absent, verifiers MUST default to /.well-known/jwks.json
 * on the origin of `url`." We strip any path/query/fragment from the agent
 * URL and replace it with the well-known path.
 *
 * Security: require the agent origin to match the final brand.json origin.
 * Without this check, an attacker-controlled brand.json could set
 * `agent.url: "https://victim-internal.example/"` and force the verifier to
 * treat that origin's JWKS as authoritative — a cross-origin trust pivot.
 * Publishers that genuinely host their agent on a different origin from
 * their brand.json MUST declare an explicit `jwks_uri` (and that URI is
 * validated at fetch time by the inner HttpsJwksResolver, not here).
 */
function defaultJwksUri(agentUrl: string, finalBrandUrl: string): string {
  let agent: URL;
  try {
    agent = new URL(agentUrl);
  } catch {
    throw new BrandJsonResolverError('invalid_url', `agent.url is not a valid URL`);
  }
  const brand = new URL(finalBrandUrl);
  if (agent.origin !== brand.origin) {
    throw new BrandJsonResolverError(
      'jwks_origin_mismatch',
      `agent.url origin (${agent.origin}) does not match brand.json origin (${brand.origin}); ` +
        `publisher must declare an explicit jwks_uri for cross-origin agents`
    );
  }
  return `${agent.origin}/.well-known/jwks.json`;
}

function describeSelector(selector: { agentType: BrandAgentType; agentId?: string; brandId?: string }): string {
  const parts = [`type=${selector.agentType}`];
  if (selector.agentId !== undefined) parts.push(`id=${selector.agentId}`);
  if (selector.brandId !== undefined) parts.push(`brand=${selector.brandId}`);
  return parts.join(' ');
}

function computeLifetime(cacheControl: string | undefined, maxAge: number): number {
  if (!cacheControl) return maxAge;
  const lower = cacheControl.toLowerCase();
  if (/\bno-store\b|\bno-cache\b/.test(lower)) return 0;
  const match = /max-age\s*=\s*(\d+)/.exec(lower);
  if (match) {
    const serverMax = Number(match[1]);
    if (Number.isFinite(serverMax)) return Math.min(serverMax, maxAge);
  }
  return maxAge;
}
