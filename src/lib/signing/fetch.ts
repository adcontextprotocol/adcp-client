import { signRequest, type SignerKey, type SignRequestOptions } from './signer';

/** Callback form for `coverContentDigest` — lets the wrapper decide per call. */
export type CoverContentDigestPredicate = (url: string, init: RequestInit | undefined) => boolean;

export interface SigningFetchOptions extends Omit<SignRequestOptions, 'coverContentDigest'> {
  shouldSign?: (url: string, init: RequestInit | undefined) => boolean;
  /**
   * Whether to cover `content-digest`. May be a boolean (static) or a
   * predicate resolved at signing time against the current request — used by
   * the AdCP agent wrapper to honor the seller's `covers_content_digest`
   * policy (`required` / `forbidden` / `either`) per operation.
   */
  coverContentDigest?: boolean | CoverContentDigestPredicate;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Header names whose wire values are produced by the signer itself. Any
 * caller-supplied value gets stripped before signing so a misconfigured
 * custom-headers bag can't silently overwrite (or bypass) the RFC 9421
 * signature output.
 */
const SIGNING_RESERVED_HEADERS = new Set(['signature', 'signature-input', 'content-digest']);

export function createSigningFetch(upstream: FetchLike, key: SignerKey, options: SigningFetchOptions = {}): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const shouldSign = options.shouldSign ?? (() => method !== 'GET');
    if (!shouldSign(url, init)) return upstream(input, init);

    if (input instanceof Request) {
      throw new TypeError(
        'createSigningFetch does not accept Request objects (the body would be consumed out from under the signer). Pass a URL string and a separate init.'
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
        ? options.coverContentDigest(url, init)
        : options.coverContentDigest;
    const { coverContentDigest: _omit, ...signerOptionsBase } = options;
    const signerOptions: SignRequestOptions = { ...signerOptionsBase, coverContentDigest };

    const signed = signRequest({ method, url, headers, body }, key, signerOptions);

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
  if (body instanceof Uint8Array) return decodeUtf8Strict(body);
  if (body instanceof ArrayBuffer) return decodeUtf8Strict(new Uint8Array(body));
  throw new TypeError(
    'createSigningFetch requires a string, Uint8Array, or ArrayBuffer body. FormData / Blob / ReadableStream are not supported because the signature must cover the exact wire bytes.'
  );
}

/**
 * Decode bytes to UTF-8, throwing on invalid sequences. Permissive decode
 * (the `Buffer.toString('utf8')` default) replaces invalid bytes with
 * `U+FFFD`, which would silently corrupt binary or non-UTF-8 payloads — the
 * signer would commit to the lossy string and the wire would carry the same
 * lossy bytes, so verification still passes but the seller receives
 * mangled content. Throwing forces the caller to send a string body or
 * ensure their Uint8Array is valid UTF-8.
 */
function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(
      'createSigningFetch received a Uint8Array/ArrayBuffer body that is not valid UTF-8. ' +
        'Pass a string body, ensure the bytes are UTF-8, or sign the request manually with `signRequest` against the exact wire bytes you intend to send.'
    );
  }
}
