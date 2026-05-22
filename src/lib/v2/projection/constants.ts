/**
 * Shared URL anchors for the v2 projection layer.
 *
 * Post-adcontextprotocol/adcp#4866, `creative.adcontextprotocol.org` is
 * the single AAO (Ad Agents Open) trust anchor for format-schema `$ref`
 * resolution. The base URL here is intentionally NOT derived from
 * `DEFAULT_MIRROR_HOSTS` in `format-schema/sandbox-refs.ts` — that array
 * is an allowlist of *hostnames* for `$ref` sandboxing, while this
 * constant is the base URL written into synthesized `V1FormatId.agent_url`
 * values. The two serve different purposes; deriving one from the other
 * couples orthogonal subsystems.
 */

/**
 * Canonical AAO base URL used as `agent_url` in synthesized v1 format
 * references. Registry synthesis is implementation-defined per the AdCP
 * spec — this value is a best-effort fallback that mirrors the AAO
 * reference agent URL, not a normative wire contract.
 *
 * @see {@link https://github.com/adcontextprotocol/adcp/issues/4866} —
 * trust-anchor migration that made `creative.adcontextprotocol.org` the
 * single canonical host.
 */
export const AAO_CANONICAL_AGENT_URL = 'https://creative.adcontextprotocol.org/';
