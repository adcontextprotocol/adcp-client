/**
 * AdCP Error Extraction
 *
 * Extracts structured AdCP errors from MCP and A2A transport responses.
 * Implements the detection order from the transport error mapping spec.
 */

import {
  STANDARD_ERROR_CODES,
  isStandardErrorCode,
  type StandardErrorCode,
  type ErrorRecovery,
} from '../types/error-codes';

export interface ExtractedAdcpError {
  code: string;
  message: string;
  recovery?: ErrorRecovery;
  field?: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
  /** Where the error was found in the response */
  source: 'structuredContent' | 'text_json' | 'text_pattern';
  /** The compliance level this delivery achieves */
  compliance_level: 1 | 2 | 3;
}

/**
 * @internal
 * Extract an AdCP error from an MCP tool response.
 *
 * Detection order (per transport error mapping spec):
 * 1. structuredContent.adcp_error — source 'structuredContent', level 3
 * 2. JSON.parse(content[].text).adcp_error — source 'text_json', level 2
 * 3. Pattern matching on error text for known codes — source 'text_pattern', level 1
 *
 * Returns null if no AdCP error is detected.
 */
export function extractAdcpErrorFromMcp(
  response:
    | {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
      }
    | null
    | undefined
): ExtractedAdcpError | null {
  if (!response) return null;

  // Path 1: structuredContent.adcp_error (L3) — only check error responses
  if (response.isError) {
    const structured = response.structuredContent?.adcp_error as Record<string, unknown> | undefined;
    if (structured && typeof structured.code === 'string') {
      return buildExtracted(structured, 'structuredContent', 3);
    }
  }

  // Path 2: JSON text fallback (L2) — only check error responses
  if (response.isError && Array.isArray(response.content)) {
    for (const item of response.content) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        try {
          const parsed = JSON.parse(item.text);
          if (parsed?.adcp_error && typeof parsed.adcp_error.code === 'string') {
            return buildExtracted(parsed.adcp_error, 'text_json', 2);
          }
        } catch {
          // not JSON, continue
        }
      }
    }
  }

  // Path 3: Text pattern matching (L1)
  if (response.isError && Array.isArray(response.content)) {
    const allText = response.content
      .filter((item: any) => item?.type === 'text' && item.text)
      .map((item: any) => item.text)
      .join('\n');

    if (allText) {
      const matchedCode = matchStandardCode(allText);
      if (matchedCode) {
        return {
          code: matchedCode,
          message: allText,
          source: 'text_pattern',
          compliance_level: 1,
        };
      }
    }
  }

  return null;
}

/**
 * @internal
 * Extract an AdCP error from a JSON-RPC transport error.
 * Checks error.data.adcp_error for structured transport-level errors
 * (e.g., -32029 rate limit from infrastructure).
 */
export function extractAdcpErrorFromTransport(error: unknown): ExtractedAdcpError | null {
  const errorObj = error as Record<string, unknown> | null | undefined;
  const data = errorObj?.data as Record<string, unknown> | undefined;
  const adcpErr = data?.adcp_error as Record<string, unknown> | undefined;
  if (adcpErr && typeof adcpErr.code === 'string') {
    return buildExtracted(adcpErr, 'structuredContent', 3);
  }

  // Fall back to message pattern matching
  const message = error instanceof Error ? error.message : (errorObj?.message as string) || String(error);
  if (typeof message === 'string') {
    const matchedCode = matchStandardCode(message);
    if (matchedCode) {
      return {
        code: matchedCode,
        message,
        source: 'text_pattern',
        compliance_level: 1,
      };
    }
  }

  return null;
}

/**
 * Resolve recovery classification for an error.
 * Uses explicit recovery field if present, falls back to standard code table.
 */
export function resolveRecovery(error: { code: string; recovery?: string }): ErrorRecovery {
  if (error.recovery === 'transient' || error.recovery === 'correctable' || error.recovery === 'terminal') {
    return error.recovery;
  }
  if (isStandardErrorCode(error.code)) {
    return STANDARD_ERROR_CODES[error.code as StandardErrorCode].recovery;
  }
  return 'terminal';
}

/**
 * Determine expected client action for a recovery classification.
 */
export function getExpectedAction(recovery: ErrorRecovery): 'retry' | 'fix_request' | 'escalate' {
  switch (recovery) {
    case 'transient':
      return 'retry';
    case 'correctable':
      return 'fix_request';
    case 'terminal':
      return 'escalate';
  }
}

// --- Internal helpers ---

function buildExtracted(
  obj: any,
  source: ExtractedAdcpError['source'],
  compliance_level: ExtractedAdcpError['compliance_level']
): ExtractedAdcpError {
  const result: ExtractedAdcpError = {
    code: obj.code,
    message: obj.message || '',
    source,
    compliance_level,
  };
  if (obj.recovery === 'transient' || obj.recovery === 'correctable' || obj.recovery === 'terminal')
    result.recovery = obj.recovery;
  if (obj.field != null) result.field = obj.field;
  if (obj.suggestion != null) result.suggestion = obj.suggestion;
  if (obj.retry_after != null) result.retry_after = obj.retry_after;
  if (obj.details != null) result.details = obj.details;
  return result;
}

/** Known patterns that map to standard error codes */
const CODE_PATTERNS: Array<[RegExp, StandardErrorCode]> = [
  [/\bRATE_LIMITED\b/i, 'RATE_LIMITED'],
  [/\brate[\s._-]?limit/i, 'RATE_LIMITED'],
  [/\bPRODUCT_NOT_FOUND\b/, 'PRODUCT_NOT_FOUND'],
  [/\bPRODUCT_UNAVAILABLE\b/, 'PRODUCT_UNAVAILABLE'],
  [/\bBUDGET_TOO_LOW\b/, 'BUDGET_TOO_LOW'],
  [/\bINVALID_REQUEST\b/, 'INVALID_REQUEST'],
  [/\bAUTH_REQUIRED\b/, 'AUTH_REQUIRED'],
  [/\bSERVICE_UNAVAILABLE\b/, 'SERVICE_UNAVAILABLE'],
  [/\bCREATIVE_REJECTED\b/, 'CREATIVE_REJECTED'],
  [/\bPOLICY_VIOLATION\b/, 'POLICY_VIOLATION'],
  [/\bUNSUPPORTED_FEATURE\b/, 'UNSUPPORTED_FEATURE'],
  [/\bPROPOSAL_EXPIRED\b/, 'PROPOSAL_EXPIRED'],
  [/\bAUDIENCE_TOO_SMALL\b/, 'AUDIENCE_TOO_SMALL'],
  [/\bACCOUNT_NOT_FOUND\b/, 'ACCOUNT_NOT_FOUND'],
  [/\bACCOUNT_SETUP_REQUIRED\b/, 'ACCOUNT_SETUP_REQUIRED'],
  [/\bACCOUNT_AMBIGUOUS\b/, 'ACCOUNT_AMBIGUOUS'],
  [/\bACCOUNT_PAYMENT_REQUIRED\b/, 'ACCOUNT_PAYMENT_REQUIRED'],
  [/\bACCOUNT_SUSPENDED\b/, 'ACCOUNT_SUSPENDED'],
  [/\bCOMPLIANCE_UNSATISFIED\b/, 'COMPLIANCE_UNSATISFIED'],
  [/\bBUDGET_EXHAUSTED\b/, 'BUDGET_EXHAUSTED'],
  [/\bIDEMPOTENCY_CONFLICT\b/, 'IDEMPOTENCY_CONFLICT'],
  [/\bIDEMPOTENCY_EXPIRED\b/, 'IDEMPOTENCY_EXPIRED'],
  // CONFLICT omitted from pattern matching — too ambiguous as a common English word
];

function matchStandardCode(text: string): StandardErrorCode | null {
  for (const [pattern, code] of CODE_PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

// --- TaskResult-level helpers ---

import type { AdcpErrorInfo } from '../core/ConversationTypes';

/**
 * Extract normalized AdcpErrorInfo from unwrapped response data.
 * Handles both `{ adcp_error: {...} }` and `{ errors: [...] }` shapes.
 */
export function extractAdcpErrorInfo(data: any): AdcpErrorInfo | undefined {
  if (!data) return undefined;

  if (data.adcp_error && typeof data.adcp_error.code === 'string') {
    const ae = data.adcp_error;
    const info: AdcpErrorInfo = { code: ae.code, message: ae.message || ae.code };
    const recovery = resolveRecovery(ae);
    if (recovery) info.recovery = recovery;
    if (ae.field != null) info.field = ae.field;
    if (ae.suggestion != null) info.suggestion = ae.suggestion;
    if (ae.retry_after != null) {
      info.retry_after = ae.retry_after;
      info.retryAfterMs = ae.retry_after * 1000;
    }
    if (ae.details != null) info.details = ae.details;
    if (ae.synthetic) info.synthetic = true;
    return info;
  }

  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const first = data.errors[0];
    if (typeof first.code === 'string') {
      const info: AdcpErrorInfo = { code: first.code, message: first.message || '' };
      const recovery = resolveRecovery(first);
      if (recovery) info.recovery = recovery;
      return info;
    }
  }

  return undefined;
}

/**
 * Extract correlation ID from response data context envelope.
 */
export function extractCorrelationId(data: any): string | undefined {
  return data?.context?.correlation_id || undefined;
}

/**
 * Structured details accompanying a `VERSION_UNSUPPORTED` AdCP error per spec
 * `error-details/version-unsupported.json` (AdCP 3.1, spec PR
 * `adcontextprotocol/adcp#3493`). Buyers read these from the error envelope
 * to decide whether to downgrade their pin and retry rather than failing
 * outright.
 */
export interface VersionUnsupportedDetails {
  /**
   * Release-precision versions the seller does support (e.g. `['3.0', '3.1']`).
   * Buyers can negotiate down to a member of this set.
   */
  supported_versions?: string[];
  /** The specific `adcp_version` value the buyer asked for, echoed back. */
  requested_version?: string;
  /** Seller's full semver build, advisory. */
  build_version?: string;
}

/**
 * Extract structured `VERSION_UNSUPPORTED` details from an AdCP error
 * envelope. Returns `undefined` when the error has no `data` block or the
 * block doesn't match the spec shape — callers should treat absence as
 * "seller didn't tell me what they support" and fall back to a fixed retry
 * strategy.
 *
 * Accepts either a raw `error.data` object or the full unwrapped response
 * — looks for `data` / `details` / `adcp_error.data` / `adcp_error.details`
 * variants since SDKs sometimes nest the structured payload differently.
 */
export function extractVersionUnsupportedDetails(input: unknown): VersionUnsupportedDetails | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const candidate = (() => {
    const obj = input as Record<string, unknown>;
    if (typeof obj.supported_versions !== 'undefined' || typeof obj.requested_version !== 'undefined') return obj;
    if (obj.data && typeof obj.data === 'object') return obj.data as Record<string, unknown>;
    if (obj.details && typeof obj.details === 'object') return obj.details as Record<string, unknown>;
    if (obj.adcp_error && typeof obj.adcp_error === 'object') {
      const ae = obj.adcp_error as Record<string, unknown>;
      if (ae.data && typeof ae.data === 'object') return ae.data as Record<string, unknown>;
      if (ae.details && typeof ae.details === 'object') return ae.details as Record<string, unknown>;
    }
    return undefined;
  })();
  if (!candidate) return undefined;

  const out: VersionUnsupportedDetails = {};
  if (Array.isArray(candidate.supported_versions)) {
    const versions = candidate.supported_versions.filter((v: unknown): v is string => typeof v === 'string');
    if (versions.length > 0) out.supported_versions = versions;
  }
  if (typeof candidate.requested_version === 'string') {
    out.requested_version = candidate.requested_version;
  }
  if (typeof candidate.build_version === 'string') {
    out.build_version = candidate.build_version;
  }
  // Return undefined when the envelope was structurally present but empty —
  // matches "seller didn't actually populate the spec'd fields" semantics.
  return Object.keys(out).length > 0 ? out : undefined;
}
