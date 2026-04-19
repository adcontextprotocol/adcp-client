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
