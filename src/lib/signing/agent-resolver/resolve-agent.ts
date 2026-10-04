/**
 * `resolveAgent` — implementation of the 8-step brand_json_url discovery
 * algorithm defined in `security.mdx` §"Discovering an agent's signing
 * keys via `brand_json_url`". Given an agent URL `A` and (optionally)
 * the protocol it speaks, returns the resolved brand.json document, the
 * matched `agents[]` entry, the JWKS URI, the JWKS itself, and a per-step
 * trace.
 *
 * Composition with existing pieces:
 *   - Step 1 (capabilities fetch) goes through `ProtocolClient` via the
 *     `createMCPClient` / `createA2AClient` factories — never a raw HTTP
 *     GET on the agent URL. The spec is explicit: the agent URL is the
 *     protocol endpoint, not a JSON capabilities document.
 *   - Steps 4 / 8 (brand.json / JWKS fetches) go through `ssrfSafeFetch`
 *     with `maxRedirects: 0` (the spec forbids redirects on the
 *     bootstrap fetch — the `authoritative_location` carve-out is scoped
 *     to webhook receivers and MUST NOT be inherited here) and the
 *     strict-JSON parser (duplicate-key + prototype-property rejection).
 *
 * Error mapping:
 *   - All wire-shape rejections surface as `AgentResolverError` with a
 *     `request_signature_*` code matching the spec's rejection-code table.
 *   - Counterparty-controlled detail fields (`brand_json_url`,
 *     `matched_entries`, `parse_error`) are marked
 *     `attackerInfluencedFields` so admin-UI renderers know to escape.
 *   - SSRF refusals translate to a coarse `dns_error` classification —
 *     never the resolved IP or hostname-to-address mapping the underlying
 *     `SsrfRefusedError` carries.
 */

import { parse as parseTld } from 'tldts';
import { isIP } from 'node:net';

import { createA2AClient, createMCPClient } from '../../protocols';
import { isDevelopmentBrandDomain } from '../../brand/domain';
import type { IdentityKeyOriginPurpose, IdentityPosture } from './capabilities-types';
import { readBrandJsonUrl, readIdentityPosture } from './capabilities-types';
import { isAlwaysBlocked, isPrivateIp, type SsrfDnsLookup } from '../../net';
import { AgentTransportPolicyError, createAgentTransportFetch } from '../../net/agent-transport-fetch';
import { checkDelegatedOperatorAuthorization } from './operator-authorization';
import { fetchLegacyBrandJson } from './legacy-brand';
import {
  checkOriginConsistency,
  checkRequiredOrigins,
  declaredSigningPurposes,
  type ConsistencyResult,
} from './consistency';
import { AgentResolverError, type AgentResolverErrorDetail } from './errors';
import { eTldPlusOne, sameEtldPlusOne } from './etld';
import {
  MAX_BRAND_JSON_BYTES,
  MAX_JWKS_BYTES,
  safeFetchJson,
  SafeFetchError,
  classifyDiscoveryFailure,
  isPermanentDiscoveryFailure,
} from './fetch-helpers';
import { unwrapProtocolResponse } from '../protocol-response';
import { type AgentEntry, selectAgentByUrl, agentJwksUri, AgentSelectorError, canonicalAgentUrl } from './select-agent';

export type AgentProtocol = 'mcp' | 'a2a';

export type AuthorizedOperatorScope =
  | 'media_buying'
  | 'creative_generation'
  | 'rights_clearance'
  | 'governance'
  | 'measurement'
  | 'agent_operations';

/**
 * Trusted local context selecting one delegated-operator authorization tuple.
 * This is receiver policy, never counterparty-supplied wire data.
 */
export interface DelegatedOperatorAuthorizationContext {
  brand?: string;
  scope?: AuthorizedOperatorScope;
  country?: string;
}

export interface FetchCapabilitiesFn {
  (agentUrl: string): Promise<unknown>;
}

export interface ResolveAgentOptions {
  /** Default `'mcp'`. Ignored when `fetchCapabilities` is supplied. */
  protocol?: AgentProtocol;
  /** URL matching is mandatory; these filters may only narrow it. */
  expectedBrandJsonUrl?: string;
  agentType?: string;
  agentId?: string;
  /** Enable the 3.x webhook-only fallback when brand_json_url is absent. */
  legacyWebhookFallback?: boolean;
  lookup?: SsrfDnsLookup;
  /**
   * Override the capabilities-fetch step entirely. Tests pass a fake; production
   * callers who already hold a configured protocol client can wire it through
   * here rather than letting the resolver build a fresh transport.
   */
  fetchCapabilities?: FetchCapabilitiesFn;
  /**
   * Allow `http://` and private/loopback targets. Default false.
   *
   * Refused outside `{NODE_ENV=test, NODE_ENV=development}` unless the
   * adopter sets `ADCP_RESOLVER_ALLOW_PRIVATE_IP=1` as an explicit ops
   * acknowledgment — a security-critical entry point should fail closed
   * when the carve-out gets wired from a misconfigured env var. Matches
   * the project pattern around `createAdcpServer`'s in-memory-state and
   * `tenant-registry`'s NODE_ENV allowlist.
   */
  allowPrivateIp?: boolean;
  /**
   * Body caps for the brand.json + JWKS fetches. Default: brand.json 256 KiB,
   * JWKS 64 KiB — the budgets recommended by `security.mdx` §"Quickstart".
   * The capabilities-fetch cap is enforced upstream by `ProtocolClient`'s
   * own response-size limit; it is not configurable here.
   */
  bodyCaps?: { brandJsonBytes?: number; jwksBytes?: number };
  /** Total per-fetch timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /**
   * Purposes the caller knows the agent is signing for but that aren't
   * inferable from a generic capabilities walk (governance-signing,
   * TMP-signing). Joined with the auto-detected set before the
   * `key_origins` missing check.
   */
  declaredPurposes?: readonly IdentityKeyOriginPurpose[];
  /**
   * @deprecated Publisher pins never skip origin consistency. Ignored.
   */
  publisherPinned?: { webhook_signing?: boolean };
  /** Override the current time (epoch seconds) — for deterministic tests. */
  now?: () => number;
  /**
   * Brand authorization required from a cross-origin `authorized_operators[]`
   * entry. Constrained brand lists fail closed when this context is omitted;
   * `brands: ['*']` remains a context-free broad grant.
   */
  requiredOperatorBrand?: string;
  /**
   * Activity authorization required from a cross-origin operator entry.
   * Omitted `scopes` and `scopes: ['all']` are broad grants. A narrower list
   * fails closed when this context is omitted.
   */
  requiredOperatorScope?: AuthorizedOperatorScope;
  /**
   * ISO 3166-1 alpha-2 country authorization required from a cross-origin
   * operator entry. Omitted `countries` is global; a present list fails closed
   * when this context is omitted.
   */
  requiredOperatorCountry?: string;
}

export interface TraceStep {
  step: number;
  name: string;
  ok: boolean;
  fetchedAt?: number;
  ageSeconds?: number;
  url?: string;
  detail?: Record<string, unknown> | AgentResolverErrorDetail;
}

export interface AgentResolution {
  agentUrl: string;
  brandJsonUrl: string;
  /** Exact selected operator record; use it for signed-buyer governance. */
  brandJson?: unknown;
  brandJsonCacheControl?: string;
  /** True only on the explicitly enabled 3.x webhook compatibility path. */
  legacyWebhookFallback?: boolean;
  agentEntry: AgentEntry;
  jwksUri: string;
  jwks: { keys: ReadonlyArray<Record<string, unknown>> };
  identityPosture: IdentityPosture | undefined;
  consistency:
    | { ok: true }
    | {
        ok: false;
        results: ReadonlyArray<ConsistencyResult>;
      };
  freshness: {
    capabilitiesFetchedAt: number;
    brandJsonFetchedAt: number;
    jwksFetchedAt: number;
  };
  /** `Cache-Control` header from the JWKS fetch, when the response carried one. */
  jwksCacheControl?: string;
  /**
   * Epoch seconds when the cross-origin operator delegation stops authorizing
   * this resolution. Built-in JWKS caches cap their lifetime at this boundary.
   */
  operatorAuthorizationValidUntil?: number;
  trace: ReadonlyArray<TraceStep>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function resolveAgent(agentUrl: string, options: ResolveAgentOptions = {}): Promise<AgentResolution> {
  const trace: TraceStep[] = [];
  const now = options.now ?? (() => Date.now() / 1000);
  const allowPrivateIp = checkAllowPrivateIp(options.allowPrivateIp === true);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const caps = options.bodyCaps ?? {};
  const brandJsonCap = caps.brandJsonBytes ?? MAX_BRAND_JSON_BYTES;
  const jwksCap = caps.jwksBytes ?? MAX_JWKS_BYTES;

  // ─── Step 1: fetch capabilities at the protocol layer ─────────────────
  const fetchCapabilities =
    options.fetchCapabilities ??
    defaultFetchCapabilities(agentUrl, options.protocol ?? 'mcp', allowPrivateIp, timeoutMs);
  let capabilitiesPayload: unknown;
  let capabilitiesFetchedAt: number;
  try {
    const raw = await fetchCapabilities(agentUrl);
    capabilitiesPayload = unwrapProtocolResponse(raw);
    capabilitiesFetchedAt = now();
    pushTrace(trace, {
      step: 1,
      name: 'fetch_capabilities',
      ok: true,
      fetchedAt: capabilitiesFetchedAt,
      url: agentUrl,
    });
  } catch (err) {
    const detail: AgentResolverErrorDetail = {
      agent_url: agentUrl,
      ...classifyDiscoveryFailure(err),
      last_attempt_at: now(),
    };
    pushTrace(trace, { step: 1, name: 'fetch_capabilities', ok: false, url: agentUrl, detail });
    throw new AgentResolverError(
      'request_signature_capabilities_unreachable',
      `Capabilities fetch failed for ${agentUrl}`,
      detail,
      ['agent_url']
    );
  }

  // ─── Step 2: read identity.brand_json_url ─────────────────────────────
  let brandJsonUrl = readBrandJsonUrl(capabilitiesPayload);
  const identity = (capabilitiesPayload as { identity?: { brand_json_url?: unknown } } | null)?.identity;
  const legacyFallback =
    options.legacyWebhookFallback === true &&
    identity?.brand_json_url === undefined &&
    permitsLegacyWebhookDiscovery(capabilitiesPayload);
  if (legacyFallback) brandJsonUrl = `${new URL(agentUrl).origin}/.well-known/brand.json`;
  const identityPosture = readIdentityPosture(capabilitiesPayload);
  // Spec mandates `https://`; dev/test deployments setting `allowPrivateIp`
  // are also allowed `http://` (matches the parallel carve-out in
  // `ssrfSafeFetch` and `BrandJsonJwksResolver` for loopback testing).
  const acceptsScheme = (url: string | undefined): url is string => {
    if (!url) return false;
    if (url.startsWith('https://')) return true;
    if (allowPrivateIp && url.startsWith('http://')) return true;
    return false;
  };
  if (!acceptsScheme(brandJsonUrl)) {
    const detail: AgentResolverErrorDetail = { agent_url: agentUrl };
    pushTrace(trace, { step: 2, name: 'read_brand_json_url', ok: false, detail });
    throw new AgentResolverError(
      'request_signature_brand_json_url_missing',
      `identity.brand_json_url is absent or not https on ${agentUrl}`,
      detail,
      ['agent_url']
    );
  }
  if (
    !legacyFallback &&
    options.expectedBrandJsonUrl !== undefined &&
    canonicalAgentUrl(brandJsonUrl) !== canonicalAgentUrl(options.expectedBrandJsonUrl)
  ) {
    throw new AgentResolverError(
      'request_signature_brand_origin_mismatch',
      'Cached operator mapping disagrees with identity.brand_json_url',
      { agent_url: agentUrl },
      ['agent_url']
    );
  }
  pushTrace(trace, { step: 2, name: 'read_brand_json_url', ok: true, detail: { brand_json_url: brandJsonUrl } });

  // ─── Step 3: eTLD+1 origin binding ────────────────────────────────────
  // IP-literal hosts have no PSL match; under `allowPrivateIp` (dev/test)
  // we fall back to bare hostname equality so loopback fixtures work without
  // standing up a public-name server. Production callers who don't set
  // `allowPrivateIp` will hit `request_signature_brand_origin_mismatch` on
  // an IP literal — which is the right answer: an agent advertising an IP
  // brand_json_url has no business being trusted at the wire.
  let agentEtld1 = '';
  let brandEtld1 = '';
  let sameOrigin = true;
  if (!legacyFallback) {
    try {
      agentEtld1 = eTldPlusOne(agentUrl);
      brandEtld1 = eTldPlusOne(brandJsonUrl);
      sameOrigin = sameEtldPlusOne(agentUrl, brandJsonUrl);
    } catch {
      if (allowPrivateIp) {
        const agentHost = new URL(agentUrl).hostname;
        const brandHost = new URL(brandJsonUrl).hostname;
        const agentIsExplicitDevelopmentHost =
          agentHost === 'localhost' ||
          isDevelopmentBrandDomain(agentHost) ||
          parseTld(agentHost, { extractHostname: false }).isIp;
        const brandIsExplicitDevelopmentHost =
          brandHost === 'localhost' ||
          isDevelopmentBrandDomain(brandHost) ||
          parseTld(brandHost, { extractHostname: false }).isIp;
        if (agentIsExplicitDevelopmentHost && brandIsExplicitDevelopmentHost) {
          agentEtld1 = agentHost;
          brandEtld1 = brandHost;
          sameOrigin = agentHost === brandHost;
        } else {
          const detail: AgentResolverErrorDetail = { agent_url: agentUrl, brand_json_url: brandJsonUrl };
          pushTrace(trace, { step: 3, name: 'etld1_binding', ok: false, detail });
          throw new AgentResolverError(
            'request_signature_brand_origin_mismatch',
            `Cannot compute eTLD+1 for agent or brand.json host`,
            detail,
            ['agent_url', 'brand_json_url']
          );
        }
      } else {
        const detail: AgentResolverErrorDetail = { agent_url: agentUrl, brand_json_url: brandJsonUrl };
        pushTrace(trace, { step: 3, name: 'etld1_binding', ok: false, detail });
        throw new AgentResolverError(
          'request_signature_brand_origin_mismatch',
          `Cannot compute eTLD+1 for agent or brand.json host`,
          detail,
          ['agent_url', 'brand_json_url']
        );
      }
    }
  }

  // ─── Step 4: fetch brand.json (no redirects, strict JSON) ─────────────
  let brandJson: unknown;
  let brandJsonFetchedAt: number;
  let brandJsonCacheControl: string | undefined;
  try {
    const fetchOptions = { allowPrivateIp, timeoutMs, maxBodyBytes: brandJsonCap, lookup: options.lookup };
    const fetched = legacyFallback
      ? await fetchLegacyBrandJson(agentUrl, fetchOptions)
      : await safeFetchJson(brandJsonUrl, 'brand.json', fetchOptions);
    if (legacyFallback && 'url' in fetched) brandJsonUrl = fetched.url as string;
    brandJsonCacheControl = fetched.headers['cache-control'];
    if (
      legacyFallback &&
      options.expectedBrandJsonUrl !== undefined &&
      canonicalAgentUrl(brandJsonUrl) !== canonicalAgentUrl(options.expectedBrandJsonUrl) &&
      canonicalAgentUrl(`${new URL(agentUrl).origin}/.well-known/brand.json`) !==
        canonicalAgentUrl(options.expectedBrandJsonUrl)
    ) {
      throw new AgentResolverError(
        'request_signature_brand_origin_mismatch',
        'Cached mapping disagrees with legacy discovery',
        { agent_url: agentUrl },
        ['agent_url']
      );
    }
    brandJson = fetched.body;
    brandJsonFetchedAt = fetched.fetchedAt;
    pushTrace(trace, {
      step: 4,
      name: 'fetch_brand_json',
      ok: true,
      fetchedAt: brandJsonFetchedAt,
      url: brandJsonUrl,
    });
  } catch (err) {
    if (err instanceof AgentResolverError) throw err;
    if (err instanceof SafeFetchError && /strict-JSON parse/.test(err.message)) {
      const detail: AgentResolverErrorDetail = {
        brand_json_url: brandJsonUrl,
        parse_error: err.message,
        last_attempt_at: now(),
      };
      pushTrace(trace, { step: 4, name: 'fetch_brand_json', ok: false, url: brandJsonUrl, detail });
      throw new AgentResolverError(
        'request_signature_brand_json_malformed',
        `brand.json failed strict-JSON parse`,
        detail,
        ['brand_json_url', 'parse_error']
      );
    }
    const transport = err instanceof SafeFetchError ? err.transport : 'fetch_failed';
    const detail: AgentResolverErrorDetail = {
      brand_json_url: brandJsonUrl,
      dns_error: transport,
      last_attempt_at: now(),
      ...(err instanceof SafeFetchError && err.httpStatus !== undefined && { http_status: err.httpStatus }),
    };
    pushTrace(trace, { step: 4, name: 'fetch_brand_json', ok: false, url: brandJsonUrl, detail });
    throw new AgentResolverError('request_signature_brand_json_unreachable', `brand.json fetch failed`, detail, [
      'brand_json_url',
    ]);
  }

  // Now run step 3's authorized_operators delegation check against the body.
  let operatorAuthorizationValidUntil: number | undefined;
  if (!sameOrigin) {
    const delegation = findAuthorizedOperator(brandJson, agentEtld1, now(), options);
    if (!delegation) {
      const detail: AgentResolverErrorDetail = {
        agent_url: agentUrl,
        agent_etld1: agentEtld1,
        brand_json_url_etld1: brandEtld1,
      };
      pushTrace(trace, { step: 3, name: 'etld1_binding', ok: false, detail });
      throw new AgentResolverError(
        'request_signature_brand_origin_mismatch',
        `Agent eTLD+1 ${agentEtld1} not delegated by brand.json authorized_operators[]`,
        detail,
        ['agent_url']
      );
    }
    // Explicit receiver policy is an additional account-authorization gate;
    // it never changes which operator record or signing keys identify A.
    if (
      options.requiredOperatorBrand !== undefined ||
      options.requiredOperatorScope !== undefined ||
      options.requiredOperatorCountry !== undefined
    ) {
      const authorization = checkDelegatedOperatorAuthorization(brandJson, agentEtld1, now(), options);
      if (!authorization)
        throw new AgentResolverError(
          'request_signature_brand_origin_mismatch',
          'Delegated operator does not satisfy the receiver account authorization policy',
          { agent_url: agentUrl },
          ['agent_url']
        );
      operatorAuthorizationValidUntil = authorization.validUntil;
    }
    pushTrace(trace, {
      step: 3,
      name: 'etld1_binding',
      ok: true,
      detail: { agent_etld1: agentEtld1, brand_json_url_etld1: brandEtld1, delegated_via_authorized_operators: true },
    });
  } else {
    pushTrace(trace, {
      step: 3,
      name: 'etld1_binding',
      ok: true,
      detail: { agent_etld1: agentEtld1, brand_json_url_etld1: brandEtld1 },
    });
  }

  // ─── Step 5: canonical agents[] selection ────────────────────────────
  let agentEntry: AgentEntry;
  try {
    agentEntry = selectAgentByUrl(brandJson, agentUrl, options);
    pushTrace(trace, { step: 5, name: 'select_agent', ok: true, detail: { url: agentEntry.url } });
  } catch (err) {
    if (err instanceof AgentSelectorError) {
      const detail: AgentResolverErrorDetail = { agent_url: agentUrl, brand_json_url: brandJsonUrl };
      const attacker: Array<keyof AgentResolverErrorDetail> = ['agent_url', 'brand_json_url'];
      let code: 'request_signature_agent_not_in_brand_json' | 'request_signature_brand_json_ambiguous';
      if (err.code === 'agent_not_in_brand_json') {
        code = 'request_signature_agent_not_in_brand_json';
      } else {
        code = 'request_signature_brand_json_ambiguous';
        if (err.detail.matched_count !== undefined) detail.matched_count = err.detail.matched_count;
        if (err.detail.matched_entries !== undefined) {
          detail.matched_entries = err.detail.matched_entries.map(e => ({
            url: e.url,
            ...(e.jwks_uri !== undefined && { jwks_uri: e.jwks_uri }),
          }));
          attacker.push('matched_entries');
        }
      }
      pushTrace(trace, { step: 5, name: 'select_agent', ok: false, detail });
      throw new AgentResolverError(code, err.message, detail, attacker);
    }
    throw new AgentResolverError(
      'request_signature_brand_json_malformed',
      'Matched agent has an invalid URL or JWKS source',
      { brand_json_url: brandJsonUrl },
      ['brand_json_url']
    );
  }

  // ─── Step 6: resolve jwks_uri ─────────────────────────────────────────
  const jwksUri = agentJwksUri(agentEntry);
  pushTrace(trace, { step: 6, name: 'resolve_jwks_uri', ok: true, detail: { jwks_uri: jwksUri } });

  // ─── Step 7: identity.key_origins consistency ─────────────────────────
  const consistencyResults = legacyFallback
    ? []
    : runConsistencyChecks({
        capabilitiesPayload,
        identityPosture,
        jwksUri,
        extraDeclaredPurposes: options.declaredPurposes ?? [],
      });

  const failedConsistency = consistencyResults.filter(r => r.ok === false);
  if (failedConsistency.length > 0) {
    const first = failedConsistency[0]!;
    const detail: AgentResolverErrorDetail = { purpose: first.purpose };
    if (first.code === 'key_origin_mismatch') {
      detail.expected_origin = first.expected_origin;
      detail.actual_origin = first.actual_origin;
      pushTrace(trace, { step: 7, name: 'key_origins_consistency', ok: false, detail });
      throw new AgentResolverError(
        'request_signature_key_origin_mismatch',
        `identity.key_origins.${first.purpose} mismatch`,
        detail
      );
    }
    detail.posture = first.posture;
    pushTrace(trace, { step: 7, name: 'key_origins_consistency', ok: false, detail });
    throw new AgentResolverError(
      'request_signature_key_origin_missing',
      `identity.key_origins.${first.purpose} declaration missing`,
      detail
    );
  }
  pushTrace(trace, { step: 7, name: 'key_origins_consistency', ok: true });

  // ─── Step 8 (preamble): fetch JWKS ────────────────────────────────────
  let jwks: { keys: ReadonlyArray<Record<string, unknown>> };
  let jwksFetchedAt: number;
  let jwksCacheControl: string | undefined;
  try {
    const fetched = await safeFetchJson(jwksUri, 'jwks', {
      allowPrivateIp,
      timeoutMs,
      maxBodyBytes: jwksCap,
      lookup: options.lookup,
    });
    if (
      !fetched.body ||
      typeof fetched.body !== 'object' ||
      !Array.isArray((fetched.body as { keys?: unknown }).keys)
    ) {
      throw new SafeFetchError('jwks', 'fetch_failed', 'JWKS document has no keys[] array');
    }
    jwks = fetched.body as { keys: ReadonlyArray<Record<string, unknown>> };
    jwksFetchedAt = fetched.fetchedAt;
    if (typeof fetched.headers['cache-control'] === 'string') {
      jwksCacheControl = fetched.headers['cache-control'];
    }
    pushTrace(trace, { step: 8, name: 'fetch_jwks', ok: true, fetchedAt: jwksFetchedAt, url: jwksUri });
  } catch (err) {
    const transport = err instanceof SafeFetchError ? err.transport : 'fetch_failed';
    const detail: AgentResolverErrorDetail = {
      jwks_uri: jwksUri,
      dns_error: transport,
      last_attempt_at: now(),
      ...(err instanceof SafeFetchError && err.httpStatus !== undefined && { http_status: err.httpStatus }),
    };
    pushTrace(trace, { step: 8, name: 'fetch_jwks', ok: false, url: jwksUri, detail });
    const code =
      transport === 'ssrf_refused' ? 'request_signature_jwks_untrusted' : 'request_signature_jwks_unavailable';
    throw new AgentResolverError(code, `JWKS fetch failed`, detail, ['jwks_uri']);
  }

  // A delegation can expire while brand.json/JWKS discovery is in flight.
  // Re-check at the trust-chain boundary so the first cache use cannot extend
  // authorization past the normative `valid_until` instant.
  if (operatorAuthorizationValidUntil !== undefined && now() >= operatorAuthorizationValidUntil) {
    const detail: AgentResolverErrorDetail = {
      agent_url: agentUrl,
      agent_etld1: agentEtld1,
      brand_json_url_etld1: brandEtld1,
    };
    throw new AgentResolverError(
      'request_signature_brand_origin_mismatch',
      `Agent delegation expired while resolving signing keys`,
      detail,
      ['agent_url']
    );
  }

  return {
    agentUrl: canonicalAgentUrl(agentEntry.url),
    brandJsonUrl,
    brandJson,
    ...(legacyFallback && { legacyWebhookFallback: true }),
    ...(brandJsonCacheControl !== undefined && { brandJsonCacheControl }),
    agentEntry,
    jwksUri,
    jwks,
    identityPosture,
    consistency: { ok: true },
    freshness: { capabilitiesFetchedAt, brandJsonFetchedAt, jwksFetchedAt },
    ...(jwksCacheControl !== undefined && { jwksCacheControl }),
    ...(operatorAuthorizationValidUntil !== undefined && { operatorAuthorizationValidUntil }),
    trace: trace.map(annotateAge(now())),
  };
}

/**
 * Refuse `allowPrivateIp: true` outside `{NODE_ENV=test, NODE_ENV=development}`
 * unless the adopter set `ADCP_RESOLVER_ALLOW_PRIVATE_IP=1`. The flag lifts
 * the spec's HTTPS-only / public-IP-only constraint to enable loopback test
 * fixtures; in production it would silently widen the SSRF surface, so we
 * close the door at the public API rather than relying on caller discipline.
 */
function checkAllowPrivateIp(requested: boolean): boolean {
  if (!requested) return false;
  const env = process.env.NODE_ENV;
  if (env === 'test' || env === 'development') return true;
  if (process.env.ADCP_RESOLVER_ALLOW_PRIVATE_IP === '1') return true;
  throw new Error(
    'resolveAgent: allowPrivateIp=true refused outside {NODE_ENV=test, NODE_ENV=development}. ' +
      'Set NODE_ENV appropriately for dev/test, or set ADCP_RESOLVER_ALLOW_PRIVATE_IP=1 as an ' +
      'explicit ops acknowledgment if you genuinely need private-IP discovery in this process.'
  );
}

function defaultFetchCapabilities(
  agentUrl: string,
  protocol: AgentProtocol,
  allowPrivateIp: boolean,
  timeoutMs: number
): FetchCapabilitiesFn {
  return async () => {
    const url = new URL(agentUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (
      (!allowPrivateIp && url.protocol !== 'https:') ||
      (isIP(hostname) && (isAlwaysBlocked(hostname) || (!allowPrivateIp && isPrivateIp(hostname))))
    )
      throw new AgentTransportPolicyError('Signing discovery URL refused by address or HTTPS policy.');
    let failure: Pick<AgentResolverErrorDetail, 'dns_error' | 'http_status'> | undefined;
    const upstream = createAgentTransportFetch(agentUrl, {
      allowPrivateIp,
      allowPrivateInitialOrigin: false,
      requireHttps: true,
    });
    let postSucceeded = false;
    const trustedFetchFn: typeof fetch = async (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      try {
        const response = await upstream(input, init);
        // Optional MCP GETs cannot change a successful POST's discovery cause.
        const isGet = method.toUpperCase() === 'GET';
        const observed =
          response.status >= 400 ? { dns_error: 'fetch_failed' as const, http_status: response.status } : undefined;
        if (protocol === 'mcp' && method.toUpperCase() === 'POST' && response.ok) postSucceeded = true;
        if (
          !(protocol === 'mcp' && isGet && (postSucceeded || response.status === 405)) &&
          !(
            isGet &&
            observed &&
            failure &&
            !isPermanentDiscoveryFailure(failure) &&
            isPermanentDiscoveryFailure(observed)
          )
        )
          failure = observed;
        return response;
      } catch (error) {
        if (!(protocol === 'mcp' && method.toUpperCase() === 'GET' && postSucceeded))
          failure = classifyDiscoveryFailure(error);
        throw error;
      }
    };
    const transport = { trustedFetchFn, requestTimeoutMs: timeoutMs };
    const client =
      protocol === 'a2a'
        ? createA2AClient(agentUrl, undefined, undefined, undefined, undefined, transport)
        : createMCPClient(agentUrl, undefined, undefined, undefined, undefined, transport);
    try {
      return await client.callTool('get_adcp_capabilities', {});
    } catch (error) {
      if (failure)
        throw new SafeFetchError(
          'capabilities',
          failure.dns_error as SafeFetchError['transport'],
          'Capabilities fetch failed',
          failure.http_status
        );
      throw error;
    }
  };
}

interface ActiveOperatorDelegation {
  validUntil?: number;
}

/** Origin binding is operator identity, separate from account authorization. */
function findAuthorizedOperator(
  brandJson: unknown,
  agentEtld1: string,
  _now: number,
  _options: ResolveAgentOptions
): ActiveOperatorDelegation | undefined {
  if (!brandJson || typeof brandJson !== 'object') return undefined;
  const obj = brandJson as Record<string, unknown>;
  if (!obj.house || typeof obj.house !== 'object' || Array.isArray(obj.house) || !Array.isArray(obj.brands)) {
    return undefined;
  }
  if (!Array.isArray(obj.authorized_operators)) return undefined;
  return obj.authorized_operators.some(op => op && typeof op === 'object' && op.domain === agentEtld1) ? {} : undefined;
}

function pushTrace(trace: TraceStep[], step: TraceStep): void {
  trace.push(step);
}

function annotateAge(now: number): (step: TraceStep) => TraceStep {
  return step => (step.fetchedAt !== undefined ? { ...step, ageSeconds: Math.max(0, now - step.fetchedAt) } : step);
}

interface ConsistencyArgs {
  capabilitiesPayload: unknown;
  identityPosture: IdentityPosture | undefined;
  jwksUri: string;
  extraDeclaredPurposes: readonly IdentityKeyOriginPurpose[];
}

function runConsistencyChecks(args: ConsistencyArgs): ConsistencyResult[] {
  const results: ConsistencyResult[] = [];
  const declared = declaredSigningPurposes(args.capabilitiesPayload, args.extraDeclaredPurposes);

  // Missing-origin check first — independent of jwksUri origin matching.
  for (const missing of checkRequiredOrigins(declared, args.identityPosture?.key_origins)) {
    results.push(missing);
  }

  // Origin-match check: walk every declared origin and compare against jwksUri
  // host. Skip publisher-pinned webhook-signing only.
  const keyOrigins = args.identityPosture?.key_origins;
  if (keyOrigins) {
    for (const purpose of Object.keys(keyOrigins) as IdentityKeyOriginPurpose[]) {
      const declaredOrigin = keyOrigins[purpose];
      if (!declaredOrigin) continue;
      const result = checkOriginConsistency({
        purpose,
        declaredOrigin,
        resolvedJwksUri: args.jwksUri,
      });
      if (result.ok === false) results.push(result);
    }
  }
  return results;
}

/** The missing-field compatibility exception ends at AdCP 4.0. */
function permitsLegacyWebhookDiscovery(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const caps = payload as { adcp_version?: unknown; adcp?: { supported_versions?: unknown; major_versions?: unknown } };
  const major = (value: unknown) => (typeof value === 'string' ? Number(/^(\d+)\./.exec(value)?.[1]) : value);
  if (
    Number(major(caps.adcp_version)) >= 4 ||
    (Array.isArray(caps.adcp?.supported_versions) && caps.adcp.supported_versions.some(v => Number(major(v)) >= 4)) ||
    (Array.isArray(caps.adcp?.major_versions) && caps.adcp.major_versions.some(v => typeof v === 'number' && v >= 4))
  )
    return false;
  if (caps.adcp_version !== undefined) return typeof caps.adcp_version === 'string' && /^3\./.test(caps.adcp_version);
  if (Array.isArray(caps.adcp?.supported_versions))
    return caps.adcp.supported_versions.some(v => typeof v === 'string' && /^3\./.test(v));
  if (Array.isArray(caps.adcp?.major_versions)) return caps.adcp.major_versions.includes(3);
  return true;
}
