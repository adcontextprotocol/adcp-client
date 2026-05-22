import { createHmac, timingSafeEqual } from 'crypto';

export type WebhookHeaderValue = string | number | readonly string[] | null | undefined;
export type WebhookHeadersLike = Headers | Record<string, WebhookHeaderValue>;

export type VerifyWebhookFailureReason =
  | 'missing_secret'
  | 'missing_headers'
  | 'ambiguous_headers'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'malformed_signature'
  | 'bad_signature';

export interface VerifyWebhookRequestOptions {
  /**
   * Raw HTTP body bytes captured before JSON parsing. Strings are interpreted
   * as UTF-8; pass Buffer/Uint8Array when your framework exposes bytes.
   */
  rawBody: string | Buffer | Uint8Array;
  /**
   * Shared HMAC secret. `globalSecret` is accepted as an alias for callers
   * matching ADCP_WEBHOOK_SECRET naming.
   */
  secret?: string;
  globalSecret?: string;
  /**
   * Headers object from your framework. Header names are matched
   * case-insensitively.
   */
  headers?: WebhookHeadersLike;
  /** Explicit x-adcp-signature header value. When `headers` is also provided, it must match. */
  signature?: WebhookHeaderValue;
  /** Explicit x-adcp-timestamp header value. When `headers` is also provided, it must match. */
  timestamp?: WebhookHeaderValue;
  /** Allowed absolute timestamp skew in seconds. Defaults to 300. */
  skewSeconds?: number;
  /** Current unix time in seconds. Defaults to `Date.now() / 1000`. */
  now?: () => number;
}

export type VerifyWebhookRequestResult =
  | {
      ok: true;
      signature: string;
      timestamp: number;
      verifiedAt: number;
    }
  | {
      ok: false;
      reason: VerifyWebhookFailureReason;
      message: string;
    };

/**
 * Verify a legacy AdCP HMAC-SHA256 webhook request.
 *
 * This verifies the deprecated `x-adcp-signature: sha256=...` +
 * `x-adcp-timestamp` profile. Spec-current webhook verification uses RFC 9421
 * via `verifyWebhookSignature` / `createWebhookVerifier` from
 * `@adcp/sdk/signing/server`.
 */
export function verifyWebhookRequest(options: VerifyWebhookRequestOptions): VerifyWebhookRequestResult {
  const secret = options.secret ?? options.globalSecret;
  if (!secret) {
    return fail('missing_secret', 'A webhook HMAC secret is required.');
  }

  const signature = resolveHeader('x-adcp-signature', options.signature, options.headers);
  if (signature.reason) return fail(signature.reason, signature.message);

  const timestamp = resolveHeader('x-adcp-timestamp', options.timestamp, options.headers);
  if (timestamp.reason) return fail(timestamp.reason, timestamp.message);

  if (!signature.value || !timestamp.value) {
    return fail('missing_headers', 'Webhook is missing x-adcp-signature or x-adcp-timestamp.');
  }

  const parsedTimestamp = parseTimestamp(timestamp.value);
  if (parsedTimestamp === undefined) {
    return fail('invalid_timestamp', 'x-adcp-timestamp must be an integer unix timestamp in seconds.');
  }

  const now = options.now ? Math.floor(options.now()) : Math.floor(Date.now() / 1000);
  const skewSeconds = options.skewSeconds ?? 300;
  if (!Number.isFinite(skewSeconds) || skewSeconds < 0) {
    return fail('invalid_timestamp', 'skewSeconds must be a non-negative number.');
  }
  if (Math.abs(now - parsedTimestamp) > skewSeconds) {
    return fail('stale_timestamp', `Webhook timestamp is outside the allowed ${skewSeconds}s skew window.`);
  }

  if (!/^sha256=[a-f0-9]{64}$/.test(signature.value)) {
    return fail('malformed_signature', 'x-adcp-signature must match sha256=<64 lowercase hex chars>.');
  }

  const hmac = createHmac('sha256', secret);
  hmac.update(String(parsedTimestamp), 'utf8');
  hmac.update('.', 'utf8');
  hmac.update(toBodyBytes(options.rawBody));
  const expected = `sha256=${hmac.digest('hex')}`;

  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(signature.value, 'utf8');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return fail('bad_signature', 'Webhook HMAC signature does not match the request body and timestamp.');
  }

  return {
    ok: true,
    signature: signature.value,
    timestamp: parsedTimestamp,
    verifiedAt: now,
  };
}

function fail(reason: VerifyWebhookFailureReason, message: string): VerifyWebhookRequestResult {
  return { ok: false, reason, message };
}

function toBodyBytes(rawBody: string | Buffer | Uint8Array): Buffer | Uint8Array {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
}

function parseTimestamp(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resolveHeader(
  name: string,
  explicit: WebhookHeaderValue,
  headers: WebhookHeadersLike | undefined
): { value?: string; reason?: VerifyWebhookFailureReason; message: string } {
  const explicitValue = normalizeHeaderValue(explicit);
  const headerValue: { value?: string; reason?: VerifyWebhookFailureReason; message: string } = headers
    ? readHeader(headers, name)
    : { message: '' };

  if (explicitValue.reason) return explicitValue;
  if (headerValue.reason) return headerValue;
  if (explicitValue.value && headerValue.value && explicitValue.value !== headerValue.value) {
    return {
      reason: 'ambiguous_headers',
      message: `Explicit ${name} does not match the header bag.`,
    };
  }
  return explicitValue.value ? explicitValue : headerValue;
}

function readHeader(
  headers: WebhookHeadersLike,
  name: string
): { value?: string; reason?: VerifyWebhookFailureReason; message: string } {
  if (isHeaders(headers)) {
    const value = headers.get(name);
    if (value?.includes(',')) {
      return {
        reason: 'ambiguous_headers',
        message: `Multiple ${name} header values were provided.`,
      };
    }
    return normalizeHeaderValue(value);
  }

  const matches: WebhookHeaderValue[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) matches.push(value);
  }

  if (matches.length > 1) {
    return {
      reason: 'ambiguous_headers',
      message: `Multiple ${name} headers were provided with different casing.`,
    };
  }

  const normalized = normalizeHeaderValue(matches[0]);
  if (normalized.value?.includes(',')) {
    return {
      reason: 'ambiguous_headers',
      message: `Multiple ${name} header values were provided.`,
    };
  }
  return normalized;
}

function normalizeHeaderValue(value: WebhookHeaderValue): {
  value?: string;
  reason?: VerifyWebhookFailureReason;
  message: string;
} {
  if (value == null) return { message: '' };
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return {
        reason: 'ambiguous_headers',
        message: 'Expected exactly one webhook header value.',
      };
    }
    return normalizeHeaderValue(value[0]);
  }
  const normalized = String(value).trim();
  return normalized ? { value: normalized, message: '' } : { message: '' };
}

function isHeaders(headers: WebhookHeadersLike): headers is Headers {
  return typeof (headers as Headers).get === 'function';
}
