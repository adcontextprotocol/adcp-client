import { randomBytes } from 'node:crypto';
import { serializeDictionary, type InnerList, type Item } from 'structured-headers';
import { WEB_BOT_AUTH_TAG } from './constants';

/** HTTP statuses the WBA profile uses for transport failures (WBA §5.3, §5.4). */
export type WebBotAuthStatus = 400 | 403 | 429;

/**
 * Experimental (AdCP 3.3). A Web Bot Auth verification failure, expressed as
 * the HTTP status and headers WBA defines instead of a `request_signature_*`
 * code. `reason` is a server-side diagnostic only: it never goes on the wire,
 * because the profile's error body carries no signature-specific detail.
 */
export class WebBotAuthError extends Error {
  readonly status: WebBotAuthStatus;
  /** Diagnostic for logs. Never echoed to the caller. */
  readonly reason: string;
  /** Response headers, including `Accept-Signature` on a `403`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Label the failure concerns, when known. */
  readonly label: string;
  /** A replayed nonce: `Accept-Signature` carries a verifier-chosen nonce. */
  readonly freshNonce: boolean;

  constructor(
    reason: string,
    options: {
      status?: WebBotAuthStatus;
      label?: string;
      freshNonce?: boolean;
      acceptSignature?: boolean;
      /** Every WBA label on the request, in order, so a relay learns what it must cover. */
      labels?: readonly string[];
      cause?: unknown;
    } = {}
  ) {
    super(reason, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'WebBotAuthError';
    this.reason = reason;
    this.status = options.status ?? 403;
    this.label = options.label ?? 'sig1';
    this.freshNonce = options.freshNonce === true;
    this.headers =
      this.status === 403 && options.acceptSignature !== false
        ? {
            'Accept-Signature': acceptSignatureHeader(
              options.labels && options.labels.length > 0 ? options.labels : [this.label],
              options.freshNonce === true ? this.label : undefined
            ),
          }
        : {};
  }

  /** Generic AdCP error body: no signature-specific detail (spec R2). */
  responseBody(): { errors: [{ code: string; message: string }] } {
    return this.status === 429
      ? { errors: [{ code: 'RATE_LIMITED', message: 'Too many requests' }] }
      : { errors: [{ code: 'AUTH_INVALID', message: 'Request authentication failed' }] };
  }
}

/**
 * Experimental (AdCP 3.3). The signer's identity verified, but it has no
 * authority for this request: a revoked key, an unbound origin outside the
 * anonymous surface, or an operator record that no longer lists the origin.
 * Uses the AdCP authorization envelope and carries no `Accept-Signature`, so a
 * signer does not keep retrying with the same key.
 */
export class WebBotAuthAuthorizationError extends WebBotAuthError {
  constructor(reason: string, options: { cause?: unknown } = {}) {
    super(reason, { status: 403, acceptSignature: false, ...options });
    this.name = 'WebBotAuthAuthorizationError';
  }

  override responseBody(): { errors: [{ code: string; message: string }] } {
    return { errors: [{ code: 'PERMISSION_DENIED', message: 'Agent is not authorized for this request' }] };
  }
}

/**
 * Components and parameters the profile requires, per RFC 9421 §5.1: one
 * member per label, where each later label must also cover the earlier
 * labels' `signature-agent`, `signature-input`, and `signature` members
 * (relays, WBA §5.2.2). `freshNonceLabel` gets a verifier-chosen nonce, as a
 * replayed request does (RFC 9421 §7.2.2).
 */
export function acceptSignatureHeader(labels: string | readonly string[], freshNonceLabel?: string): string {
  const list = (typeof labels === 'string' ? [labels] : labels).map(safeLabel);
  const dictionary = new Map<string, InnerList>();
  list.forEach((label, index) => {
    const components: Item[] = ['@method', '@target-uri', '@authority', 'content-type', 'content-digest'].map(name => [
      name,
      new Map(),
    ]);
    components.push(['signature-agent', new Map([['key', label]])]);
    for (const earlier of list.slice(0, index)) {
      for (const field of ['signature-agent', 'signature-input', 'signature']) {
        components.push([field, new Map([['key', earlier]])]);
      }
    }
    const params = new Map<string, string | boolean>([
      ['created', true],
      ['expires', true],
      ['nonce', freshNonceLabel === label ? randomBytes(32).toString('base64url') : true],
      ['keyid', true],
      ['tag', WEB_BOT_AUTH_TAG],
    ]);
    dictionary.set(label, [components, params]);
  });
  return serializeDictionary(dictionary);
}

function safeLabel(label: string): string {
  return /^[a-z*][a-z0-9_\-.*]{0,63}$/.test(label) ? label : 'sig1';
}
