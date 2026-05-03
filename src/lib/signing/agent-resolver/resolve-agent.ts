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

import { createA2AClient, createMCPClient } from '../../protocols';

import type { IdentityKeyOriginPurpose, IdentityPosture } from './capabilities-types';
import { readBrandJsonUrl, readIdentityPosture } from './capabilities-types';
import { canonicalizeOrigin } from './canonicalize';
import {
  checkOriginConsistency,
  checkRequiredOrigins,
  declaredSigningPurposes,
  type ConsistencyResult,
} from './consistency';
import { AgentResolverError, type AgentResolverErrorDetail } from './errors';
import { eTldPlusOne, sameEtldPlusOne } from './etld';
import { MAX_BRAND_JSON_BYTES, MAX_JWKS_BYTES, safeFetchJson, SafeFetchError } from './fetch-helpers';
import { unwrapProtocolResponse } from '../protocol-response';
import { type AgentEntry, selectAgentByUrl, AgentSelectorError } from './select-agent';

export type AgentProtocol = 'mcp' | 'a2a';

export interface FetchCapabilitiesFn {
  (agentUrl: string): Promise<unknown>;
}

export interface ResolveAgentOptions {
  /** Default `'mcp'`. Ignored when `fetchCapabilities` is supplied. */
  protocol?: AgentProtocol;
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
   * Sell-side webhook publisher pin marker — when `webhook_signing` is
   * `true`, the step-7 origin-consistency check is skipped for the
   * webhook-signing purpose only (operator-side webhook-signing remains
   * checked). Buyer-side / receive-side verifiers MUST leave this unset.
   */
  publisherPinned?: { webhook_signing?: boolean };
  /** Override the current time (epoch seconds) — for deterministic tests. */
  now?: () => number;
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
  trace: ReadonlyArray<TraceStep>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function resolveAgent(agentUrl: string, options: ResolveAgentOptions = {}): Promise<AgentResolution> {
  const trace: TraceStep[] = [];
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const allowPrivateIp = checkAllowPrivateIp(options.allowPrivateIp === true);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const caps = options.bodyCaps ?? {};
  const brandJsonCap = caps.brandJsonBytes ?? MAX_BRAND_JSON_BYTES;
  const jwksCap = caps.jwksBytes ?? MAX_JWKS_BYTES;

  // ─── Step 1: fetch capabilities at the protocol layer ─────────────────
  const fetchCapabilities = options.fetchCapabilities ?? defaultFetchCapabilities(agentUrl, options.protocol ?? 'mcp');
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
      dns_error: err instanceof SafeFetchError ? err.transport : 'fetch_failed',
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
  const brandJsonUrl = readBrandJsonUrl(capabilitiesPayload);
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
  pushTrace(trace, { step: 2, name: 'read_brand_json_url', ok: true, detail: { brand_json_url: brandJsonUrl } });

  // ─── Step 3: eTLD+1 origin binding ────────────────────────────────────
  // IP-literal hosts have no PSL match; under `allowPrivateIp` (dev/test)
  // we fall back to bare hostname equality so loopback fixtures work without
  // standing up a public-name server. Production callers who don't set
  // `allowPrivateIp` will hit `request_signature_brand_origin_mismatch` on
  // an IP literal — which is the right answer: an agent advertising an IP
  // brand_json_url has no business being trusted at the wire.
  let agentEtld1: string;
  let brandEtld1: string;
  let sameOrigin: boolean;
  try {
    agentEtld1 = eTldPlusOne(agentUrl);
    brandEtld1 = eTldPlusOne(brandJsonUrl);
    sameOrigin = sameEtldPlusOne(agentUrl, brandJsonUrl);
  } catch {
    if (allowPrivateIp) {
      const agentHost = new URL(agentUrl).hostname;
      const brandHost = new URL(brandJsonUrl).hostname;
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
  }

  // ─── Step 4: fetch brand.json (no redirects, strict JSON) ─────────────
  let brandJson: unknown;
  let brandJsonFetchedAt: number;
  try {
    const fetched = await safeFetchJson(brandJsonUrl, 'brand.json', {
      allowPrivateIp,
      timeoutMs,
      maxBodyBytes: brandJsonCap,
    });
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
  if (!sameOrigin) {
    const delegated = isAuthorizedOperator(brandJson, agentEtld1);
    if (!delegated) {
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

  // ─── Step 5: byte-equal agents[] selection ────────────────────────────
  let agentEntry: AgentEntry;
  try {
    agentEntry = selectAgentByUrl(brandJson, agentUrl);
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
    throw err;
  }

  // ─── Step 6: resolve jwks_uri ─────────────────────────────────────────
  const declaredJwksUri = agentEntry.jwks_uri;
  const jwksUriFromEntry =
    typeof declaredJwksUri === 'string' && acceptsScheme(declaredJwksUri) ? declaredJwksUri : undefined;
  const jwksUri = jwksUriFromEntry ?? `${originOf(agentUrl)}/.well-known/jwks.json`;
  pushTrace(trace, { step: 6, name: 'resolve_jwks_uri', ok: true, detail: { jwks_uri: jwksUri } });

  // ─── Step 7: identity.key_origins consistency ─────────────────────────
  const consistencyResults = runConsistencyChecks({
    capabilitiesPayload,
    identityPosture,
    jwksUri,
    publisherPinnedWebhookSigning: options.publisherPinned?.webhook_signing === true,
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
    // The spec hands step 8 off to the verifier checklist, where the
    // canonical "JWKS unreachable" code (`request_signature_key_unknown`)
    // only applies once a kid lookup has been attempted. The bootstrap
    // chain needs a code before we have a kid, so we emit the SDK-side
    // `request_signature_jwks_unreachable`. Operators triaging the
    // rejection see `detail.jwks_uri`, not `detail.brand_json_url`.
    throw new AgentResolverError('request_signature_jwks_unreachable', `JWKS fetch failed`, detail, ['jwks_uri']);
  }

  return {
    agentUrl,
    brandJsonUrl,
    agentEntry,
    jwksUri,
    jwks,
    identityPosture,
    consistency: { ok: true },
    freshness: { capabilitiesFetchedAt, brandJsonFetchedAt, jwksFetchedAt },
    ...(jwksCacheControl !== undefined && { jwksCacheControl }),
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

function defaultFetchCapabilities(agentUrl: string, protocol: AgentProtocol): FetchCapabilitiesFn {
  return async () => {
    const client = protocol === 'a2a' ? createA2AClient(agentUrl) : createMCPClient(agentUrl);
    return client.callTool('get_adcp_capabilities', {});
  };
}

function isAuthorizedOperator(brandJson: unknown, agentEtld1: string): boolean {
  if (!brandJson || typeof brandJson !== 'object') return false;
  const operators = (brandJson as { authorized_operators?: unknown }).authorized_operators;
  if (!Array.isArray(operators)) return false;
  for (const op of operators) {
    if (op && typeof op === 'object') {
      const domain = (op as { domain?: unknown }).domain;
      if (typeof domain === 'string') {
        try {
          if (eTldPlusOne(domain) === agentEtld1) return true;
        } catch {
          continue;
        }
      }
    }
    // Some brand.json shapes carry a bare-string entry rather than `{ domain }`.
    if (typeof op === 'string') {
      try {
        if (eTldPlusOne(op) === agentEtld1) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

function originOf(url: string): string {
  return canonicalizeOrigin(url);
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
  publisherPinnedWebhookSigning: boolean;
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
        publisherPinned: purpose === 'webhook_signing' && args.publisherPinnedWebhookSigning,
      });
      if (result.ok === false) results.push(result);
    }
  }
  return results;
}
