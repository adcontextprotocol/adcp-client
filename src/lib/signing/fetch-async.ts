import type { CoverContentDigestPredicate, SigningFetchOptions } from './fetch';
import type { SigningProvider } from './provider';
import type { SignRequestOptions } from './signer';
import { signRequestAsync } from './signer-async';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const SIGNING_RESERVED_HEADERS = new Set(['signature', 'signature-input', 'content-digest']);

/**
 * Async-signing variant of `createSigningFetch`. Identical request
 * extraction and reserved-header policy; differs only in routing through a
 * {@link SigningProvider}, which may issue a network call to a managed key
 * store on every signed request. Returns the same `FetchLike` shape so the
 * wrapped function is interchangeable with the sync-signed variant from
 * the caller's point of view.
 *
 * The split between {@link createSigningFetch} (sync inner) and this helper
 * is deliberate: hover docs and the function name surface the latency-cost
 * distinction at integration time. Use the sync entry point with an
 * in-memory `SignerKey`; use this one with a KMS-backed `SigningProvider`.
 *
 * Keep in sync with `createSigningFetch` in `./fetch.ts` — reserved-header
 * policy, content-type defaulting, and `Request`-rejection are line-for-line
 * parallel.
 */
export function createSigningFetchAsync(
  upstream: FetchLike,
  provider: SigningProvider,
  options: SigningFetchOptions = {}
): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const shouldSign = options.shouldSign ?? (() => method !== 'GET');
    if (!shouldSign(url, init)) return upstream(input, init);

    if (input instanceof Request) {
      throw new TypeError(
        'createSigningFetchAsync does not accept Request objects (the body would be consumed out from under the signer). Pass a URL string and a separate init.'
      );
    }

    const headers = headersToRecord(init?.headers);
    for (const name of Object.keys(headers)) {
      if (SIGNING_RESERVED_HEADERS.has(name.toLowerCase())) {
        delete headers[name];
      }
    }
    const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType && (init?.body !== undefined || method !== 'GET')) {
      headers['content-type'] = 'application/json';
    }
    const body = bodyToString(init?.body);

    const coverContentDigest =
      typeof options.coverContentDigest === 'function'
        ? (options.coverContentDigest as CoverContentDigestPredicate)(url, init)
        : options.coverContentDigest;
    const { coverContentDigest: _omit, ...signerOptionsBase } = options;
    const signerOptions: SignRequestOptions = { ...signerOptionsBase, coverContentDigest };

    const signed = await signRequestAsync({ method, url, headers, body }, provider, signerOptions);

    const mergedInit: RequestInit = { ...init, method, headers: signed.headers };
    if (body !== undefined && mergedInit.body === undefined) mergedInit.body = body;
    return upstream(url, mergedInit);
  };
}

function headersToRecord(headers: HeadersInit | Headers | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...(headers as Record<string, string>) };
}

function bodyToString(body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  throw new TypeError(
    'createSigningFetchAsync requires a string, Uint8Array, or ArrayBuffer body. FormData / Blob / ReadableStream are not supported because the signature must cover the exact wire bytes.'
  );
}
