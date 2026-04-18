import { signRequest, type SignerKey, type SignRequestOptions } from './signer';

export interface SigningFetchOptions extends SignRequestOptions {
  shouldSign?: (url: string, init: RequestInit | undefined) => boolean;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
    const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType && (init?.body !== undefined || method !== 'GET')) {
      headers['content-type'] = 'application/json';
    }
    const body = bodyToString(init?.body);

    const signed = signRequest({ method, url, headers, body }, key, options);

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
    'createSigningFetch requires a string, Uint8Array, or ArrayBuffer body. FormData / Blob / ReadableStream are not supported because the signature must cover the exact wire bytes.'
  );
}
