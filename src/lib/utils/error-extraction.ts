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
 * Extract an AdCP error from an MCP tool response.
 *
 * Detection order (per transport error mapping spec):
 * 1. structuredContent.adcp_error — source 'structuredContent', level 3
 * 2. JSON.parse(content[].text).adcp_error — source 'text_json', level 2
 * 3. Pattern matching on error text for known codes — source 'text_pattern', level 1
 *
 * Returns null if no AdCP error is detected.
 */
export function extractAdcpErrorFromMcp(response: any): ExtractedAdcpError | null {
  if (!response) return null;

  // Path 1: structuredContent.adcp_error (L3) — only check error responses
  if (response.isError) {
    const structured = response.structuredContent?.adcp_error;
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
 * Extract an AdCP error from a JSON-RPC transport error.
 * Checks error.data.adcp_error for structured transport-level errors
 * (e.g., -32029 rate limit from infrastructure).
 */
export function extractAdcpErrorFromTransport(error: any): ExtractedAdcpError | null {
  const adcpError = error?.data?.adcp_error;
  if (adcpError && typeof adcpError.code === 'string') {
    return buildExtracted(adcpError, 'structuredContent', 3);
  }

  // Fall back to message pattern matching
  const message = error instanceof Error ? error.message : error?.message || String(error);
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
  // CONFLICT omitted from pattern matching — too ambiguous as a common English word
];

function matchStandardCode(text: string): StandardErrorCode | null {
  for (const [pattern, code] of CODE_PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return null;
}
