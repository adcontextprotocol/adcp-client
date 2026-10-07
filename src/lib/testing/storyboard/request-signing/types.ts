import type { RequestLike } from '../../../signing';
import type { RequestSignatureErrorCode } from '../../../signing';

/** Stateful-vector contracts declared in `test-kits/signed-requests-runner.yaml`. */
export const CONTRACT_IDS = ['replay_window', 'revocation', 'rate_abuse'] as const;
export type ContractId = (typeof CONTRACT_IDS)[number];

export interface VectorRequest extends RequestLike {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface VerifierCapabilityFixture {
  supported: boolean;
  covers_content_digest: 'required' | 'forbidden' | 'either';
  required_for: string[];
  supported_for?: string[];
  /**
   * JSON-RPC protocol-method coverage (e.g. `tasks/cancel`, `tasks/get`) —
   * separate namespace from `required_for` / `supported_for` (which carry
   * AdCP tool names). Introduced in adcp#4326. Vectors targeting protocol
   * methods (e.g. negative/028) populate these; vectors targeting AdCP tools
   * leave them undefined.
   */
  protocol_methods_supported_for?: string[];
  protocol_methods_required_for?: string[];
}

/**
 * Inline JWK set shipped with a negative vector that wants to publish a
 * deliberately-malformed JWK (e.g., vector 025 declares alg=EdDSA but
 * crv=P-256 to exercise step-8 parameter consistency). Using `jwks_override`
 * instead of adding a malformed key to `keys.json` keeps the canonical
 * keyset clean so other vectors can't inherit the broken shape.
 * Mutually exclusive with `jwks_ref`.
 */
export interface JwksOverride {
  keys: Array<Record<string, unknown>>;
}

export interface PositiveVector {
  kind: 'positive';
  id: string;
  name: string;
  /** Trusted profile pin from the authored fixture; never inferred from request fields. */
  signing_profile_version: string;
  reference_now: number;
  request: VectorRequest;
  verifier_capability: VerifierCapabilityFixture;
  jwks_ref?: string[];
  jwks_override?: JwksOverride;
  expected_signature_base?: string;
  spec_reference?: string;
}

export interface NegativeVector {
  kind: 'negative';
  id: string;
  name: string;
  /** Trusted profile pin from the authored fixture; never inferred from request fields. */
  signing_profile_version: string;
  reference_now: number;
  request: VectorRequest;
  verifier_capability: VerifierCapabilityFixture;
  jwks_ref?: string[];
  jwks_override?: JwksOverride;
  expected_error_code: RequestSignatureErrorCode;
  expected_failed_step: number | string;
  requires_contract?: ContractId;
  spec_reference?: string;
}

export type Vector = PositiveVector | NegativeVector;

/**
 * Conformance tier of an A2A operation-resolution vector (adcp#7945).
 *
 * - `contradiction-resolution`: grades the security erratum that fixes the
 *   `security.mdx` / A2A-profile contradiction. MUST for a 3.2 verifier.
 * - `hardening`: grades clauses that go further. SHOULD in 3.2.x, MUST from 3.3.
 */
export type A2aVectorTier = 'contradiction-resolution' | 'hardening';

export const A2A_VECTOR_TIERS: readonly A2aVectorTier[] = ['contradiction-resolution', 'hardening'];

/**
 * `expected_outcome` of an A2A operation-resolution vector. Wider than the
 * root vectors': positives carry `status`, and both kinds may name the
 * operation the verifier MUST resolve (`null` = "no operation") plus the
 * dispatch the agent MUST perform. `failed_step: 0` is the pre-check, not a
 * numbered checklist step.
 */
export interface A2aExpectedOutcome {
  success: boolean;
  /** Positives only: `verified` (valid signature) or `unsigned` (no signature required). */
  status?: 'verified' | 'unsigned';
  /** Negatives only: `request_signature_required` or `request_body_malformed`. */
  error_code?: RequestSignatureErrorCode;
  failed_step?: number | string;
  resolved_operation?: string | null;
  dispatched_operation?: string;
  dispatch?: string;
}

/** Positive A2A operation-resolution vector. Ids are prefixed `a2a/positive/`. */
export interface A2aPositiveVector extends PositiveVector {
  tier: A2aVectorTier;
  expected_outcome: A2aExpectedOutcome & { success: true; status: 'verified' | 'unsigned' };
}

/** Negative A2A operation-resolution vector. Ids are prefixed `a2a/negative/`. */
export interface A2aNegativeVector extends NegativeVector {
  tier: A2aVectorTier;
  expected_outcome: A2aExpectedOutcome & { success: false };
}

export type A2aVector = A2aPositiveVector | A2aNegativeVector;

export interface TestKeypair {
  kid: string;
  kty: string;
  crv?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  adcp_use?: string;
  x?: string;
  y?: string;
  /** base64url-encoded private scalar, published only in test-vector keys.json. */
  private_d: string;
}

export interface TestKeyset {
  keys: TestKeypair[];
}
