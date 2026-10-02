import { AuthenticationRequiredError } from '../errors';
import { RequestSigningErrorCodeMetadata } from '../types/enums.generated';
import { parseWWWAuthenticate } from '../auth/oauth/diagnostics';
import { redactSensitiveJsonOrText, sanitizeTransportHeaders, sanitizeTransportUrl } from './transportDiagnostics';
import { recordRawResponseCapture } from './rawResponseCapture';

const CAPTURE_BYTES = 16 * 1024;
const EXCERPT_LENGTH = 2048;
const CAPTURE_TIMEOUT_MS = 1000;
// Protocol metadata is public and short version strings would otherwise
// corrupt ordinary seller prose and JSON-RPC IDs. Unknown custom headers
// remain protected because callers can use arbitrary names for credentials.
const PUBLIC_HEADERS = new Set([
  'accept',
  'content-type',
  'content-length',
  'user-agent',
  'host',
  'a2a-version',
  'a2a-extensions',
  'adcp-version',
  'mcp-protocol-version',
  'mcp-session-id',
  'traceparent',
  'tracestate',
  'signature',
  'signature-input',
  'content-digest',
]);

/**
 * Install below the SDK signer, on the actual outbound transport. Only a
 * request carrying Signature is classified as signed; signing configuration
 * alone says nothing about unsigned discovery/housekeeping calls.
 */
export function wrapFetchWithSignedRequestRejection(upstream: typeof fetch, agentUrl?: string): typeof fetch {
  return async (input, init) => {
    const startedAt = Date.now();
    const response = await upstream(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (response.status !== 401 || !headers.has('signature')) return response;

    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // Retain only the recognized challenge code. Arbitrary descriptions and
    // realms can reflect credentials or prompt-injection text too.
    const parsed = parseWWWAuthenticate(response.headers.get('www-authenticate'));
    // A gateway's explicit credential challenge is independent of request
    // signing. Let the official client perform its existing OAuth recovery.
    if (parsed && parsed.scheme !== 'signature') return response;
    const knownCode =
      parsed?.scheme === 'signature' &&
      parsed.error &&
      Object.prototype.hasOwnProperty.call(RequestSigningErrorCodeMetadata, parsed.error);
    const challenge = parsed
      ? { scheme: parsed.scheme.slice(0, 64), ...(knownCode && { error: parsed.error }) }
      : undefined;
    const secrets = getHeaderSecrets(headers);
    const captured = await captureBody(response, secrets, init?.signal);
    // Conformance callers still get status/header evidence. Reuse the bounded,
    // redacted read so raw capture cannot buffer a second unbounded body.
    const captureHeaders = sanitizeTransportHeaders(response.headers);
    for (const key of Object.keys(captureHeaders)) {
      captureHeaders[key] = redactReflected(captureHeaders[key]!, secrets);
    }
    if (parsed) captureHeaders['www-authenticate'] = knownCode ? `Signature error="${parsed.error}"` : 'Signature';
    recordRawResponseCapture(input, init, response, captured?.body ?? '', captured?.truncated ?? true, startedAt, {
      url: sanitizeTransportUrl(url),
      headers: captureHeaders,
    });
    const body = captured?.body;
    let excerpt = body;
    if (body && body.length > EXCERPT_LENGTH) {
      let end = EXCERPT_LENGTH - 1;
      if (/[\uD800-\uDBFF]/.test(body[end - 1]!)) end--;
      excerpt = body.slice(0, end) + '…';
    }
    // A received 401 remains an authentication failure even if the caller
    // cancels while the optional diagnostic body is being captured.
    throw new AuthenticationRequiredError(sanitizeTransportUrl(agentUrl ?? url), undefined, undefined, challenge, {
      status: response.status,
      responseBody: excerpt,
    });
  };
}

/** Official clients may retain fetch failures under a transport error cause. */
export function getSignedRequestRejection(error: unknown): AuthenticationRequiredError | undefined {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    if (error instanceof AuthenticationRequiredError && error.requestSigned) return error;
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}

function getHeaderSecrets(headers: Headers): string[] {
  const secrets: string[] = [];
  headers.forEach((value, name) => {
    if (value && !PUBLIC_HEADERS.has(name)) {
      secrets.push(value);
      if (/^(authorization|proxy-authorization)$/i.test(name)) {
        const credential = value.replace(/^\S+\s+/, '');
        if (credential) secrets.push(credential);
      }
    }
  });
  return secrets;
}

/** Mask the union of matches in the original text, including overlaps. */
function redactReflected(value: string, secrets: string[]): string {
  const mask = new Uint8Array(value.length);
  for (const secret of secrets) {
    for (let from = 0; from < value.length; ) {
      const at = value.indexOf(secret, from);
      if (at < 0) break;
      mask.fill(1, at, at + secret.length);
      from = at + 1;
    }
  }
  let out = '';
  let cursor = 0;
  for (let at = 0; at < value.length; ) {
    if (!mask[at]) {
      at++;
      continue;
    }
    out += value.slice(cursor, at) + '[redacted]';
    while (at < value.length && mask[at]) at++;
    cursor = at;
  }
  return out + value.slice(cursor);
}

async function captureBody(
  response: Response,
  secrets: string[],
  signal?: AbortSignal | null
): Promise<{ body: string; truncated: boolean } | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (bytes + value.byteLength > CAPTURE_BYTES) {
            // An incomplete JSON/string value cannot be safely redacted.
            return { body: '[seller response exceeds diagnostic capture limit]', truncated: true };
          }
          chunks.push(value);
          bytes += value.byteLength;
        }
        if (cancelled) return undefined;
        let text = Buffer.concat(chunks).toString('utf8');
        // Remove exact reflected credentials, including opaque custom-header
        // values that cannot be recognized by a token-shaped regex.
        const redact = (value: string) => redactReflected(value, secrets);
        if (/^\s*[{["]/.test(text)) {
          try {
            // Decode before redaction: quotes, backslashes and Unicode escapes
            // in a reflected custom credential must not evade exact matching.
            // Redact secret fields before transforming keys, so a header value
            // such as "token" cannot disguise an access_token field. Rewrite
            // parsed keys structurally rather than touching JSON delimiters.
            const valueRedacted = JSON.stringify(
              JSON.parse(text, (_key, value) => {
                if (typeof value === 'string') return redact(value);
                if ((typeof value === 'boolean' || value === null) && secrets.includes(String(value)))
                  return '[redacted]';
                if (
                  typeof value === 'number' &&
                  secrets.some(secret => /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(secret) && Number(secret) === value)
                )
                  return '[redacted]';
                return value;
              })
            );
            text = JSON.stringify(
              JSON.parse(redactSensitiveJsonOrText(valueRedacted), (_key, value) => {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                  const out = Object.create(null);
                  for (const key of Object.keys(value)) out[redact(key)] = value[key];
                  return out;
                }
                return value;
              })
            );
          } catch {
            return { body: '[seller response is not valid diagnostic JSON]', truncated: true };
          }
        } else {
          text = redact(text);
        }
        text = redactSensitiveJsonOrText(text).replace(/[\u0000-\u001f\u007f]/g, ' ');
        return { body: text, truncated: false };
      })(),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => {
          cancel();
          resolve(undefined);
        }, CAPTURE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}
