/**
 * Convenience surfaces over `resolveAgent`:
 *
 *   - `getAgentJwks(url, opts)` — JWKS-only fast path. Skips the trace
 *     assembly the full resolver returns; callers who only need keys for
 *     a verifier don't have to filter the larger record.
 *
 *   - `createAgentJwksSet(url, opts)` — returns a `JWTVerifyGetKey`-shaped
 *     async function compatible with `jose.jwtVerify`'s `getKey` parameter.
 *     Caches the resolved JWKS per `cacheMaxAgeSeconds`; refetches on a
 *     `kid` miss subject to the spec's 30-second cooldown
 *     (security.mdx §"Verifier checklist (requests)" step 7's refetch
 *     guidance). Enforces the caller-supplied algorithm allowlist at JWKS
 *     import time AND on the verify call — defense-in-depth against the
 *     "alg: HS256" confusion vector. The allowlist is REQUIRED; there is
 *     no library default.
 */

import { createLocalJWKSet, type JWK, type JWTVerifyGetKey } from 'jose';

import { AgentResolverError } from './errors';
import { resolveAgent, type AgentResolution, type ResolveAgentOptions } from './resolve-agent';

export type GetAgentJwksOptions = Pick<
  ResolveAgentOptions,
  'protocol' | 'fetchCapabilities' | 'allowPrivateIp' | 'timeoutMs' | 'now'
>;

export interface AgentJwksResult {
  agentUrl: string;
  brandJsonUrl: string;
  jwksUri: string;
  jwks: { keys: ReadonlyArray<Record<string, unknown>> };
  cacheControl?: string;
  fetchedAt: number;
}

/**
 * Fast path: returns the JWKS plus the URIs that produced it. Skips the
 * trace + freshness aggregate the full `resolveAgent` returns. Errors
 * propagate as `AgentResolverError` with the same `request_signature_*`
 * codes — the JWKS fast path is not a separate trust chain.
 */
export async function getAgentJwks(agentUrl: string, options: GetAgentJwksOptions = {}): Promise<AgentJwksResult> {
  const resolution = await resolveAgent(agentUrl, options);
  return {
    agentUrl: resolution.agentUrl,
    brandJsonUrl: resolution.brandJsonUrl,
    jwksUri: resolution.jwksUri,
    jwks: resolution.jwks,
    ...(resolution.jwksCacheControl !== undefined && { cacheControl: resolution.jwksCacheControl }),
    fetchedAt: resolution.freshness.jwksFetchedAt,
  };
}

export interface CreateAgentJwksSetOptions extends Pick<
  ResolveAgentOptions,
  'protocol' | 'fetchCapabilities' | 'allowPrivateIp' | 'timeoutMs' | 'now'
> {
  /**
   * Algorithm allowlist enforced at JWKS-import time AND surfaced to
   * `jose.jwtVerify`'s `algorithms` option. Required — there is no default.
   * The classic confusion vector is `alg: HS256` against a public-key JWK,
   * which jose's verifier would reject — but a library that pre-imports
   * keys without an allowlist still leaves the door open to JWKs whose
   * declared `alg` doesn't match the verifier's expectation. Requiring the
   * caller to name the algorithms closes the door at every layer.
   *
   * Use a tight set: `["EdDSA"]` for Ed25519-only deployments;
   * `["EdDSA", "ES256"]` for the AdCP request-signing default pair.
   */
  allowedAlgs: readonly string[];
  /**
   * Max age in seconds before a forced refetch of the JWKS. Default 300s
   * (5 minutes). Bound this above by your operator's revocation polling
   * interval — a longer cache mask key rotation; a shorter cache costs
   * extra fetches without buying you anything.
   */
  cacheMaxAgeSeconds?: number;
  /**
   * Minimum interval between JWKS refetches when a `kid` miss triggers a
   * refresh. Default 30s — matches the spec's cooldown rule for the
   * verifier checklist's step-7 refetch.
   */
  kidMissCooldownSeconds?: number;
}

const DEFAULT_CACHE_MAX_AGE_SECONDS = 300;
const DEFAULT_KID_MISS_COOLDOWN_SECONDS = 30;

interface CachedJwks {
  resolution: AgentResolution;
  fetchedAt: number;
  /** `createLocalJWKSet` output for the cached JWKS. */
  getKey: JWTVerifyGetKey;
}

/**
 * Build a `JWTVerifyGetKey` that runs the brand_json_url discovery chain on
 * first use, caches the resolved JWKS, refetches on cache expiry, and
 * refetches once on a `kid` miss subject to a 30s cooldown. Imports each
 * JWK and rejects any whose `alg` (when declared) is outside `allowedAlgs`.
 *
 * The returned function is compatible with `jose.jwtVerify` — pass it as
 * `getKey` and pair with `algorithms: opts.allowedAlgs` on the verify call.
 */
export function createAgentJwksSet(agentUrl: string, options: CreateAgentJwksSetOptions): JWTVerifyGetKey {
  if (!options.allowedAlgs || options.allowedAlgs.length === 0) {
    throw new TypeError(
      `createAgentJwksSet requires non-empty allowedAlgs — refusing to verify against an open algorithm set`
    );
  }
  const allowedAlgs = new Set(options.allowedAlgs);
  const cacheMaxAge = options.cacheMaxAgeSeconds ?? DEFAULT_CACHE_MAX_AGE_SECONDS;
  const kidCooldown = options.kidMissCooldownSeconds ?? DEFAULT_KID_MISS_COOLDOWN_SECONDS;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  let cache: CachedJwks | undefined;
  let lastRefetchAt = 0;
  let inFlight: Promise<CachedJwks> | undefined;

  const refresh = async (): Promise<CachedJwks> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const resolution = await resolveAgent(agentUrl, options);
      assertAllJwksAllowed(resolution.jwks, allowedAlgs, agentUrl);
      const filtered = filterJwksToAllowedAlgs(resolution.jwks, allowedAlgs);
      const getKey = createLocalJWKSet({ keys: filtered as unknown as JWK[] });
      cache = { resolution, fetchedAt: now(), getKey };
      lastRefetchAt = cache.fetchedAt;
      return cache;
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const ensureFresh = async (): Promise<CachedJwks> => {
    if (!cache || now() - cache.fetchedAt >= cacheMaxAge) {
      return refresh();
    }
    return cache;
  };

  const getKey: JWTVerifyGetKey = async (protectedHeader, token) => {
    const fresh = await ensureFresh();
    try {
      return await fresh.getKey(protectedHeader, token);
    } catch (err) {
      // Likely cause: kid miss (key rotated). Subject to the cooldown,
      // refetch once and retry — same logic the spec's verifier checklist
      // applies between the agent-URL preamble and the kid resolution.
      if (now() - lastRefetchAt < kidCooldown) throw err;
      const refreshed = await refresh();
      return refreshed.getKey(protectedHeader, token);
    }
  };

  return getKey;
}

/**
 * Reject every JWK whose declared `alg` is outside the allowlist. This is
 * the import-time half of the defense-in-depth pair against alg-confusion
 * attacks; the verify-time half is the caller passing `algorithms` to
 * `jose.jwtVerify`. Malformed-JWK detection is left to `createLocalJWKSet`
 * + `jose.jwtVerify` at verify time — running an async smoke-import here
 * would be fire-and-forget and swallow rejections.
 */
function assertAllJwksAllowed(
  jwks: { keys: ReadonlyArray<Record<string, unknown>> },
  allowedAlgs: ReadonlySet<string>,
  agentUrl: string
): void {
  for (const jwk of jwks.keys) {
    const declared = jwk.alg;
    if (typeof declared === 'string' && !allowedAlgs.has(declared)) {
      throw new AgentResolverError(
        'request_signature_jwks_alg_disallowed',
        `Agent JWKS contains key with alg=${declared} not in allowedAlgs`,
        { agent_url: agentUrl },
        ['agent_url']
      );
    }
  }
}

function filterJwksToAllowedAlgs(
  jwks: { keys: ReadonlyArray<Record<string, unknown>> },
  allowedAlgs: ReadonlySet<string>
): ReadonlyArray<Record<string, unknown>> {
  // Keep keys without a declared `alg` (jose still gates by the verifier's
  // `algorithms` option) and keys whose declared `alg` is in the allowlist.
  return jwks.keys.filter(jwk => typeof jwk.alg !== 'string' || allowedAlgs.has(jwk.alg));
}
