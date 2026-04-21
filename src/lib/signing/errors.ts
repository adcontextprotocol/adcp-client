import { ADCPError } from '../errors';

export type RequestSignatureErrorCode =
  | 'request_signature_required'
  | 'request_signature_header_malformed'
  | 'request_signature_params_incomplete'
  | 'request_signature_tag_invalid'
  | 'request_signature_alg_not_allowed'
  | 'request_signature_window_invalid'
  | 'request_signature_components_incomplete'
  | 'request_signature_components_unexpected'
  | 'request_signature_key_unknown'
  | 'request_signature_key_purpose_invalid'
  | 'request_signature_key_revoked'
  | 'request_signature_invalid'
  | 'request_signature_digest_mismatch'
  | 'request_signature_replayed'
  | 'request_signature_rate_abuse'
  | 'request_signature_revocation_stale';

export class RequestSignatureError extends ADCPError {
  readonly code: RequestSignatureErrorCode;
  readonly failedStep: number;

  constructor(code: RequestSignatureErrorCode, failedStep: number, message: string, details?: unknown) {
    super(message, details);
    this.code = code;
    this.failedStep = failedStep;
  }
}

/**
 * Error codes surfaced by the RFC 9421 webhook-signing verifier. Maps onto
 * the `webhook_signature_*` codes enumerated by the webhook-emission
 * storyboard (adcontextprotocol/adcp#2431) with matching semantics.
 */
/**
 * Error taxonomy per the merged spec in `security.mdx#webhook-callbacks`
 * and the conformance vectors at `test-vectors/webhook-signing/`. The spec
 * folds every window failure (expired, negative window, over-long window,
 * created-in-future) into a single `webhook_signature_window_invalid` code —
 * no distinct `_expired`.
 */
export type WebhookSignatureErrorCode =
  | 'webhook_signature_header_malformed'
  | 'webhook_signature_params_incomplete'
  | 'webhook_signature_tag_invalid'
  | 'webhook_signature_alg_not_allowed'
  | 'webhook_signature_window_invalid'
  | 'webhook_signature_components_incomplete'
  // `@target-uri` covered-component value failed syntactic validation (non-
  // parseable URL, non-https scheme, userinfo present, fragment present).
  // Distinct from `header_malformed`, which flags the `Signature` /
  // `Signature-Input` headers themselves; this flags the covered URI.
  | 'webhook_target_uri_malformed'
  | 'webhook_signature_key_unknown'
  // JWK has no `adcp_use` declared (or lacks the `verify` key_op). Kept
  // distinct from `webhook_mode_mismatch` so operators can tell "key is not
  // scoped at all" apart from "key is scoped for the wrong mode".
  | 'webhook_signature_key_purpose_invalid'
  // JWK declares `adcp_use` but for a different mode than webhook-signing
  // (e.g. `request-signing`). Separate code from `key_purpose_invalid` so
  // the remediation is clear: mint a new key scoped for `webhook-signing`
  // rather than adding the purpose to an existing request-signing key.
  | 'webhook_mode_mismatch'
  | 'webhook_signature_key_revoked'
  | 'webhook_signature_revocation_stale'
  | 'webhook_signature_rate_abuse'
  | 'webhook_signature_invalid'
  | 'webhook_signature_digest_mismatch'
  | 'webhook_signature_replayed';

export class WebhookSignatureError extends ADCPError {
  readonly code: WebhookSignatureErrorCode;
  readonly failedStep: number;

  constructor(code: WebhookSignatureErrorCode, failedStep: number, message: string, details?: unknown) {
    super(message, details);
    this.code = code;
    this.failedStep = failedStep;
  }
}
