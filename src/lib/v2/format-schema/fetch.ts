/**
 * Fetch + digest-verify a format_schema referenced from
 * `ProductFormatDeclaration.format_schema` (`{uri, digest}`).
 *
 * Implements the spec's normative fetch contract from
 * `product-format-declaration.json#format_schema`:
 *
 *   - **Transport**: https only — enforced by ssrfSafeFetch
 *     (rejects http/file/data; rejects loopback, private, link-local,
 *     CGNAT, and RFC 6761 special-use names; rejects cloud-metadata
 *     endpoints; pins outbound to resolved IP to defeat DNS rebinding).
 *   - **Redirects**: disabled — ssrfSafeFetch uses `redirect: 'manual'`,
 *     so HTTP 3xx returns the redirect response. Caller treats as a
 *     hard fail.
 *   - **Response size cap**: 1 MiB — enforced by ssrfSafeFetch
 *     `maxBodyBytes`. Over-cap rejects.
 *   - **Timeout**: 5 seconds default; caller may override but spec
 *     recommends ≤5s.
 *   - **Digest verification**: SHA-256 of response body MUST equal
 *     `digest`. Mismatch is a hard fail.
 *   - **Cache**: keyed by `uri@digest`; immutable.
 *
 * Higher-level helper:
 *   - `createCanonicalReferenceResolver()` wraps this fetcher with
 *     per-caller caching, `$ref` sandboxing, JSON Schema compilation,
 *     and non-throwing structured statuses for both `format_schema` and
 *     `platform_extensions` references.
 *
 * Out of scope for this low-level fetcher:
 *   - Stronger transparency-log / signed-body verification — tracked
 *     separately in the spec; mirror-trust hardening is future work.
 */

import { createHash } from 'crypto';
import { ssrfSafeFetch, SsrfRefusedError } from '../../net/ssrf-fetch';
import { isInternalProbesAllowed } from '../../utils/probe-policy';

/** Reference to a format schema, mirroring `platform-extension-ref.json`. */
export interface FormatSchemaRef {
  uri: string;
  /** `sha256:` prefix + 64 lowercase hex characters. */
  digest: string;
}

/**
 * Error codes from {@link fetchFormatSchema}. Mirror the spec's
 * normative failure modes so SDK callers can surface them on the
 * response `errors[]` array with consistent codes.
 */
export type FormatSchemaFetchErrorCode =
  /** URI/digest pair fails basic shape checks (non-https URI, malformed digest). */
  | 'invalid_ref'
  /** SSRF guard refused (private IP, loopback, link-local, scheme, ...). */
  | 'ssrf_refused'
  /** HTTP response was a redirect (3xx) — auto-follow is disabled. */
  | 'redirect_blocked'
  /** Non-2xx HTTP status. */
  | 'http_error'
  /** Response body exceeded 1 MiB cap. */
  | 'body_too_large'
  /** Response body wasn't valid JSON. */
  | 'invalid_json'
  /** SHA-256 of body didn't match the supplied digest. */
  | 'digest_mismatch'
  /** Network/timeout failure. */
  | 'network_error';

export class FormatSchemaFetchError extends Error {
  readonly code: FormatSchemaFetchErrorCode;
  readonly uri: string;
  readonly digest?: string;
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: FormatSchemaFetchErrorCode,
    message: string,
    meta: { uri: string; digest?: string; httpStatus?: number; details?: Record<string, unknown> }
  ) {
    super(message);
    this.name = 'FormatSchemaFetchError';
    this.code = code;
    this.uri = meta.uri;
    this.digest = meta.digest;
    this.httpStatus = meta.httpStatus;
    this.details = meta.details;
  }
}

export interface FormatSchemaFetchResult {
  /** The parsed JSON schema document. */
  schema: Record<string, unknown>;
  /** Echo of the input ref (handy for downstream caching). */
  ref: FormatSchemaRef;
  /**
   * Whether the result was served from the in-process cache. Helpful
   * for telemetry; fresh fetches and cache hits both return successful
   * results.
   */
  fromCache: boolean;
}

export interface FetchFormatSchemaOptions {
  /**
   * Fetch timeout in ms. Default 5_000 per spec recommendation
   * ("SDKs SHOULD apply a fetch timeout ≤5 seconds").
   */
  timeoutMs?: number;
  /**
   * Hard cap on response body bytes. Default 1 MiB per spec. Lower this
   * for tight environments; do not raise above the spec ceiling.
   */
  maxBodyBytes?: number;
  /**
   * Caller-scoped test/dev opt-in for loopback/private HTTP fetches.
   * Production callers should leave this false. IMDS/link-local
   * metadata endpoints remain blocked by `ssrfSafeFetch`.
   */
  allowInternalReferences?: boolean;
  /**
   * Override the module-level cache. Useful when callers want
   * per-session caches or to disable caching entirely
   * (`{ get: () => undefined, set: () => {} }`).
   */
  cache?: FormatSchemaCache;
}

/** Pluggable cache interface — defaults to an in-process Map. */
export interface FormatSchemaCache {
  get(key: string): FormatSchemaFetchResult | undefined;
  set(key: string, value: FormatSchemaFetchResult): void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function cloneJsonRecord<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneFetchResult(result: FormatSchemaFetchResult, fromCache: boolean): FormatSchemaFetchResult {
  return {
    schema: cloneJsonRecord(result.schema),
    ref: { ...result.ref },
    fromCache,
  };
}

function defaultCache(): FormatSchemaCache {
  const store = new Map<string, FormatSchemaFetchResult>();
  return {
    get: key => store.get(key),
    set: (key, value) => {
      store.set(key, cloneFetchResult(value, false));
    },
  };
}

let moduleCache = defaultCache();

/** Test hook: drop the module-level cache. */
export function _resetFormatSchemaCache(): void {
  moduleCache = defaultCache();
}

/**
 * Fetch and digest-verify a format_schema reference. Returns the parsed
 * schema on success; throws {@link FormatSchemaFetchError} on every
 * failure mode so callers can surface a normalized diagnostic.
 */
export async function fetchFormatSchema(
  ref: FormatSchemaRef,
  options: FetchFormatSchemaOptions = {}
): Promise<FormatSchemaFetchResult> {
  if (!ref || typeof ref.uri !== 'string' || typeof ref.digest !== 'string') {
    throw new FormatSchemaFetchError('invalid_ref', 'format_schema ref must carry { uri, digest }', {
      uri: ref?.uri ?? '<missing>',
    });
  }
  // Production: HTTPS-only per spec. Loopback test runs (gated by
  // ADCP_ALLOW_INTERNAL_PROBES=1) may use `http://` against a 127.0.0.1
  // mock — same opt-in pattern as the discovery layer.
  const allowHttp = options.allowInternalReferences === true || isInternalProbesAllowed();
  if (!ref.uri.startsWith('https://') && !(allowHttp && ref.uri.startsWith('http://'))) {
    throw new FormatSchemaFetchError('invalid_ref', 'format_schema.uri must use https:// (spec normative)', {
      uri: ref.uri,
    });
  }
  if (!DIGEST_RE.test(ref.digest)) {
    throw new FormatSchemaFetchError(
      'invalid_ref',
      'format_schema.digest must be `sha256:` + 64 lowercase hex characters',
      { uri: ref.uri, digest: ref.digest }
    );
  }

  const cache = options.cache ?? moduleCache;
  const cacheKey = `${ref.uri}@${ref.digest}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cloneFetchResult(cached, true);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let response;
  try {
    response = await ssrfSafeFetch(ref.uri, {
      method: 'GET',
      timeoutMs,
      maxBodyBytes,
      headers: {
        accept: 'application/schema+json, application/json',
      },
      // Internal-probes opt-in mirrors the discovery layer — production
      // stays HTTPS+non-private; loopback tests opt in via env.
      allowPrivateIp: allowHttp,
    });
  } catch (err) {
    if (err instanceof SsrfRefusedError) {
      if (err.code === 'body_exceeds_limit') {
        throw new FormatSchemaFetchError('body_too_large', err.message, { uri: ref.uri, digest: ref.digest });
      }
      throw new FormatSchemaFetchError('ssrf_refused', `SSRF guard refused: ${err.message}`, {
        uri: ref.uri,
        digest: ref.digest,
        details: { code: err.code, hostname: err.hostname },
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish over-cap from generic network errors so callers can
    // surface the spec's "body_too_large is a hard fail" semantics.
    if (/body too large|maxBodyBytes/i.test(message)) {
      throw new FormatSchemaFetchError('body_too_large', message, { uri: ref.uri, digest: ref.digest });
    }
    throw new FormatSchemaFetchError('network_error', message, { uri: ref.uri, digest: ref.digest });
  }

  // Spec: "HTTP redirects MUST be disabled." ssrfSafeFetch uses
  // `redirect: 'manual'`, so 3xx returns the redirect response. Treat
  // as a hard fail per the spec.
  if (response.status >= 300 && response.status < 400) {
    throw new FormatSchemaFetchError(
      'redirect_blocked',
      `HTTP redirect (${response.status}) — auto-follow disabled per spec`,
      {
        uri: ref.uri,
        digest: ref.digest,
        httpStatus: response.status,
      }
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new FormatSchemaFetchError('http_error', `HTTP ${response.status}`, {
      uri: ref.uri,
      digest: ref.digest,
      httpStatus: response.status,
    });
  }

  const bodyBytes = response.body;
  const actualDigest = `sha256:${createHash('sha256').update(bodyBytes).digest('hex')}`;
  if (actualDigest !== ref.digest) {
    throw new FormatSchemaFetchError(
      'digest_mismatch',
      `digest mismatch: expected ${ref.digest}, got ${actualDigest}`,
      { uri: ref.uri, digest: ref.digest, details: { actualDigest } }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(bodyBytes));
  } catch (err) {
    throw new FormatSchemaFetchError(
      'invalid_json',
      `response body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { uri: ref.uri, digest: ref.digest }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FormatSchemaFetchError(
      'invalid_json',
      'response body is not a JSON object (JSON Schema documents are objects)',
      { uri: ref.uri, digest: ref.digest }
    );
  }

  const result: FormatSchemaFetchResult = {
    schema: parsed as Record<string, unknown>,
    ref: { ...ref },
    fromCache: false,
  };
  cache.set(cacheKey, result);
  return cloneFetchResult(result, false);
}
