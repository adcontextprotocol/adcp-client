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
export type WebhookSignatureErrorCode =
  | 'webhook_signature_header_malformed'
  | 'webhook_signature_params_incomplete'
  | 'webhook_signature_tag_invalid'
  | 'webhook_signature_alg_not_allowed'
  | 'webhook_signature_expired'
  | 'webhook_signature_components_incomplete'
  | 'webhook_signature_key_unknown'
  | 'webhook_signature_key_purpose_invalid'
  | 'webhook_signature_key_revoked'
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
