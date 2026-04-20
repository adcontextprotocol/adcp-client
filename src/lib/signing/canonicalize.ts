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
  const u = new URL(rawUrl);
  if (u.username || u.password) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      '@target-uri must not include userinfo; strip credentials before signing'
    );
  }
  const assembled = `${u.protocol}//${u.host}${u.pathname}${u.search}`;
  return uppercasePercentEncoding(decodeUnreservedPercentEncoding(assembled));
}

export function canonicalAuthority(rawUrl: string): string {
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
