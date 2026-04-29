import type { AdcpSignAlg, RequestSignatureErrorCode } from '../../../signing';

/**
 * Grader-side codes for failures that surface *before* the verifier sees
 * any bytes — i.e., at signer setup, signer invocation, or the verifier
 * raising something other than a `RequestSignatureError`. Distinct
 * namespace from `RequestSignatureErrorCode` so consumers writing
 * exhaustive `switch` over the union see grader-side and verifier-side
 * failures as different categories.
 */
export type SignerGraderErrorCode = 'signer_setup_failed' | 'signer_invocation_failed' | 'verifier_threw_unexpected';

export type SignerGradeErrorCode = RequestSignatureErrorCode | SignerGraderErrorCode;

/**
 * Per-step result from the verifier pipeline. The signer grader runs a
 * sample signed request through the SDK's verifier and reports the outcome
 * step-by-step (mirroring the verifier-checklist semantics in
 * `verifier.ts`).
 */
export interface SignerGradeStep {
  status: 'pass' | 'fail' | 'skipped';
  /**
   * Error code when the step fails. Either a verifier-side
   * `RequestSignatureErrorCode` (signature was produced but rejected)
   * or a grader-side `SignerGraderErrorCode` (failure before the
   * verifier saw bytes). Absent on pass.
   */
  error_code?: SignerGradeErrorCode;
  /** Human-readable diagnostic; on fail, includes the verifier's message. */
  diagnostic?: string;
}

export interface SignerGradeReport {
  /** Agent URL identifying which signing identity was graded. */
  agent_url: string;
  /** JWKS endpoint the verifier resolved against. */
  jwks_uri: string;
  /** `kid` advertised by the signer (matches the wire `Signature-Input`). */
  kid: string;
  /** Algorithm advertised by the signer. */
  algorithm: AdcpSignAlg;
  /** Total wall-clock duration. */
  duration_ms: number;
  /**
   * Whether the signer produced a valid AdCP RFC 9421 signature that the
   * SDK verifier accepts. `false` if any step failed.
   */
  passed: boolean;
  /** Granular result for each verifier check. */
  step: SignerGradeStep;
  /**
   * Sample request the grader had the signer produce headers for. Useful
   * for diagnostics when the verifier rejects — operators can pin down
   * whether the signer's canonicalization, the JWKS resolution, or the
   * signature itself is the failure point.
   */
  sample: {
    method: string;
    url: string;
    body: string;
    /** Signer-produced headers (empty object if the signer call itself failed). */
    headers: Record<string, string>;
  };
}
