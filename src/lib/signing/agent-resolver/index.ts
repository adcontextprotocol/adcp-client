/**
 * Brand-JSON-URL agent resolver — bootstraps from an agent URL to its
 * signing keys via the 8-step algorithm in `security.mdx` §"Discovering
 * an agent's signing keys via `brand_json_url`".
 *
 * Public exports for `@adcp/client`:
 *
 *   - `resolveAgent(url, opts)`       — full chain + per-step trace
 *   - `getAgentJwks(url, opts)`       — JWKS-only fast path (stage 4)
 *   - `createAgentJwksSet(url, opts)` — JOSE-compatible JWTVerifyGetKey factory (stage 4)
 *   - `AgentResolverError`            — typed error with `request_signature_*` codes
 *   - `attackerInfluencedFields`      — names of `detail` fields admin UIs MUST escape
 *
 * Pure-function primitives (`eTldPlusOne`, `canonicalizeOrigin`,
 * `selectAgentByUrl`, etc.) are exported under `agent-resolver/primitives`
 * for callers building bespoke verification flows on top of this module.
 */

export { resolveAgent } from './resolve-agent';
export type {
  AgentResolution,
  AgentProtocol,
  FetchCapabilitiesFn,
  ResolveAgentOptions,
  TraceStep,
} from './resolve-agent';
export { getAgentJwks, createAgentJwksSet } from './jwks-set';
export type { AgentJwksResult, GetAgentJwksOptions, CreateAgentJwksSetOptions } from './jwks-set';
export {
  AgentResolverError,
  ATTACKER_INFLUENCED,
  attackerInfluencedFields,
  type AgentResolverErrorCode,
  type AgentResolverErrorDetail,
} from './errors';
export type { AgentEntry } from './select-agent';
export type {
  CapabilitiesWithBrandJsonUrl,
  IdentityKeyOriginPurpose,
  IdentityKeyOrigins,
  IdentityPosture,
} from './capabilities-types';
export { readBrandJsonUrl, readIdentityPosture } from './capabilities-types';
