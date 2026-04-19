import { createPrivateKey, randomBytes, sign as nodeSign, type JsonWebKey } from 'crypto';
import {
  buildSignatureBase,
  formatSignatureParams,
  signRequest,
  REQUEST_SIGNING_TAG,
  type AdcpJsonWebKey,
  type RequestLike,
  type SignatureParams,
  type SignerKey,
} from '../../../signing';
import { findKey } from './vector-loader';
import type { NegativeVector, PositiveVector, TestKeyset, TestKeypair } from './types';

export interface BuildOptions {
  /** Override the signer clock (unix seconds). Defaults to `Date.now()/1000`. */
  now?: number;
  /** Override the nonce. Defaults to freshly-generated. */
  nonce?: string;
  /** Override the `expires - created` window (seconds). Defaults to 300. */
  windowSeconds?: number;
  /**
   * Agent base URL. When set, the vector's request URL has its origin replaced
   * with this base before signing — the vectors point at `seller.example.com`
   * but real agents live elsewhere. The path and query are preserved so the
   * operation intent (e.g., `/adcp/create_media_buy`) is unchanged.
   *
   * Canonicalization-edge vectors (005 default-port, 006 dot-segment path,
   * 007 query preservation, 008 percent-encoded path) bake their edge case
   * into the vector URL; replacing the origin keeps that edge intact in the
   * path/query, but vectors sensitive to the port or scheme will no longer
   * exercise the edge against a mismatched agent base.
   */
  baseUrl?: string;
}

export interface SignedHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function buildPositiveRequest(
  vector: PositiveVector,
  keys: TestKeyset,
  options: BuildOptions = {}
): SignedHttpRequest {
  const key = signerKeyFor(vector, keys);
  return sign(key, vector, {
    coverContentDigest: vector.verifier_capability.covers_content_digest === 'required',
    ...options,
  });
}

/**
 * Apply the adversarial mutation documented for a negative vector.
 *
 * Black-box grader: the positive/001 signature bytes sitting in most negative
 * fixtures are placeholders; we re-sign dynamically, then mutate. Covers all
 * 20 current negative vectors. Stateful contract vectors (016 replay, 017
 * revoked, 020 rate abuse) produce a single well-formed request; the
 * storyboard runner orchestrates the repeat/flood/revoked-keyid behavior
 * around that request per the signed-requests-runner test-kit.
 */
export function buildNegativeRequest(
  vector: NegativeVector,
  keys: TestKeyset,
  options: BuildOptions = {}
): SignedHttpRequest {
  const mutation = MUTATIONS[vector.id];
  if (!mutation) {
    throw new Error(`No adversarial builder registered for negative vector "${vector.id}"`);
  }
  return mutation(vector, keys, options);
}

export function listSupportedNegativeVectors(): string[] {
  return Object.keys(MUTATIONS);
}

type Mutator = (vector: NegativeVector, keys: TestKeyset, options: BuildOptions) => SignedHttpRequest;

const MUTATIONS: Record<string, Mutator> = {
  '001-no-signature-header': (vector, _keys, options) => ({
    method: vector.request.method,
    url: retargetUrl(vector.request.url, options.baseUrl),
    headers: stripSignatureHeaders(vector.request.headers),
    body: vector.request.body,
  }),

  '002-wrong-tag': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return signWithParamOverride(key, vector, options, { tag: 'example-org/signing/v1' });
  },

  '003-expired-signature': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    const now = nowSeconds(options);
    return sign(key, vector, { ...options, now: now - 600, windowSeconds: 300 });
  },

  '004-window-too-long': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return signWithParamOverride(key, vector, options, {
      expiresDelta: 301,
    });
  },

  '005-alg-not-allowed': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return signWithParamOverride(key, vector, options, { alg: 'rsa-pss-sha512' });
  },

  '006-missing-covered-component': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return signWithComponents(key, vector, options, ['@method', '@target-uri', 'content-type']);
  },

  '007-missing-content-digest': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return sign(key, vector, { ...options, coverContentDigest: false });
  },

  '008-unknown-keyid': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return signWithParamOverride(key, vector, options, { keyid: 'unknown-key-9999' });
  },

  '009-key-ops-missing-verify': (vector, keys, options) => {
    // Vector 009 pins `jwks_ref: ["test-gov-2026"]` (adcp_use:
    // governance-signing, not request-signing) — use it directly instead of
    // inferring. Honors the vector's intent if future keysets add a second
    // non-request-signing keypair.
    const key = signerKeyFor(vector, keys);
    return sign(key, vector, options);
  },

  '010-content-digest-mismatch': (vector, keys, options) => {
    // Vector 010 tests "signer committed a wrong Content-Digest value" — the
    // signature IS valid over the base that includes that wrong value, so the
    // verifier passes the signature check (step 10) and then fails the
    // digest-vs-body recompute (step 11). Do NOT mutate the body post-sign —
    // that tests a different bug (body-tampered-in-transit) and a verifier
    // that recomputes digest from sent body would not catch the "lying
    // signer" path this vector exercises.
    const key = signerKeyFor(vector, keys);
    // Zero-byte digest: guaranteed not to match the actual body.
    const zeroDigest = 'sha-256=:' + Buffer.alloc(32).toString('base64') + ':';
    const headersWithBadDigest = { ...vector.request.headers, 'Content-Digest': zeroDigest };
    const vectorWithBadDigest = {
      ...vector,
      request: { ...vector.request, headers: headersWithBadDigest },
    };
    // Sign the request WITH content-digest in covered components, without
    // letting `signRequest` recompute the digest over the real body.
    return signWithComponents(
      key,
      vectorWithBadDigest,
      options,
      ['@method', '@target-uri', '@authority', 'content-type', 'content-digest']
    );
  },

  '011-malformed-header': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    const signed = sign(key, vector, options);
    return {
      ...signed,
      headers: {
        ...signed.headers,
        'Signature-Input': 'sig1=not a valid structured-field value!!!',
      },
    };
  },

  '012-missing-expires-param': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return signWithParamOverride(key, vector, options, { omitExpires: true });
  },

  '013-expires-le-created': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return signWithParamOverride(key, vector, options, { expiresDelta: 0 });
  },

  '014-missing-nonce-param': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return signWithParamOverride(key, vector, options, { omitNonce: true });
  },

  '015-signature-invalid': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    const signed = sign(key, vector, options);
    const zeroSig = Buffer.alloc(64).toString('base64url');
    return {
      ...signed,
      headers: {
        ...signed.headers,
        Signature: `sig1=:${zeroSig}:`,
      },
    };
  },

  '016-replayed-nonce': (vector, keys, options) => {
    // Black-box runner sends the request twice; first accepted, second rejected.
    // Builder produces the single well-formed request used for both submissions.
    const key = signerKeyFor(vector, keys);
    return sign(key, vector, options);
  },

  '017-key-revoked': (vector, keys, options) => {
    // Use the dedicated revoked key (`test-revoked-2026`) declared by the
    // signed-requests-runner test-kit. For current pre-#2353 caches, vector 017
    // still references test-ed25519-2026; fall back to whatever the vector says.
    const kid = vector.jwks_ref[0];
    if (!kid) throw new Error(`${vector.id}: jwks_ref missing`);
    const key = keyFor(keys, kid);
    return sign(key, vector, options);
  },

  '018-digest-covered-when-forbidden': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    return sign(key, vector, { ...options, coverContentDigest: true });
  },

  '019-signature-without-signature-input': (vector, keys, options) => {
    const key = signerKeyFor(vector, keys);
    const signed = sign(key, vector, options);
    const { 'Signature-Input': _drop, ...rest } = signed.headers;
    return { ...signed, headers: rest };
  },

  '020-rate-abuse': (vector, keys, options) => {
    // Runner floods the agent with distinct-nonce requests from the same keyid.
    // Builder produces a single well-formed request; the runner generates N
    // distinct nonces by calling this builder repeatedly with `options.nonce`.
    const key = signerKeyFor(vector, keys);
    return sign(key, vector, options);
  },
};

// ── Primitives ────────────────────────────────────────────────

interface SignArgs extends BuildOptions {
  coverContentDigest?: boolean;
}

function sign(key: SignerKey, vector: PositiveVector | NegativeVector, args: SignArgs): SignedHttpRequest {
  const url = retargetUrl(vector.request.url, args.baseUrl);
  const request: RequestLike = {
    method: vector.request.method,
    url,
    headers: vector.request.headers,
    body: vector.request.body,
  };
  const signed = signRequest(request, key, {
    coverContentDigest: args.coverContentDigest === true,
    now: args.now !== undefined ? () => args.now! : undefined,
    nonce: args.nonce,
    windowSeconds: args.windowSeconds,
  });
  return {
    method: vector.request.method,
    url,
    headers: mergeHeaders(vector.request.headers, signed.headers),
    body: vector.request.body,
  };
}

function retargetUrl(vectorUrl: string, baseUrl: string | undefined): string {
  if (!baseUrl) return vectorUrl;
  const v = new URL(vectorUrl);
  const b = new URL(baseUrl);
  v.protocol = b.protocol;
  v.host = b.host;
  // Prefix the agent's mount path (from baseUrl) ahead of the vector's path
  // so agents mounted at e.g. `/v1/adcp/*` receive requests at
  // `/v1/adcp/create_media_buy` rather than the bare `/adcp/create_media_buy`
  // the vector carries. When baseUrl has no path (or just `/`), this is a
  // no-op. Canonicalization-edge vectors (005–008) bake their edge into the
  // vector's path/query; we preserve those bytes by joining, not replacing.
  if (b.pathname && b.pathname !== '/') {
    const mount = b.pathname.replace(/\/+$/, '');
    const vectorPath = v.pathname.startsWith('/') ? v.pathname : `/${v.pathname}`;
    v.pathname = `${mount}${vectorPath}`;
  }
  return v.toString();
}

interface ParamOverride {
  tag?: string;
  alg?: string;
  keyid?: string;
  expiresDelta?: number;
  omitExpires?: boolean;
  omitNonce?: boolean;
}

/**
 * Build a signature base with overridden params, sign it directly, and emit
 * the headers. Needed when the mutation lives in `@signature-params` itself
 * (tag, alg, keyid, expires, nonce) — signRequest won't emit those exact
 * malformations.
 */
function signWithParamOverride(
  key: SignerKey,
  vector: PositiveVector | NegativeVector,
  options: BuildOptions,
  override: ParamOverride
): SignedHttpRequest {
  const url = retargetUrl(vector.request.url, options.baseUrl);
  const request: RequestLike = {
    method: vector.request.method,
    url,
    headers: vector.request.headers,
    body: vector.request.body,
  };
  const hasBody = (request.body ?? '').length > 0;
  const components = hasBody
    ? ['@method', '@target-uri', '@authority', 'content-type']
    : ['@method', '@target-uri', '@authority'];

  const now = nowSeconds(options);
  const windowSeconds = options.windowSeconds ?? 300;
  const params: SignatureParams = {
    created: now,
    expires: now + (override.expiresDelta ?? windowSeconds),
    nonce: options.nonce ?? randomNonce(),
    keyid: override.keyid ?? key.keyid,
    alg: override.alg ?? key.alg,
    tag: override.tag ?? REQUEST_SIGNING_TAG,
  };

  const paramsString = formatParamsWithOmissions(components, params, override);
  const base = buildSignatureBase(components, request, params, paramsString);
  const signature = produceSignature(key, Buffer.from(base, 'utf8'));

  return {
    method: vector.request.method,
    url,
    headers: {
      ...vector.request.headers,
      'Signature-Input': `sig1=${paramsString}`,
      Signature: `sig1=:${Buffer.from(signature).toString('base64url')}:`,
    },
    body: vector.request.body,
  };
}

function signWithComponents(
  key: SignerKey,
  vector: PositiveVector | NegativeVector,
  options: BuildOptions,
  components: string[]
): SignedHttpRequest {
  const url = retargetUrl(vector.request.url, options.baseUrl);
  const request: RequestLike = {
    method: vector.request.method,
    url,
    headers: vector.request.headers,
    body: vector.request.body,
  };
  const now = nowSeconds(options);
  const windowSeconds = options.windowSeconds ?? 300;
  const params: SignatureParams = {
    created: now,
    expires: now + windowSeconds,
    nonce: options.nonce ?? randomNonce(),
    keyid: key.keyid,
    alg: key.alg,
    tag: REQUEST_SIGNING_TAG,
  };
  const paramsString = formatSignatureParams(components, params);
  const base = buildSignatureBase(components, request, params, paramsString);
  const signature = produceSignature(key, Buffer.from(base, 'utf8'));
  return {
    method: vector.request.method,
    url,
    headers: {
      ...vector.request.headers,
      'Signature-Input': `sig1=${paramsString}`,
      Signature: `sig1=:${Buffer.from(signature).toString('base64url')}:`,
    },
    body: vector.request.body,
  };
}

function formatParamsWithOmissions(
  components: ReadonlyArray<string>,
  params: SignatureParams,
  override: ParamOverride
): string {
  const componentList = components.map(c => `"${c}"`).join(' ');
  const pairs: string[] = [];
  pairs.push(`created=${params.created}`);
  if (!override.omitExpires) pairs.push(`expires=${params.expires}`);
  if (!override.omitNonce) pairs.push(`nonce="${params.nonce}"`);
  pairs.push(`keyid="${params.keyid}"`);
  pairs.push(`alg="${params.alg}"`);
  pairs.push(`tag="${params.tag}"`);
  return `(${componentList});${pairs.join(';')}`;
}

function produceSignature(key: SignerKey, data: Buffer): Uint8Array {
  const privateKey = createPrivateKey({ key: key.privateKey as JsonWebKey, format: 'jwk' });
  if (key.alg === 'ed25519') {
    return new Uint8Array(nodeSign(null, data, privateKey));
  }
  return new Uint8Array(nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
}

// ── Helpers ───────────────────────────────────────────────────

function signerKeyFor(vector: PositiveVector | NegativeVector, keys: TestKeyset): SignerKey {
  const kid = vector.jwks_ref[0];
  if (!kid) throw new Error(`${vector.id}: jwks_ref is empty`);
  return keyFor(keys, kid);
}

function keyFor(keys: TestKeyset, kid: string): SignerKey {
  const keypair = findKey(keys, kid);
  return toSignerKey(keypair);
}

function toSignerKey(keypair: TestKeypair): SignerKey {
  const alg: SignerKey['alg'] = keypair.crv === 'Ed25519' ? 'ed25519' : 'ecdsa-p256-sha256';
  const privateKey: AdcpJsonWebKey = {
    kid: keypair.kid,
    kty: keypair.kty,
    crv: keypair.crv,
    alg: keypair.alg,
    use: keypair.use,
    key_ops: ['sign'],
    adcp_use: keypair.adcp_use,
    x: keypair.x,
    y: keypair.y,
    d: keypair.private_d,
  };
  return { keyid: keypair.kid, alg, privateKey };
}

function stripSignatureHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'signature' || lower === 'signature-input' || lower === 'content-digest') continue;
    out[k] = v;
  }
  return out;
}

function mergeHeaders(
  from: Record<string, string>,
  signed: Record<string, string>
): Record<string, string> {
  // Drop original Signature/Signature-Input/Content-Digest before overlaying fresh ones.
  const base = stripSignatureHeaders(from);
  return { ...base, ...signed };
}

function nowSeconds(options: BuildOptions): number {
  return options.now ?? Math.floor(Date.now() / 1000);
}

function randomNonce(): string {
  return randomBytes(16).toString('base64url');
}
