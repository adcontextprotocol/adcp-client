/**
 * Experimental (AdCP 3.3) Web Bot Auth signing: request signatures and the
 * signed key-directory response an origin publishes.
 *
 * Request signing is opt-in. Nothing in the SDK emits `Signature-Agent`
 * unless the caller selects this profile; the RFC 9421 profile signer is
 * unchanged, so counterparties whose verifiers reject extra covered
 * components keep working.
 */
import { createHash, randomBytes, sign as nodeSign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { serializeDictionary, type InnerList, type Item } from 'structured-headers';
import type { RequestLike } from '../canonicalize';
import { getHeaderValue } from '../canonicalize';
import type { SigningProvider } from '../provider';
import type { AdcpJsonWebKey, AdcpSignAlg } from '../types';
import {
  KEY_DIRECTORY_MAX_KEYS,
  KEY_DIRECTORY_MEDIA_TYPE,
  KEY_DIRECTORY_PATH,
  KEY_DIRECTORY_TAG,
  WBA_MAX_NONCE_LENGTH,
  WBA_MAX_SIGNATURE_LIFETIME_SECONDS,
  WBA_MIN_NONCE_LENGTH,
  WEB_BOT_AUTH_TAG,
} from './constants';
import { directoryKeyAlgorithm, publicDirectoryKey, toPrivateKeyObject } from './keys';
import { webBotAuthOrigin } from './origin';
import { isInnerList, parseStrictDictionary, wbaSignatureBase, type HeaderBag } from './structured';

/** A WBA signing key. `keyid`, when given, must equal the key's thumbprint. */
export interface WebBotAuthSignerKey {
  /** Private JWK (with `d`), PKCS#8 PEM, or private `KeyObject`. Ed25519 or P-256. */
  privateKey: AdcpJsonWebKey | KeyObject | string;
  keyid?: string;
}

export interface SignWebBotAuthRequestOptions {
  /** This agent's origin. Its key directory must list the signing key. */
  agentOrigin: string;
  /** Signature label. Default `sig1`. */
  label?: string;
  /** Signature `created` (epoch seconds). Defaults to `now()`. */
  created?: number;
  now?: () => number;
  /** `expires - created`, at most 300. Default 300. */
  expiresInSeconds?: number;
  /** Nonce with at least 128 bits of entropy. Defaults to 32 random bytes. */
  nonce?: string;
}

export interface PreparedWebBotAuthSignature {
  label: string;
  keyid: string;
  alg: AdcpSignAlg;
  member: InnerList;
  /** Outbound headers before `Signature` is attached. */
  headers: Record<string, string>;
  base: string;
}

export interface SignedWebBotAuthRequest {
  /** All outbound headers: the request's own plus the WBA signature fields. */
  headers: Record<string, string>;
  signatureBase: string;
  keyid: string;
  origin: string;
}

const OWNED_HEADERS = new Set(['signature', 'signature-input', 'signature-agent', 'content-digest']);

/**
 * Canonicalize a request for WBA signing. The signature covers `@method`,
 * `@target-uri`, `@authority`, the covered `Signature-Agent` member naming the
 * origin, and, for a request with a body, `content-type` and `content-digest`.
 * Parameters: `created`, `expires`, `nonce`, thumbprint `keyid`, `alg`, and
 * `tag="web-bot-auth"`.
 */
export function prepareWebBotAuthRequestSignature(
  request: RequestLike,
  identity: { keyid: string; alg: AdcpSignAlg },
  options: SignWebBotAuthRequestOptions
): PreparedWebBotAuthSignature {
  const origin = webBotAuthOrigin(options.agentOrigin);
  const label = options.label ?? 'sig1';
  if (!/^[a-z*][a-z0-9_\-.*]{0,63}$/.test(label)) throw new TypeError('Invalid signature label');
  const lifetime = options.expiresInSeconds ?? WBA_MAX_SIGNATURE_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > WBA_MAX_SIGNATURE_LIFETIME_SECONDS) {
    throw new TypeError(`expiresInSeconds must be an integer in (0, ${WBA_MAX_SIGNATURE_LIFETIME_SECONDS}]`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(identity.keyid)) {
    throw new TypeError('Web Bot Auth keyid must be the key’s RFC 7638 thumbprint');
  }
  for (const name of ['signature', 'signature-input', 'signature-agent']) {
    if (getHeaderValue(request.headers, name) !== undefined) {
      throw new TypeError('Request is already signed; a relay must add its own label covering earlier signatures');
    }
  }
  const created = options.created ?? (options.now ? options.now() : Math.floor(Date.now() / 1000));
  if (!Number.isInteger(created)) throw new TypeError('created must be an integer');
  const nonce = options.nonce ?? randomBytes(32).toString('base64url');
  if (nonce.length < WBA_MIN_NONCE_LENGTH || nonce.length > WBA_MAX_NONCE_LENGTH) {
    throw new TypeError('nonce must carry at least 128 bits of entropy and be at most 256 characters');
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || OWNED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.map(v => v.trim()).join(', ') : value.trim();
  }
  headers['Signature-Agent'] = serializeDictionary(new Map([[label, [origin, new Map()]]]));
  const components: Array<string | [string, Record<string, string>]> = ['@method', '@target-uri', '@authority'];
  const body = request.body ?? '';
  if (body.length > 0) {
    if (getHeaderValue(headers, 'content-type') === undefined) {
      throw new TypeError('Body-bearing Web Bot Auth requests require Content-Type');
    }
    headers['Content-Digest'] = sha256Digest(body);
    components.push('content-type', 'content-digest');
  }
  components.push(['signature-agent', { key: label }]);
  const member: InnerList = [
    components.map(c => (typeof c === 'string' ? [c, new Map()] : [c[0], new Map(Object.entries(c[1]))])),
    new Map<string, string | number>([
      ['created', created],
      ['expires', created + lifetime],
      ['nonce', nonce],
      ['keyid', identity.keyid],
      ['alg', identity.alg],
      ['tag', WEB_BOT_AUTH_TAG],
    ]),
  ];
  const base = wbaSignatureBase({ method: request.method, url: request.url, headers }, member);
  headers['Signature-Input'] = serializeDictionary(new Map([[label, member]]));
  return { label, keyid: identity.keyid, alg: identity.alg, member, headers, base };
}

/** Attach `Signature` (RFC 8941 Base64) to a prepared request signature. */
export function finalizeWebBotAuthRequestSignature(
  prepared: PreparedWebBotAuthSignature,
  signature: Uint8Array,
  origin: string
): SignedWebBotAuthRequest {
  const headers = { ...prepared.headers };
  headers['Signature'] = serializeDictionary(new Map([[prepared.label, [toArrayBuffer(signature), new Map()]]]));
  return { headers, signatureBase: prepared.base, keyid: prepared.keyid, origin };
}

/** Sign a request under the Web Bot Auth profile with an in-process key. */
export function signWebBotAuthRequest(
  request: RequestLike,
  key: WebBotAuthSignerKey,
  options: SignWebBotAuthRequestOptions
): SignedWebBotAuthRequest {
  const privateKey = toPrivateKeyObject(key.privateKey);
  const jwk = publicDirectoryKey(privateKey);
  if (key.keyid !== undefined && key.keyid !== jwk.kid) {
    throw new TypeError('Web Bot Auth keyid must be the key’s RFC 7638 thumbprint');
  }
  const alg = directoryKeyAlgorithm(jwk);
  const prepared = prepareWebBotAuthRequestSignature(request, { keyid: jwk.kid, alg }, options);
  return finalizeWebBotAuthRequestSignature(
    prepared,
    produceSignature(alg, privateKey, prepared.base),
    webBotAuthOrigin(options.agentOrigin)
  );
}

/**
 * Sign with a {@link SigningProvider} (KMS). The provider's `keyid` must be
 * its public key's thumbprint; pass `publicKey` to have the SDK check it.
 */
export async function signWebBotAuthRequestAsync(
  request: RequestLike,
  provider: Pick<SigningProvider, 'keyid' | 'algorithm' | 'sign'> & { publicKey?: AdcpJsonWebKey },
  options: SignWebBotAuthRequestOptions
): Promise<SignedWebBotAuthRequest> {
  if (provider.publicKey !== undefined) {
    const jwk = publicDirectoryKey(provider.publicKey);
    if (jwk.kid !== provider.keyid || directoryKeyAlgorithm(jwk) !== provider.algorithm) {
      throw new TypeError('Signing provider keyid/algorithm do not match its public key thumbprint');
    }
  }
  const prepared = prepareWebBotAuthRequestSignature(
    request,
    { keyid: provider.keyid, alg: provider.algorithm },
    options
  );
  const signature = await provider.sign(new Uint8Array(Buffer.from(prepared.base, 'utf8')));
  return finalizeWebBotAuthRequestSignature(prepared, signature, webBotAuthOrigin(options.agentOrigin));
}

// ---------------------------------------------------------------------------
// Key directories (WBA §5.5, Appendix B.1)
// ---------------------------------------------------------------------------

/** A key-directory HTTP response, as served and as retained for audit. */
export interface KeyDirectoryResponse {
  status: number;
  headers: Record<string, string>;
  /** Exact response bytes as UTF-8 text. */
  body: string;
}

export interface SignedKeyDirectory extends KeyDirectoryResponse {
  status: 200;
  /** Earliest signature `expires`: republish before this instant. */
  expires: number;
  created: number;
  keys: AdcpJsonWebKey[];
}

export interface SignKeyDirectoryOptions {
  agentOrigin: string;
  /** Private keys to publish, 1–100. Each signs the response once. */
  privateKeys: ReadonlyArray<AdcpJsonWebKey | KeyObject | string>;
  created?: number;
  now?: () => number;
  /** Signature lifetime in seconds. Default 86,400 (one day). */
  expiresInSeconds?: number;
  /** `Cache-Control` max-age. Default 300 (verifiers cache at most 5 minutes). */
  maxAgeSeconds?: number;
}

/**
 * Generate a signed key-directory response for `/.well-known/http-message-signatures-directory`.
 * Serve `body` byte for byte with `headers`. Each key signs once, covering
 * `"@authority";req` and `content-digest`, so the key set cannot be replayed
 * from another domain. Re-sign before {@link SignedKeyDirectory.expires};
 * see {@link keyDirectoryNeedsRenewal}. Private material never enters the body.
 */
export function signKeyDirectory(options: SignKeyDirectoryOptions): SignedKeyDirectory {
  const origin = webBotAuthOrigin(options.agentOrigin);
  const privateKeys = options.privateKeys.map(key => toPrivateKeyObject(key));
  if (privateKeys.length < 1 || privateKeys.length > KEY_DIRECTORY_MAX_KEYS) {
    throw new TypeError(`A key directory holds 1–${KEY_DIRECTORY_MAX_KEYS} keys`);
  }
  const lifetime = options.expiresInSeconds ?? 86_400;
  if (!Number.isInteger(lifetime) || lifetime <= 0) throw new TypeError('expiresInSeconds must be a positive integer');
  const keys = privateKeys.map(key => publicDirectoryKey(key));
  if (new Set(keys.map(key => key.kid)).size !== keys.length) throw new TypeError('Directory keys must be distinct');
  const created = options.created ?? (options.now ? options.now() : Math.floor(Date.now() / 1000));
  const maxAge = options.maxAgeSeconds ?? 300;
  if (!Number.isInteger(created) || created < 0) throw new TypeError('created must be a non-negative integer');
  if (!Number.isInteger(maxAge) || maxAge < 0) throw new TypeError('maxAgeSeconds must be a non-negative integer');
  const body = JSON.stringify({ keys });
  const headers: Record<string, string> = {
    'Content-Type': KEY_DIRECTORY_MEDIA_TYPE,
    'Content-Digest': sha256Digest(body),
    'Cache-Control': `max-age=${maxAge}`,
  };
  const inputs = new Map<string, InnerList>();
  const signatures = new Map<string, Item>();
  const request = { method: 'GET', url: origin + KEY_DIRECTORY_PATH, headers };
  keys.forEach((jwk, index) => {
    const alg = directoryKeyAlgorithm(jwk);
    const member: InnerList = [
      [
        ['@authority', new Map([['req', true]])],
        ['content-digest', new Map()],
      ],
      new Map<string, string | number>([
        ['created', created],
        ['expires', created + lifetime],
        ['keyid', jwk.kid],
        ['alg', alg],
        ['tag', KEY_DIRECTORY_TAG],
      ]),
    ];
    const label = `key${index + 1}`;
    inputs.set(label, member);
    const base = wbaSignatureBase(request, member, { directoryResponse: true });
    signatures.set(label, [toArrayBuffer(produceSignature(alg, privateKeys[index]!, base)), new Map()]);
  });
  headers['Signature-Input'] = serializeDictionary(inputs);
  headers['Signature'] = serializeDictionary(signatures);
  return { status: 200, headers, body, created, expires: created + lifetime, keys };
}

/**
 * Whether a published directory must be re-signed: its earliest signature
 * expires within `renewBeforeSeconds` (default one hour), or its headers do
 * not parse. Use from a scheduled job before the signatures lapse.
 */
export function keyDirectoryNeedsRenewal(
  headers: HeaderBag,
  options: { now?: () => number; renewBeforeSeconds?: number } = {}
): boolean {
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const expires = keyDirectoryExpiry(headers);
  return expires === undefined || expires - now <= (options.renewBeforeSeconds ?? 3600);
}

/** Earliest `expires` across a directory's signatures, or `undefined`. */
export function keyDirectoryExpiry(headers: HeaderBag): number | undefined {
  try {
    const inputs = parseStrictDictionary(getHeaderValue(headers, 'signature-input'), 'Signature-Input');
    let earliest: number | undefined;
    for (const member of inputs.values()) {
      if (!isInnerList(member)) return undefined;
      const expires = member[1].get('expires');
      if (typeof expires !== 'number' || !Number.isInteger(expires)) return undefined;
      earliest = earliest === undefined ? expires : Math.min(earliest, expires);
    }
    return earliest;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** RFC 9530 `Content-Digest` with an RFC 8941 Base64 SHA-256 value. */
export function sha256Digest(body: string | Uint8Array): string {
  const digest = createHash('sha256')
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest();
  return serializeDictionary(new Map([['sha-256', [toArrayBuffer(digest), new Map()]]]));
}

/** Strict digest check: one `sha-256` member that equals the body hash. */
export function sha256DigestMatches(header: string | undefined, body: string | Uint8Array): boolean {
  const dictionary = parseStrictDictionary(header, 'Content-Digest');
  const entry = dictionary.get('sha-256');
  if (!entry || isInnerList(entry) || !(entry[0] instanceof ArrayBuffer)) return false;
  const expected = createHash('sha256')
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest();
  const actual = Buffer.from(entry[0]);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function produceSignature(alg: AdcpSignAlg, key: KeyObject, base: string): Uint8Array {
  const data = Buffer.from(base, 'utf8');
  if (alg === 'ed25519') return new Uint8Array(nodeSign(null, data, key));
  return new Uint8Array(nodeSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }));
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
