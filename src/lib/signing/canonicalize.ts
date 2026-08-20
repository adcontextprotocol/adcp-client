import { RequestSignatureError } from './errors';

export interface RequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

/**
 * RFC 9421 response-signing context. Carries the response status and
 * headers/body, plus the originating request method + URL so derived
 * components that bind back to the request context (`@method`,
 * `@target-uri`, `@authority`) resolve correctly.
 */
export interface ResponseLike {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
  /**
   * Originating request context. `url` must be absolute because
   * `@target-uri` and `@authority` are parsed with `new URL(...)`. Supply
   * `headers` when signing request-qualified header components such as
   * `authorization;req`.
   */
  request: { method: string; url: string; headers?: Record<string, string | string[] | undefined> };
}

export interface SignatureParams {
  created: number;
  expires: number;
  nonce: string;
  keyid: string;
  alg: string;
  tag: string;
}

const DEFAULT_PARAM_ORDER: ReadonlyArray<keyof SignatureParams> = [
  'created',
  'expires',
  'nonce',
  'keyid',
  'alg',
  'tag',
];

const STRING_PARAMS = new Set<keyof SignatureParams>(['nonce', 'keyid', 'alg', 'tag']);

const SUPPORTED_DERIVED = new Set(['@method', '@target-uri', '@authority', '@status']);

export type RequestCanonicalizationProfile = 'legacy' | '3.2';

export function canonicalTargetUri(rawUrl: string, profile: RequestCanonicalizationProfile = 'legacy'): string {
  const u = parseCanonicalUrl(rawUrl, profile);
  if (profile === 'legacy' && (u.username || u.password)) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      '@target-uri must not include userinfo; strip credentials before signing'
    );
  }
  const assembled = `${u.protocol}//${u.host}${u.pathname}`;
  const normalizedTarget = uppercasePercentEncoding(decodeUnreservedPercentEncoding(assembled));
  if (profile === '3.2') {
    const fragmentless = rawUrl.split('#', 1)[0] ?? rawUrl;
    const queryIndex = fragmentless.indexOf('?');
    return normalizedTarget + (queryIndex < 0 ? '' : fragmentless.slice(queryIndex));
  }
  return uppercasePercentEncoding(decodeUnreservedPercentEncoding(`${assembled}${u.search}`));
}

export function canonicalAuthority(rawUrl: string, profile: RequestCanonicalizationProfile = 'legacy'): string {
  const u = parseCanonicalUrl(rawUrl, profile);
  if (profile === 'legacy' && (u.username || u.password)) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      '@authority must not include userinfo; strip credentials before signing'
    );
  }
  return u.host.toLowerCase();
}

export function canonicalMethod(method: string): string {
  return method.toUpperCase();
}

export function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (v === undefined) return undefined;
      if (Array.isArray(v)) {
        return v.map(entry => entry.trim()).join(', ');
      }
      return v.trim();
    }
  }
  return undefined;
}

/**
 * Build the RFC 9421 §2.5 signature base.
 *
 * When `signatureParamsValue` is supplied (verifier path), the function emits
 * it verbatim as the value of the `@signature-params` line — this preserves
 * byte-identity with the `Signature-Input` header a peer actually sent, even
 * if their param order differs from ours. When omitted (signer path), the
 * function formats from `params` using a fixed canonical order.
 */
export function buildSignatureBase(
  components: ReadonlyArray<string>,
  request: RequestLike,
  params: SignatureParams,
  signatureParamsValue?: string,
  canonicalizationProfile: RequestCanonicalizationProfile = 'legacy'
): string {
  const lines: string[] = [];
  for (const component of components) {
    const value = resolveComponentValue(component, request, canonicalizationProfile);
    if (value === undefined) {
      throw new RequestSignatureError(
        'request_signature_components_incomplete',
        6,
        `Covered component "${component}" not present in request`
      );
    }
    lines.push(`${formatComponentIdentifier(component)}: ${value}`);
  }
  const paramsString = signatureParamsValue ?? formatSignatureParams(components, params);
  lines.push(`"@signature-params": ${paramsString}`);
  return lines.join('\n');
}

/**
 * Build the RFC 9421 §2.5 signature base for a response.
 *
 * Resolves `@status` from `response.status`; request-qualified components
 * such as `@method;req`, `@target-uri;req`, and `@authority;req` bind to
 * `response.request`, request-qualified headers bind to
 * `response.request.headers`, and response header components resolve against
 * `response.headers`. `signatureParamsValue` has the same verifier-path
 * meaning as in {@link buildSignatureBase}.
 */
export function buildResponseSignatureBase(
  components: ReadonlyArray<string>,
  response: ResponseLike,
  params: SignatureParams,
  signatureParamsValue?: string
): string {
  const requestView: RequestLike = {
    method: response.request.method,
    url: response.request.url,
    headers: response.request.headers ?? {},
  };
  const lines: string[] = [];
  for (const component of components) {
    const { bare, requestBound } = parseComponentIdentifier(component);
    const value = resolveResponseComponentValue(bare, requestBound, response, requestView);
    if (value === undefined) {
      throw new RequestSignatureError(
        'request_signature_components_incomplete',
        6,
        `Covered component "${component}" not present in response`
      );
    }
    lines.push(`${formatComponentIdentifier(component)}: ${value}`);
  }
  const paramsString = signatureParamsValue ?? formatSignatureParams(components, params);
  lines.push(`"@signature-params": ${paramsString}`);
  return lines.join('\n');
}

export function formatSignatureParams(components: ReadonlyArray<string>, params: SignatureParams): string {
  const componentList = components.map(formatComponentIdentifier).join(' ');
  const paramPairs: string[] = [];
  for (const key of DEFAULT_PARAM_ORDER) {
    const raw = params[key];
    if (raw === undefined) continue;
    paramPairs.push(STRING_PARAMS.has(key) ? `${key}="${raw}"` : `${key}=${raw}`);
  }
  return `(${componentList});${paramPairs.join(';')}`;
}

function parseComponentIdentifier(component: string): { bare: string; requestBound: boolean } {
  if (!component.includes(';')) return { bare: component, requestBound: false };
  const [bare, ...params] = component.split(';');
  const unsupported = params.filter(param => param !== 'req');
  if (unsupported.length > 0) {
    throw new RequestSignatureError(
      'request_signature_components_unexpected',
      6,
      `Covered component "${component}" uses unsupported component parameters`
    );
  }
  return {
    bare: bare ?? component,
    requestBound: params.includes('req'),
  };
}

function formatComponentIdentifier(component: string): string {
  const { bare, requestBound } = parseComponentIdentifier(component);
  return `"${bare}"${requestBound ? ';req' : ''}`;
}

function resolveResponseComponentValue(
  bare: string,
  requestBound: boolean,
  response: ResponseLike,
  requestView: RequestLike
): string | undefined {
  if (bare === '@status') {
    if (requestBound) {
      throw new RequestSignatureError(
        'request_signature_components_unexpected',
        6,
        '"@status" cannot use the request-bound ;req parameter'
      );
    }
    return String(response.status);
  }
  if (bare.startsWith('@')) {
    if (!requestBound) {
      throw new RequestSignatureError(
        'request_signature_components_unexpected',
        6,
        `Response derived component "${bare}" must use the request-bound ;req parameter`
      );
    }
    return resolveComponentValue(bare, requestView);
  }
  return getHeaderValue(requestBound ? requestView.headers : response.headers, bare);
}

function resolveComponentValue(
  component: string,
  request: RequestLike,
  canonicalizationProfile: RequestCanonicalizationProfile = 'legacy'
): string | undefined {
  if (component.startsWith('@')) {
    if (!SUPPORTED_DERIVED.has(component)) {
      throw new RequestSignatureError(
        'request_signature_components_unexpected',
        6,
        `Derived component "${component}" is not supported by the AdCP request-signing profile`
      );
    }
    switch (component) {
      case '@method':
        return canonicalMethod(request.method);
      case '@target-uri':
        return canonicalTargetUri(request.url, canonicalizationProfile);
      case '@authority':
        return canonicalAuthority(request.url, canonicalizationProfile);
      case '@status':
        throw new RequestSignatureError(
          'request_signature_components_unexpected',
          6,
          '"@status" is only valid in response-signing context; use buildResponseSignatureBase'
        );
    }
  }
  return getHeaderValue(request.headers, component);
}

function parseCanonicalUrl(rawUrl: string, profile: RequestCanonicalizationProfile): URL {
  if (profile === 'legacy') {
    rejectNonAsciiHost(rawUrl);
    return new URL(rawUrl);
  }

  const authorityMatch = rawUrl.match(/^[a-z][a-z0-9+.\-]*:\/\/([^/?#]*)/i);
  const authority = authorityMatch?.[1];
  if (!authority) {
    throw malformedTargetUri('Signed request URL must contain a non-empty authority');
  }

  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hostPort || hostPort.startsWith(':')) {
    throw malformedTargetUri('Signed request URL authority is missing its host');
  }
  if (hostPort.startsWith('[')) {
    const closingBracket = hostPort.indexOf(']');
    if (closingBracket < 0) {
      throw malformedTargetUri('Bracketed IPv6 host is missing its closing bracket');
    }
    if (hostPort.slice(0, closingBracket).includes('%')) {
      throw malformedTargetUri('IPv6 zone identifiers are not allowed in signed request URLs');
    }
  } else if ((hostPort.match(/:/g) ?? []).length > 1) {
    throw malformedTargetUri('IPv6 literals in signed request URLs must be bracketed');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw malformedTargetUri('Signed request URL is malformed');
  }

  if (!url.hostname) {
    throw malformedTargetUri('Signed request URL authority is missing its host');
  }

  if (!url.hostname.startsWith('[')) {
    let hostname = url.hostname.toLowerCase();
    if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
    if (!hostname || hostname.endsWith('.') || hostname.split('.').some(label => label.length === 0)) {
      throw malformedTargetUri('Signed request URL hostname contains an empty DNS label');
    }
    url.hostname = hostname;
  }

  return url;
}

function malformedTargetUri(message: string): RequestSignatureError {
  return new RequestSignatureError('request_target_uri_malformed', 10, message);
}

function uppercasePercentEncoding(input: string): string {
  return input.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => `%${hex.toUpperCase()}`);
}

/**
 * RFC 3986 §6.2.2.2: percent-encoded triplets of unreserved characters
 * (ALPHA / DIGIT / "-" / "." / "_" / "~") MUST be decoded to their literal
 * form during URI normalization. The spec's RFC 9421 profile step 6
 * (`@target-uri` canonicalization) requires this decode alongside the
 * uppercase-hex pass — a verifier that uppercases but does not decode will
 * produce a `%7E`-vs-`~` mismatch against a signer that decoded correctly.
 */
function decodeUnreservedPercentEncoding(input: string): string {
  return input.replace(/%([0-9a-fA-F]{2})/g, (match, hex: string) => {
    const code = parseInt(hex, 16);
    // Unreserved: A-Z (0x41-0x5A), a-z (0x61-0x7A), 0-9 (0x30-0x39),
    // "-" (0x2D), "." (0x2E), "_" (0x5F), "~" (0x7E).
    const isUnreserved =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x7e;
    return isUnreserved ? String.fromCharCode(code) : match;
  });
}

/**
 * Raw non-ASCII bytes in the URL authority (IDN U-label) are a parse-time
 * anomaly — AdCP @target-uri canonicalization expects A-labels (Punycode).
 * Reject rather than implicitly normalize: UTS-46 transitional vs.
 * non-transitional produce different A-labels for the same input, which
 * would open a signer/verifier canonicalization differential. Accepts
 * both absolute (`scheme://…`) and scheme-relative (`//…`) URL shapes.
 */
export function rejectNonAsciiHost(rawUrl: string): void {
  const authorityMatch = rawUrl.match(/^(?:[a-z][a-z0-9+.\-]*:)?\/\/([^/?#]*)/i);
  if (!authorityMatch) return;
  const authority = authorityMatch[1]!;
  for (let i = 0; i < authority.length; i++) {
    if (authority.charCodeAt(i) > 0x7f) {
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        1,
        'URL authority contains non-ASCII bytes; use the A-label (Punycode) form'
      );
    }
  }
}
