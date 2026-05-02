/**
 * Typed errors surfaced by `resolveAgent`. Codes mirror the
 * `request_signature_*` taxonomy from security.mdx §"Discovering an
 * agent's signing keys via `brand_json_url`" so a verifier consuming the
 * resolver's output can short-circuit to the same wire-rejection code
 * without rewriting the mapping.
 *
 * Detail-field discipline:
 *   - Counterparty-influenceable strings (`agent_url`, `brand_json_url`,
 *     `matched_entries`, `parse_error`, etc.) MUST be HTML-escaped before
 *     rendering in admin UIs. The `attackerInfluenced` symbol marks fields
 *     that came from the wire so downstream renderers can detect them.
 *   - Internal network topology (resolved IPs, DNS state) MUST NOT be
 *     copied onto detail fields. If `ssrfSafeFetch` throws, the resolver
 *     translates the `SsrfRefusedError` into a `request_signature_*_unreachable`
 *     code with `dns_error` set to the error class name only — never the
 *     `address` or `hostname` fields the underlying error carries.
 */

export const ATTACKER_INFLUENCED = Symbol.for('adcp.attacker-influenced');

export type AgentResolverErrorCode =
  | 'request_signature_brand_json_url_missing'
  | 'request_signature_capabilities_unreachable'
  | 'request_signature_brand_json_unreachable'
  | 'request_signature_brand_json_malformed'
  | 'request_signature_brand_origin_mismatch'
  | 'request_signature_agent_not_in_brand_json'
  | 'request_signature_brand_json_ambiguous'
  | 'request_signature_key_origin_mismatch'
  | 'request_signature_key_origin_missing'
  /**
   * SDK-side codes — not in the spec's `request_signature_*` rejection
   * table but distinct conditions a verifier needs to surface separately.
   * The spec hands JWKS-fetch failures off to the verifier checklist
   * (`request_signature_key_unknown`), but that code only applies once a
   * `kid` lookup has been attempted; the bootstrap chain needs a code
   * before we have a kid in hand. Likewise, an alg-allowlist rejection at
   * import time is a distinct trust failure, not a fetch failure.
   */
  | 'request_signature_jwks_unreachable'
  | 'request_signature_jwks_alg_disallowed';

export interface AgentResolverErrorDetail {
  agent_url?: string;
  brand_json_url?: string;
  jwks_uri?: string;
  agent_etld1?: string;
  brand_json_url_etld1?: string;
  http_status?: number;
  /**
   * Coarse classification of a transport error class — `'fetch_failed'`,
   * `'timeout'`, `'dns_error'`, `'ssrf_refused'`. NEVER includes a resolved
   * IP, hostname-to-address mapping, or any other internal-topology hint.
   */
  dns_error?: string;
  last_attempt_at?: number;
  parse_error?: string;
  matched_count?: number;
  matched_entries?: ReadonlyArray<{ url: string; jwks_uri?: string }>;
  purpose?: string;
  expected_origin?: string;
  actual_origin?: string;
  posture?: string;
}

export class AgentResolverError extends Error {
  readonly code: AgentResolverErrorCode;
  readonly detail: AgentResolverErrorDetail;
  readonly [ATTACKER_INFLUENCED]: ReadonlyArray<keyof AgentResolverErrorDetail>;

  constructor(
    code: AgentResolverErrorCode,
    message: string,
    detail: AgentResolverErrorDetail = {},
    attackerInfluencedFields: ReadonlyArray<keyof AgentResolverErrorDetail> = []
  ) {
    super(message);
    this.name = 'AgentResolverError';
    this.code = code;
    this.detail = detail;
    this[ATTACKER_INFLUENCED] = attackerInfluencedFields;
  }
}

/**
 * Field names on `AgentResolverError.detail` that carry counterparty-controlled
 * strings. Renderers (admin UIs, log aggregators) MUST HTML-escape these
 * before display.
 */
export function attackerInfluencedFields(err: AgentResolverError): ReadonlyArray<keyof AgentResolverErrorDetail> {
  return err[ATTACKER_INFLUENCED];
}
