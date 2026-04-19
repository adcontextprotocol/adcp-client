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
}

export interface PositiveVector {
  kind: 'positive';
  id: string;
  name: string;
  reference_now: number;
  request: VectorRequest;
  verifier_capability: VerifierCapabilityFixture;
  jwks_ref: string[];
  expected_signature_base?: string;
  spec_reference?: string;
}

export interface NegativeVector {
  kind: 'negative';
  id: string;
  name: string;
  reference_now: number;
  request: VectorRequest;
  verifier_capability: VerifierCapabilityFixture;
  jwks_ref: string[];
  expected_error_code: RequestSignatureErrorCode;
  expected_failed_step: number | string;
  requires_contract?: ContractId;
  spec_reference?: string;
}

export type Vector = PositiveVector | NegativeVector;

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
