/**
 * Shared URL anchors for the v2 projection layer.
 *
 * Post-adcontextprotocol/adcp#4866, `creative.adcontextprotocol.org` is
 * the canonical AAO (Ad Agents Open) host. We reuse it here as the
 * `agent_url` base for synthesized v1 refs so projected values match
 * seller-asserted fixtures byte-for-byte.
 *
 * This constant is NOT the `$ref`-resolution trust anchor — that role
 * belongs to `DEFAULT_MIRROR_HOSTS` in `format-schema/sandbox-refs.ts`,
 * which is an allowlist of *hostnames* gating HTTP fetches of
 * `format_schema.uri` and `$ref` targets. Same host, distinct purposes:
 * one is a fetch-time SSRF gate, the other is a content URL written
 * into projected `V1FormatId.agent_url` values that are never fetched.
 * Deriving one from the other would couple the SSRF gate to a
 * presentation concern.
 */

/**
 * Canonical AAO base URL used as `agent_url` in synthesized v1 format
 * references. Registry synthesis is implementation-defined per the AdCP
 * spec — this value is a best-effort fallback that mirrors the AAO
 * reference agent URL, not a normative wire contract.
 *
 * @see {@link https://github.com/adcontextprotocol/adcp/issues/4866} —
 * collapse to a single canonical AAO host.
 */
export const AAO_CANONICAL_AGENT_URL = 'https://creative.adcontextprotocol.org/';
