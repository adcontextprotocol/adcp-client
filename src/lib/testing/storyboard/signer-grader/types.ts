import type { AdcpSignAlg } from '../../../signing';

/**
 * Per-step result from the verifier pipeline. The signer grader runs a
 * sample signed request through the SDK's verifier and reports the outcome
 * step-by-step (mirroring the verifier-checklist semantics in
 * `verifier.ts`).
 */
export interface SignerGradeStep {
  status: 'pass' | 'fail' | 'skipped';
  /**
   * Verifier-side error code when this step fails (one of
   * `RequestSignatureErrorCode` — see `errors.ts`). Absent on pass.
   */
  error_code?: string;
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
