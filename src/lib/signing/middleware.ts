import type { RequestLike } from './canonicalize';
import { getHeaderValue } from './canonicalize';
import { RequestSignatureError } from './errors';
import { verifyRequestSignature, type VerifyRequestOptions } from './verifier';
import type { VerifiedSigner } from './types';

declare module 'http' {
  interface IncomingMessage {
    verifiedSigner?: VerifiedSigner;
    rawBody?: string;
  }
}

export interface ExpressLike {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
  body?: unknown;
  protocol?: string;
  get?(header: string): string | undefined;
  [key: string]: unknown;
}

export interface ExpressMiddlewareOptions extends Omit<VerifyRequestOptions, 'operation'> {
  resolveOperation: (req: ExpressLike) => string;
  /**
   * Override how the request's full URL is reconstructed. Use when the server
   * sits behind a TLS-terminating or path-rewriting load balancer, since
   * `req.protocol`/`req.get('host')` may not reflect what the signer signed.
   * Must return the exact URL the signer used (scheme + authority + path + query).
   */
  getUrl?: (req: ExpressLike) => string;
}

type NextFn = (err?: unknown) => void;

export function createExpressVerifier(options: ExpressMiddlewareOptions) {
  return async function requestSignatureMiddleware(
    req: ExpressLike,
    res: { status: (code: number) => { set: (k: string, v: string) => { json: (body: unknown) => void } } },
    next: NextFn
  ): Promise<void> {
    try {
      const url = options.getUrl ? options.getUrl(req) : defaultUrl(req);
      const body = resolveRawBody(req);
      const requestLike: RequestLike = {
        method: req.method,
        url,
        headers: req.headers,
        body,
      };
      const verified = await verifyRequestSignature(requestLike, {
        ...options,
        operation: options.resolveOperation(req),
      });
      req.verifiedSigner = verified;
      next();
    } catch (err) {
      if (err instanceof RequestSignatureError) {
        // `failed_step` is informational per spec; keep it in server-side logs
        // rather than the 401 body so anonymous callers can't enumerate the
        // verifier pipeline.
        res.status(401).set('WWW-Authenticate', `Signature error="${err.code}"`).json({
          error: err.code,
          message: err.message,
        });
        return;
      }
      next(err);
    }
  };
}

function resolveRawBody(req: ExpressLike): string {
  if (typeof req.rawBody === 'string') return req.rawBody;
  const contentLengthHeader = getHeaderValue(req.headers, 'content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
  if (Number.isFinite(contentLength) && contentLength > 0) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      'req.rawBody is required for signed requests with a body; install a raw-body capture middleware ahead of createExpressVerifier'
    );
  }
  return '';
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
