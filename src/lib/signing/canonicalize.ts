import { RequestSignatureError } from './errors';

export interface RequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
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

const SUPPORTED_DERIVED = new Set(['@method', '@target-uri', '@authority']);

export function canonicalTargetUri(rawUrl: string): string {
  rejectNonAsciiHost(rawUrl);
  const u = new URL(rawUrl);
  if (u.username || u.password) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      '@target-uri must not include userinfo; strip credentials before signing'
    );
  }
  const assembled = `${u.protocol}//${u.host}${u.pathname}${u.search}`;
  return decodeUnreservedPercentEncoding(uppercasePercentEncoding(assembled));
}

export function canonicalAuthority(rawUrl: string): string {
  rejectNonAsciiHost(rawUrl);
  const u = new URL(rawUrl);
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
  signatureParamsValue?: string
): string {
  const lines: string[] = [];
  for (const component of components) {
    const value = resolveComponentValue(component, request);
    if (value === undefined) {
      throw new RequestSignatureError(
        'request_signature_components_incomplete',
        6,
        `Covered component "${component}" not present in request`
      );
    }
    lines.push(`"${component}": ${value}`);
  }
  const paramsString = signatureParamsValue ?? formatSignatureParams(components, params);
  lines.push(`"@signature-params": ${paramsString}`);
  return lines.join('\n');
}

export function formatSignatureParams(components: ReadonlyArray<string>, params: SignatureParams): string {
  const componentList = components.map(c => `"${c}"`).join(' ');
  const paramPairs: string[] = [];
  for (const key of DEFAULT_PARAM_ORDER) {
    const raw = params[key];
    if (raw === undefined) continue;
    paramPairs.push(STRING_PARAMS.has(key) ? `${key}="${raw}"` : `${key}=${raw}`);
  }
  return `(${componentList});${paramPairs.join(';')}`;
}

function resolveComponentValue(component: string, request: RequestLike): string | undefined {
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
        return canonicalTargetUri(request.url);
      case '@authority':
        return canonicalAuthority(request.url);
    }
  }
  return getHeaderValue(request.headers, component);
}

function uppercasePercentEncoding(input: string): string {
  return input.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => `%${hex.toUpperCase()}`);
}

/**
 * RFC 3986 §6.2.2.2: percent-encoded unreserved characters (ALPHA / DIGIT /
 * "-" / "." / "_" / "~") MUST be decoded in the canonical URI. A verifier
 * that skips this step reads `%7E` and `~` as different bytes, breaking
 * signature comparison when a signer emits either form.
 */
function decodeUnreservedPercentEncoding(input: string): string {
  return input.replace(/%([0-9A-F]{2})/g, (match, hex: string) => {
    const code = parseInt(hex, 16);
    const isAlpha = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const isDigit = code >= 0x30 && code <= 0x39;
    const isUnreservedPunct = code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e;
    if (isAlpha || isDigit || isUnreservedPunct) return String.fromCharCode(code);
    return match;
  });
}

/**
 * Raw non-ASCII bytes in the URL authority (IDN U-label) are a parse-time
 * anomaly — AdCP @target-uri canonicalization expects A-labels (Punycode).
 * Reject rather than implicitly normalize: UTS-46 transitional vs.
 * non-transitional produce different A-labels for the same input, which
 * would open a signer/verifier canonicalization differential.
 */
function rejectNonAsciiHost(rawUrl: string): void {
  const authorityMatch = rawUrl.match(/^[a-z][a-z0-9+.\-]*:\/\/([^/?#]*)/i);
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
