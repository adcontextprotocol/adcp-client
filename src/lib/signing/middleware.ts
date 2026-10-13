import type { RequestLike } from './canonicalize';
import { getHeaderValue } from './canonicalize';
import { RequestSignatureError } from './errors';
import { InMemoryReplayStore } from './replay';
import { InMemoryRevocationStore } from './revocation';
import { assertUnsignedRequestAllowed, verifyRequestSignature, type VerifyRequestOptions } from './verifier';
import { isUnresolvableOperation, type ResolvedOperation } from './operation-resolution';
import type { VerifiedSigner } from './types';
import {
  assertNoRfc9421Downgrade,
  authenticateWebBotAuthRequest,
  jsonRpcMethod,
  resolveWebBotAuthConfig,
  type WebBotAuthVerifierConfig,
} from './wba/authorize';
import { warnRfc9421ProfileDeprecated } from './wba/deprecation';
import { WebBotAuthAuthorizationError, WebBotAuthError } from './wba/errors';
import { usesWebBotAuth } from './wba/verifier';

declare module 'http' {
  interface IncomingMessage {
    /**
     * Populated by {@link createExpressVerifier} iff a real signature was
     * verified. Unsigned-but-acceptable requests leave this `undefined` so
     * downstream handlers can read `req.verifiedSigner !== undefined` as
     * "signed and verified."
     */
    verifiedSigner?: VerifiedSigner;
    rawBody?: string;
  }
}

export interface ExpressLike {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Raw request bytes captured before any body parser. String or Buffer. */
  rawBody?: string | Buffer;
  body?: unknown;
  protocol?: string;
  get?(header: string): string | undefined;
  [key: string]: unknown;
}

export interface ExpressMiddlewareOptions extends Omit<
  VerifyRequestOptions,
  'operation' | 'replayStore' | 'revocationStore'
> {
  /**
   * Stores `(keyid, signature-bytes, expires)` tuples for replay detection.
   * Defaults to a fresh {@link InMemoryReplayStore} — suitable for single-process
   * deployments only. **Multi-replica deployments MUST pass an explicit shared
   * store** (Redis, Postgres, etc.) — the default in-memory store does not
   * survive process boundaries, so a signature accepted on replica A is
   * invisible to replica B and can be replayed there within the signature window.
   *
   * Replay limits are scoped by the exact signed `@target-uri`, including its
   * query string. This middleware cannot know whether multiple URLs route to
   * the same application endpoint. Direct MCP mounts MUST reject unsupported
   * query variants before this middleware (the higher-level `serve()` helper
   * already enforces its exact mount path); this store is not a replacement
   * for route validation or a global rate limiter.
   */
  replayStore?: VerifyRequestOptions['replayStore'];
  /**
   * Consulted for revoked `kid` / `jti` before accepting a signature.
   * Defaults to a fresh {@link InMemoryRevocationStore}, which starts empty
   * and does not poll for updates. The default is sufficient when you don't
   * revoke keys at runtime; when you do, pass a store backed by your secrets
   * manager or admin tooling so revocations take effect without redeployment.
   */
  revocationStore?: VerifyRequestOptions['revocationStore'];
  /**
   * Extract the AdCP operation name from the incoming request so the verifier
   * can consult `capability.required_for`. Return `undefined` for requests
   * that don't map to an AdCP operation (health checks, discovery probes) —
   * the verifier will then treat the request as "not in any required_for"
   * and accept unsigned traffic rather than rejecting.
   *
   * Return {@link UNRESOLVABLE_OPERATION} for a body that does not resolve to
   * exactly one operation; the verifier then rejects it with
   * `request_body_malformed`, signed or not. `resolveRequestOperation` (and
   * `adcpOperationResolver` from `@adcp/sdk/server`) implements the MCP and A2A
   * rules, including that fail-closed result, and is what `createAdcpServer`
   * auto-wires.
   *
   * SECURITY: a `resolveOperation` that always returns `undefined` — for
   * example, a routing helper that silently fails to match — disables
   * `required_for` enforcement globally. Unsigned requests on signed-only
   * operations will pass. Verify the implementation actually resolves the
   * operation name for every AdCP route you care to protect; a unit test
   * asserting `resolveOperation(req)` is non-undefined for sample signed
   * requests is the simplest guard.
   */
  resolveOperation: (req: ExpressLike) => ResolvedOperation;
  /**
   * Override how the request's full URL is reconstructed. Use when the server
   * sits behind a TLS-terminating or path-rewriting load balancer, since
   * `req.protocol`/`req.get('host')` may not reflect what the signer signed.
   * Must return the exact URL the signer used (scheme + authority + path + query).
   */
  getUrl?: (req: ExpressLike) => string;
  /**
   * Experimental (AdCP 3.3): also accept the Web Bot Auth profile. A request
   * carrying `Signature-Agent` or the `web-bot-auth` tag is verified under it
   * only, never under the RFC 9421 profile, and failures answer with WBA
   * statuses (`400`, `403` with `Accept-Signature`, `429`) instead of
   * `request_signature_*` codes. RFC 9421 requests keep their behavior,
   * except that an origin bound through `webBotAuth.bindings` is refused on
   * that profile (no downgrade). Omitting this option keeps the RFC 9421
   * profile only, which is deprecated in AdCP 3.3 and works through 3.x.
   */
  webBotAuth?: WebBotAuthVerifierConfig;
}

type NextFn = (err?: unknown) => void;

export function createExpressVerifier(options: ExpressMiddlewareOptions) {
  // Instantiate defaults once at wire-up so every request on this middleware
  // shares the same replay/revocation state — lazy per-request construction
  // would defeat replay detection entirely.
  const replayStore = options.replayStore ?? new InMemoryReplayStore();
  const revocationStore = options.revocationStore ?? new InMemoryRevocationStore();
  const webBotAuth = options.webBotAuth ? resolveWebBotAuthConfig(options.webBotAuth) : undefined;
  if (!webBotAuth) warnRfc9421ProfileDeprecated('verification');
  const { webBotAuth: _webBotAuth, ...rfc9421Options } = options;

  return async function requestSignatureMiddleware(
    req: ExpressLike,
    res: { status: (code: number) => { set: (k: string, v: string) => { json: (body: unknown) => void } } },
    next: NextFn
  ): Promise<void> {
    try {
      const url = options.getUrl ? options.getUrl(req) : defaultUrl(req);
      const wbaSelected = webBotAuth !== undefined && usesWebBotAuth(req.headers);
      let body: string;
      try {
        body = resolveRawBody(req);
      } catch (error) {
        // A WBA request is answered with WBA statuses, never request_signature_* codes.
        if (wbaSelected && error instanceof RequestSignatureError) {
          throw new WebBotAuthError('raw request body is unavailable', { status: 400, cause: error });
        }
        throw error;
      }
      const requestLike: RequestLike = {
        method: req.method,
        url,
        headers: req.headers,
        body,
      };
      if (wbaSelected) {
        const operation = options.resolveOperation(req);
        if (isUnresolvableOperation(operation)) {
          throw new WebBotAuthError('request body does not resolve to one operation', { status: 400 });
        }
        const rawHeaders = Array.isArray(req.rawHeaders) ? (req.rawHeaders as string[]) : undefined;
        const resolvedOperation = operation ?? jsonRpcMethod(req.method, body);
        const { signer } = await authenticateWebBotAuthRequest(
          { ...requestLike, ...(rawHeaders !== undefined && { rawHeaders }) },
          webBotAuth!,
          {
            replayStore,
            ...(options.now !== undefined && { now: options.now }),
            ...(resolvedOperation !== undefined && { operation: resolvedOperation }),
          }
        );
        if (signer) {
          req.verifiedSigner = signer;
        } else {
          // An unbound origin outside `unboundFor` proceeds exactly as an
          // anonymous caller, so the unsigned-request rules apply: an
          // operation that requires a signature needs a bound identity.
          try {
            assertUnsignedRequestAllowed(body, operation, options.capability);
          } catch (error) {
            if (error instanceof RequestSignatureError) {
              throw new WebBotAuthAuthorizationError('signer identity is not bound', { cause: error });
            }
            throw error;
          }
        }
        next();
        return;
      }
      const result = await verifyRequestSignature(requestLike, {
        ...rfc9421Options,
        replayStore,
        revocationStore,
        operation: options.resolveOperation(req),
      });
      if (result.status === 'verified' && webBotAuth) await assertNoRfc9421Downgrade(result.agent_url, webBotAuth);
      if (result.status === 'verified') {
        req.verifiedSigner = {
          keyid: result.keyid,
          agent_url: result.agent_url,
          verified_at: result.verified_at,
          ...(result.operatorRecord !== undefined && { operatorRecord: result.operatorRecord }),
        };
      }
      next();
    } catch (err) {
      if (err instanceof WebBotAuthError) {
        // WBA reports failures by status and headers only; `reason` stays in
        // server logs so callers cannot probe which check failed.
        const [name, value] = Object.entries(err.headers)[0] ?? ['Cache-Control', 'no-store'];
        res.status(err.status).set(name, value).json(err.responseBody());
        return;
      }
      if (err instanceof RequestSignatureError) {
        // `failed_step` is informational per spec; keep it in server-side logs
        // rather than the 401 body so anonymous callers can't enumerate the
        // verifier pipeline. Do NOT call next() here — Express convention is
        // that a terminal response ends the middleware chain without
        // invoking downstream handlers. Promise-based wrappers that need to
        // await completion should race against the response's 'close' event
        // rather than the next-callback.
        res.status(401).set('WWW-Authenticate', `Signature error="${err.code}"`).json({
          error: err.code,
          message: 'Request signature verification failed',
        });
        return;
      }
      next(err);
    }
  };
}

/** Methods that may carry a request body, so a missing `rawBody` is suspect. */
const BODY_BEARING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function resolveRawBody(req: ExpressLike): string {
  // The canonical raw-body recipe (`express.json({ verify })`, and this SDK's
  // own `createExpressAdapter().rawBodyVerify`) may hand back either a string
  // or the raw Buffer, so accept both rather than 401-ing a correctly wired app.
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');

  // Verifying against `''` when the request actually carried a body would
  // authenticate a surrogate: `validateCoveredComponents` derives `hasBody`
  // from this value (so the `content-type` requirement lapses) and the
  // `content-digest` check would describe the empty string, after which
  // `next()` hands a downstream parser's real body to the handler.
  //
  // So the test is for positive proof that NO body exists, not for evidence
  // that one does. Enumerating body signals cannot work: HTTP/2 forbids
  // `Transfer-Encoding` outright and makes `content-length` optional, so a
  // DATA-frame body carries neither header and would slip through a
  // signal-based check. Only a non-body-bearing method with an explicit
  // zero (or absent) length can honestly verify against `''`.
  if (BODY_BEARING_METHODS.has(req.method?.toUpperCase() ?? '') || declaresBody(req) || hasParsedBody(req)) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      'req.rawBody is required for signed requests that may carry a body. Capture it before any body ' +
        'parser runs, e.g. `app.use(express.json({ verify: adapter.rawBodyVerify }))` using ' +
        "`createExpressAdapter()`, or `app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }))`. " +
        'The capture middleware must be mounted ahead of createExpressVerifier.'
    );
  }
  return '';
}

/**
 * A `Content-Length` that is present and non-zero, or unparseable. `00`, `+0`,
 * and `0.0` are all legitimately zero; anything `Number` cannot read is treated
 * as a body so the failure direction stays closed.
 */
function declaresBody(req: ExpressLike): boolean {
  const length = getHeaderValue(req.headers, 'content-length');
  if (length !== undefined) {
    const parsed = Number(length);
    if (!Number.isFinite(parsed)) return true;
    if (parsed !== 0) return true;
  }
  return getHeaderValue(req.headers, 'transfer-encoding') !== undefined;
}

/** A body parser mounted ahead of this middleware already consumed the stream. */
function hasParsedBody(req: ExpressLike): boolean {
  const body = req.body;
  if (body === undefined || body === null) return false;
  if (typeof body === 'string') return body.length > 0;
  if (Buffer.isBuffer(body)) return body.length > 0;
  // Only a genuinely empty plain object counts as "no body" — Express sets
  // `req.body = {}` for bodiless requests. Anything else with no own enumerable
  // keys (URLSearchParams, Map, a class instance) may still hold data.
  if (typeof body === 'object') {
    const proto = Object.getPrototypeOf(body);
    const isPlainObject = proto === Object.prototype || proto === null;
    if (!isPlainObject) return true;
    return Object.keys(body as Record<string, unknown>).length > 0;
  }
  return true;
}

function defaultUrl(req: ExpressLike): string {
  const proto = req.protocol ?? (typeof req.get === 'function' ? req.get('x-forwarded-proto') : undefined) ?? 'https';
  const host = typeof req.get === 'function' ? req.get('host') : undefined;
  if (!host) {
    throw new Error(
      'Unable to derive request URL: missing Host header. Pass `getUrl` on createExpressVerifier to supply the canonical URL explicitly.'
    );
  }
  return `${proto}://${host}${req.originalUrl ?? req.url}`;
}
