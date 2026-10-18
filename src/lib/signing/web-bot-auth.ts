import { toReleasePrecisionVersion } from '../version';
/**
 * Experimental AdCP 3.3 Web Bot Auth profile, pinned to adcontextprotocol/adcp#7894
 * at e24eeb09 (docs/building/by-layer/L1/wba-profile.mdx) and IETF webbotauth-00.
 *
 * RFC 9421 parsing, signature bases and cryptographic checks run in Cloudflare's
 * `http-message-sig`. This module adds the profile rules the library does not
 * know: one `web-bot-auth` signature and one covered `Signature-Agent` member per request, the
 * nonce and lifetime rules, key lookup by (origin, thumbprint) in the origin's
 * signed key directory, replay state, and the 400/403/429 status vocabulary.
 */
import { createHash, randomBytes } from 'crypto';
import { parseDictionary, parseItem, serializeInnerList, serializeItem, type Dictionary } from 'structured-headers';
import {
  component,
  componentIdentity,
  createSignature,
  isSignatureError,
  SignatureErrorCode,
  verifySignature as verifyHttpMessageSignature,
  type ComponentDescriptor,
  type FieldOccurrence,
  type SignatureFields,
  type SignatureMessage,
  type Signer,
  type Verifier,
} from 'http-message-sig';
import { ssrfSafeFetch, type SsrfFetchOptions } from '../net';
import { eTldPlusOne } from './agent-resolver/etld';
import { canonicalAgentOrigin } from './agent-resolver/canonicalize';
import { canonicalAgentUrl } from './agent-resolver/select-agent';
import { parseStrictJson } from './agent-resolver/strict-json';
import { getHeaderValue, type RequestLike, type ResponseLike } from './canonicalize';
import { computeContentDigest, contentDigestMatches, contentDigestUsesEncoding } from './content-digest';
import { signWithPrivateJwkAsync, verifySignatureAsync } from './crypto';
import {
  parseSignature,
  parseSignatureInputMember,
  rejectDuplicateDictionaryKeys,
  type ParsedSignatureInput,
} from './parser';
import type { JwksResolver } from './jwks';
import type { ReplayStore } from './replay';
import type { AdcpJsonWebKey } from './types';
import type { SigningProvider } from './provider';

export const WEB_BOT_AUTH_PROFILE = 'web-bot-auth' as const;
export const WEB_BOT_AUTH_DRAFT_REVISION = 'draft-ietf-webbotauth-httpsig-protocol-00' as const;
export const SIGNATURE_DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const SIGNATURE_DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
/** The profile's signature algorithm: Ed25519 only. ES256 is RFC 9421 profile only. */
export const WEB_BOT_AUTH_ALGORITHMS = Object.freeze(['ed25519'] as const);
type WebBotAuthAlg = (typeof WEB_BOT_AUTH_ALGORITHMS)[number];
const DIRECTORY_TAG = 'http-message-signatures-directory';
/** Request and directory signatures are verified with this much clock skew. */
const CLOCK_SKEW_SECONDS = 60;
/** `expires` is at most this many seconds after `created`. */
const MAX_LIFETIME_SECONDS = 300;
const REQUIRED_PARAMETERS = ['created', 'expires', 'nonce', 'keyid', 'alg', 'tag'] as const;
const TEST_KIDS = new Set([
  '6WsKMCObba49V3uN0vIENnk1BKAk7c9zjBJcWKyQ9_I',
  'hHurKlVBnPJ4AGiPyl6HWMhxgkIcRBzaC8qWwEtnuVI',
  'ZtaFf5jj-EzorJmZn6mX3YnmK_QyZKVLbbinzIQKOjQ',
  '1XlJ3EIte7bPOEqKQtKrKNTNy5hywTyrwFXWrMbXKqE',
]);

/**
 * The profile's `Accept-Signature` member (RFC 9421 §5.1): the label, the
 * components the profile requires, and its parameters. A replay challenge
 * carries the fresh `nonce` the signer uses on its next attempt.
 */
export function webBotAuthAcceptSignature(label = 'sig1', hasBody = true, nonce?: string): string {
  const body = hasBody ? '"content-type" "content-digest" ' : '';
  const nonceParam = nonce === undefined ? 'nonce' : `nonce="${nonce}"`;
  return `${label}=("@method" "@target-uri" "@authority" ${body}"signature-agent";key="${label}");created;expires;${nonceParam};keyid;alg;tag="web-bot-auth"`;
}
/** 64 random bytes, unpadded Base64URL (wba-profile.mdx "Profile rules"). */
function freshNonce(): string {
  return randomBytes(64).toString('base64url');
}
/**
 * The 64 nonce bytes, or undefined. Accepts unpadded Base64URL (the profile's
 * encoding) and canonical padded Base64, which Cloudflare's `web-bot-auth`
 * emits by default; its `validateNonce` applies the same rule.
 */
function nonceBytes(nonce: unknown): Buffer | undefined {
  if (typeof nonce !== 'string') return undefined;
  const encoding = /^[A-Za-z0-9_-]{86}$/.test(nonce)
    ? 'base64url'
    : /^[A-Za-z0-9+/]{86}==$/.test(nonce)
      ? 'base64'
      : undefined;
  if (!encoding) return undefined;
  const bytes = Buffer.from(nonce, encoding);
  return bytes.length === 64 && bytes.toString(encoding) === nonce ? bytes : undefined;
}

/**
 * Outcomes that are not signature failures and must not ask the signer to
 * re-sign: a revoked key (the signer must stop using it) and refusals made
 * after verification.
 */
const NO_CHALLENGE_REASONS = new Set(['key_revoked', 'identity_not_bound', 'profile_disabled', 'authorization_failed']);
/**
 * Signature-path outcome (wba-profile.mdx "Error responses"): 400 when the
 * signature fields do not parse; 403 with `Accept-Signature` when a signature
 * fails verification or the profile rules (without it for a revoked key); 429
 * with `Accept-Signature` carrying a fresh `nonce` for a reused signature or
 * nonce. A 429 for local load shedding carries `Retry-After` instead. Any AdCP
 * body is the generic authentication error; detail stays in `reason` (logs).
 * Infrastructure the verifier depends on is reported separately by
 * {@link WebBotAuthUnavailableError}.
 */
export class WebBotAuthError extends Error {
  readonly headers: Record<string, string>;
  get body(): Record<string, unknown> {
    // Refusals made after identity was established are authorization outcomes (S3).
    if (this.reason === 'authorization_failed' || this.reason === 'identity_not_bound')
      return {
        adcp_error: { code: 'PERMISSION_DENIED', message: 'Agent authorization failed', recovery: 'correctable' },
      };
    return { adcp_error: { code: 'AUTH_INVALID', message: this.message, recovery: 'terminal' } };
  }
  /**
   * The signer's identity could not be established because key discovery
   * failed (WBA §6.10) or its revocation status is unknown. The request is
   * unverified; servers apply their unverified-request policy.
   */
  get unverified(): boolean {
    return this.reason.startsWith('directory_') || this.reason === 'identity_unverified';
  }
  constructor(
    readonly status: 400 | 403 | 429,
    readonly reason: string
  ) {
    super(
      status === 400
        ? 'Malformed Web Bot Auth message'
        : status === 429
          ? reason === 'replayed'
            ? 'Web Bot Auth signature or nonce reused'
            : 'Web Bot Auth rate limit'
          : 'Web Bot Auth verification failed'
    );
    this.name = 'WebBotAuthError';
    this.headers =
      status === 403 && !NO_CHALLENGE_REASONS.has(reason)
        ? { 'Accept-Signature': webBotAuthAcceptSignature() }
        : status === 429 && reason === 'replayed'
          ? { 'Accept-Signature': webBotAuthAcceptSignature('sig1', true, freshNonce()) }
          : status === 429
            ? { 'Retry-After': '60' }
            : {};
  }
}
/**
 * Infrastructure the verifier depends on failed (replay store, revocation
 * history store). Not a signature outcome and never answered as one: the
 * application layer decides how to report the outage (the SDK's server
 * integrations answer 503 SERVICE_UNAVAILABLE).
 */
export class WebBotAuthUnavailableError extends Error {
  constructor(
    readonly reason: string,
    cause?: unknown
  ) {
    super('Web Bot Auth verification dependency is unavailable');
    this.name = 'WebBotAuthUnavailableError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}
function bad(reason: string): never {
  throw new WebBotAuthError(400, reason);
}
function denied(reason: string): never {
  throw new WebBotAuthError(403, reason);
}
/** Point an error's `Accept-Signature` at the request's label and body shape. */
function challengeFor(error: WebBotAuthError, label: string, hasBody: boolean): WebBotAuthError {
  const current = error.headers['Accept-Signature'];
  if (current) {
    const nonce = error.status === 429 ? freshNonce() : undefined;
    error.headers['Accept-Signature'] = webBotAuthAcceptSignature(label, hasBody, nonce);
  }
  return error;
}
/**
 * The answer to an unsigned request to an operation in `required_for` from a
 * caller with no other credential the verifier accepts, when the verifier
 * advertises only `web-bot-auth`: 403 with `Accept-Signature`. A verifier that
 * also advertises the AdCP RFC 9421 profile answers as that profile does (401
 * `request_signature_required`) and adds {@link webBotAuthAcceptSignature}.
 */
export function unsignedWebBotAuthError(hasBody: boolean): WebBotAuthError {
  return challengeFor(new WebBotAuthError(403, 'signature_required'), 'sig1', hasBody);
}
/** Whether a `request_signing.profiles` advertisement names Web Bot Auth and not the AdCP RFC 9421 profile. */
export function advertisesOnlyWebBotAuth(profiles: readonly string[] | undefined): boolean {
  return !!profiles?.includes(WEB_BOT_AUTH_PROFILE) && !profiles.includes('adcp/request-signing/v1');
}

function dictionary(value: string | undefined, field: string): Dictionary {
  // An absent field is a verification failure (403 with Accept-Signature);
  // only a field that is present but does not parse is malformed (400).
  if (value === undefined || value === '') return denied('headers_missing');
  if (value.length > 64 * 1024) return bad('headers');
  try {
    rejectDuplicateDictionaryKeys(value, field);
    return parseDictionary(value);
  } catch {
    return bad('structured_field');
  }
}
export function selectSignatureProfile(request: Pick<RequestLike, 'headers'>): 'web-bot-auth' | 'rfc9421' {
  if (getHeaderValue(request.headers, 'signature-agent') !== undefined) return WEB_BOT_AUTH_PROFILE;
  const input = getHeaderValue(request.headers, 'signature-input');
  if (input && /;\s*tag\s*=\s*"web-bot-auth"/.test(input)) return WEB_BOT_AUTH_PROFILE;
  return 'rfc9421';
}
/**
 * RFC 7638 JWK SHA-256 thumbprint, synchronous. Byte-identical to jose's
 * `calculateJwkThumbprint` for OKP, EC and RSA keys (tested).
 */
export function jwkThumbprint(
  jwk: Partial<Pick<AdcpJsonWebKey, 'kty' | 'crv' | 'x' | 'y'>> & { n?: unknown; e?: unknown }
): string {
  let fields: Record<string, unknown>;
  if (jwk.kty === 'OKP' && typeof jwk.crv === 'string' && typeof jwk.x === 'string')
    fields = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  else if (jwk.kty === 'EC' && typeof jwk.crv === 'string' && typeof jwk.x === 'string' && typeof jwk.y === 'string')
    fields = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  else if (jwk.kty === 'RSA' && typeof jwk.e === 'string' && typeof jwk.n === 'string')
    fields = { e: jwk.e, kty: jwk.kty, n: jwk.n };
  else return denied('unsupported_key');
  return createHash('sha256').update(JSON.stringify(fields)).digest('base64url');
}
/** The profile algorithm a key signs with, or undefined for a key the profile cannot use. */
function keyAlgorithm(jwk: AdcpJsonWebKey): WebBotAuthAlg | undefined {
  return jwk.kty === 'OKP' && jwk.crv === 'Ed25519' ? 'ed25519' : undefined;
}
/** {@link keyAlgorithm} for a key that must be usable; any other key is unsupported (403). */
function algorithm(jwk: AdcpJsonWebKey): WebBotAuthAlg {
  return keyAlgorithm(jwk) ?? denied('unsupported_key');
}
/** {@link algorithm} for signing paths: a caller error, not a verification outcome. */
function signingAlgorithm(jwk: AdcpJsonWebKey): WebBotAuthAlg {
  try {
    return algorithm(jwk);
  } catch {
    throw new TypeError('Web Bot Auth signs with Ed25519 keys only; ES256 remains on the AdCP RFC 9421 profile');
  }
}
/**
 * Refuse a Web Bot Auth signing key the profile does not allow, at wire-up
 * time rather than on the first request.
 */
export function assertWebBotAuthSigningKey(key: WebBotSigningKey): void {
  signingAlgorithm('privateKey' in key ? key.privateKey : key.publicKey);
}
/** Every `Signature-Input` member, parsing the field once. At most `limit` members. */
function inputs(headers: RequestLike['headers'], limit: number): ParsedSignatureInput[] {
  const members = dictionary(getHeaderValue(headers, 'signature-input'), 'Signature-Input');
  if (members.size > limit) bad('signature_input');
  return [...members].map(([label, member]) => {
    try {
      return parseSignatureInputMember(label, member);
    } catch {
      return bad('signature_input');
    }
  });
}
/** Reject authority normalization differentials on received identifiers. */
export function receivedAgentOrigin(value: string): string {
  try {
    canonicalAgentUrl(value);
    const origin = canonicalAgentOrigin(value);
    if (value !== origin || /[^\x21-\x7e]/.test(value) || value.includes('%')) return denied('agent_origin');
    return origin;
  } catch {
    return denied('agent_origin');
  }
}

/**
 * @internal Diagnostic RFC 9421 signature base (§2.5), as a verifier computes
 * it from the received message. Verification itself runs in `http-message-sig`;
 * tests compare this base against the vectors' `expected_signature_base`.
 */
export function buildWebBotAuthSignatureBase(
  input: ParsedSignatureInput,
  request: RequestLike,
  response?: ResponseLike
): string {
  const lines = input.components.map(component => {
    const bare = component.split(';', 1)[0]!;
    let identifier;
    try {
      identifier = parseItem(`"${bare}"${component.slice(bare.length)}`);
    } catch {
      return bad('component');
    }
    const params = identifier[1];
    for (const [key, value] of params) {
      if (
        (key !== 'key' && key !== 'req') ||
        (key === 'key' && typeof value !== 'string') ||
        (key === 'req' && value !== true)
      )
        return bad('component_parameter');
    }
    if (params.has('req') && !response) return bad('request_bound_component');
    let value: string | undefined;
    const source = response && !params.has('req') ? response.headers : request.headers;
    if (bare.startsWith('@')) {
      if (params.has('key')) return bad('derived_dictionary');
      if (response && bare !== '@status' && !params.has('req')) return bad('response_component');
      if (bare === '@method') value = request.method.toUpperCase();
      // RFC 9421 §2.2.2/§2.2.3: the target URI as received; the authority
      // only lowercased with any default port removed. Canonical origins are
      // for identity (Signature-Agent), never for the signature base.
      else if (bare === '@target-uri') value = receivedTargetUri(request.url);
      else if (bare === '@authority') value = receivedAuthority(request.url);
      else if (bare === '@status' && response && !params.has('req')) value = String(response.status);
      else return bad('derived_component');
    } else {
      value = getHeaderValue(source, bare);
      if (params.has('key')) {
        const member = dictionary(value, bare).get(params.get('key') as string);
        if (!member) return denied('missing_member');
        // An RFC 8941 dictionary member value is an Item or Inner List.
        value = Array.isArray(member[0])
          ? serializeInnerList(member as Parameters<typeof serializeInnerList>[0])
          : serializeItem(member as Parameters<typeof serializeItem>[0]);
      }
    }
    if (value === undefined) return denied('missing_component');
    if (/[\r\n]/.test(value)) return bad('component_value');
    return `${serializeItem(identifier)}: ${value}`;
  });
  return [...lines, `"@signature-params": ${input.signatureParamsValue}`].join('\n');
}
function receivedTargetUri(url: string): string {
  try {
    new URL(url);
  } catch {
    return denied('target_uri');
  }
  return url;
}
function receivedAuthority(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return denied('target_uri');
  }
}
function assertDigest(headers: RequestLike['headers'], body: string): void {
  const digest = getHeaderValue(headers, 'content-digest');
  if (!digest || !contentDigestUsesEncoding(digest, 'rfc8941-base64') || !contentDigestMatches(digest, body))
    denied('content_digest');
}
/** An `http-message-sig` verifier over a directory key. WebCrypto where the runtime has it. */
function keyVerifier(jwk: AdcpJsonWebKey): Verifier {
  const alg = algorithm(jwk);
  return { algorithm: alg, verify: (data, signature) => verifySignatureAsync(alg, jwk, data, signature) };
}
/** A received component identifier (`name;param=...`) as an `http-message-sig` descriptor. */
function componentDescriptor(identifier: string): ComponentDescriptor {
  const bare = identifier.split(';', 1)[0]!;
  const [, params] = parseItem(`"${bare}"${identifier.slice(bare.length)}`);
  return component(bare, Object.fromEntries(params) as Record<string, string | boolean>);
}
/** Only covered fields are handed to the library, which rejects non-ASCII field content. */
function coveredFields(
  components: readonly ComponentDescriptor[],
  headers: RequestLike['headers']
): { name: string; value: string }[] {
  const names = new Set(components.filter(c => !c.name.startsWith('@')).map(c => c.name));
  return [...names].flatMap(name => {
    const value = getHeaderValue(headers, name);
    return value === undefined ? [] : [{ name, value }];
  });
}
/**
 * Verify one labelled signature with `http-message-sig`. Library refusals are
 * profile failures (403); a WBA outcome raised while resolving the key is
 * passed through unchanged.
 */
async function verifyWithLibrary(
  message: SignatureMessage,
  label: string,
  policy: {
    requiredComponents: readonly ComponentDescriptor[];
    requiredParameters: readonly string[];
    maxAge?: number;
    now: number;
  },
  resolveVerifier: () => Promise<Verifier>
): Promise<void> {
  try {
    await verifyHttpMessageSignature(message, {
      label,
      policy: { algorithms: WEB_BOT_AUTH_ALGORITHMS, clockSkew: CLOCK_SKEW_SECONDS, ...policy },
      resolveVerifier,
    });
  } catch (error) {
    if (!isSignatureError(error)) throw error;
    const cause = error.cause;
    if (cause instanceof WebBotAuthError || cause instanceof WebBotAuthUnavailableError) throw cause;
    switch (error.code) {
      case SignatureErrorCode.VerificationFailed:
        return denied('signature_invalid');
      case SignatureErrorCode.AlgorithmMismatch:
        return denied('algorithm');
      case SignatureErrorCode.PolicyViolation:
        return denied('policy');
      case SignatureErrorCode.MissingField:
        return denied('missing_component');
      case SignatureErrorCode.ResolverFailed:
        return denied('verification_unavailable');
      default:
        return denied('component');
    }
  }
}

const legacyOriginGates = new WeakMap<Function, (origin: string) => Promise<void>>();
/** @internal The standard principal resolver supplies its binding fence automatically. */
export function registerWebBotAuthLegacyOriginGate(resolver: Function, gate: (origin: string) => Promise<void>): void {
  legacyOriginGates.set(resolver, gate);
}
export function getWebBotAuthLegacyOriginGate(
  resolver: Function | undefined
): ((origin: string) => Promise<void>) | undefined {
  return resolver && legacyOriginGates.get(resolver);
}
const revocationCheckingResolvers = new WeakSet<Function>();
/** @internal The standard principal resolver declares that it checks origin revocation. */
export function registerWebBotAuthRevocationCheck(resolver: Function): void {
  revocationCheckingResolvers.add(resolver);
}
/** @internal Whether a principal resolver checks origin revocation itself. */
export function isWebBotAuthRevocationChecked(resolver: Function | undefined): boolean {
  return !!resolver && revocationCheckingResolvers.has(resolver);
}
/** @internal Application-layer answer for a verifier infrastructure outage. */
export function webBotAuthUnavailableResponse(): {
  status: 503;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    status: 503,
    headers: { 'Retry-After': '60' },
    body: {
      adcp_error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Agent identity verification is temporarily unavailable',
        recovery: 'transient',
      },
    },
  };
}
export interface WebBotAuthAuthorizationFailure {
  code: 'PERMISSION_DENIED' | 'SERVICE_UNAVAILABLE';
  message: string;
  recovery: 'correctable' | 'transient';
}
const authorizationFailures = new WeakSet<object>();
const AUTHORIZATION_FAILURE_MESSAGES = {
  key_revoked: 'Agent identity key is revoked',
  identity_not_bound: 'Agent identity is not onboarded for this operation',
  revocation_unavailable: 'Identity revocation information is unavailable',
  authorization_failed: 'Agent authorization failed',
  authorization_unavailable: 'Agent authorization is temporarily unavailable',
} as const;
export function createWebBotAuthAuthorizationFailure(
  reason: keyof typeof AUTHORIZATION_FAILURE_MESSAGES
): WebBotAuthAuthorizationFailure {
  const transient = reason === 'revocation_unavailable' || reason === 'authorization_unavailable';
  const failure: WebBotAuthAuthorizationFailure = Object.freeze({
    code: transient ? 'SERVICE_UNAVAILABLE' : 'PERMISSION_DENIED',
    message: AUTHORIZATION_FAILURE_MESSAGES[reason],
    recovery: transient ? 'transient' : 'correctable',
  });
  authorizationFailures.add(failure);
  return failure;
}
/** Transient markers win; any other coded error is a denial; uncoded errors are outages. */
function principalFailureIsTransient(error: unknown): boolean {
  const value = error as { transient?: unknown; recovery?: unknown; code?: unknown } | undefined;
  if (value?.transient === true || value?.recovery === 'transient' || value?.code === 'SERVICE_UNAVAILABLE')
    return true;
  return typeof value?.code !== 'string';
}
/**
 * @internal A principal-resolution failure on a request that carries no AdCP
 * operation (task polling, protocol methods): refuse it outright, as an
 * authorization outcome without an Accept-Signature challenge.
 */
export function webBotAuthPrincipalFailureError(error: unknown): WebBotAuthError | WebBotAuthUnavailableError {
  // An outage is answered by the application layer (503); a denial is a 403 without a challenge.
  return principalFailureIsTransient(error)
    ? new WebBotAuthUnavailableError('authorization_unavailable', error)
    : new WebBotAuthError(403, 'authorization_failed');
}
/**
 * @internal After every signature verified, a principal-resolution failure is
 * an authorization outcome, never a signature failure: carry it to tool calls
 * as a standard AdCP error instead of a 403 with Accept-Signature.
 */
export function deferWebBotAuthPrincipalFailure(
  signers: readonly VerifiedWebBotSigner[],
  error: unknown
): { principal: string; authorizationFailure: WebBotAuthAuthorizationFailure } {
  const signer = signers[signers.length - 1]!;
  const authorizationFailure = createWebBotAuthAuthorizationFailure(
    principalFailureIsTransient(error) ? 'authorization_unavailable' : 'authorization_failed'
  );
  return {
    principal: `anonymous:${createHash('sha256').update(signer.origin).digest('hex')}`,
    authorizationFailure,
  };
}
export function getWebBotAuthAuthorizationFailure(
  extra: Record<string, unknown> | undefined
): WebBotAuthAuthorizationFailure | undefined {
  for (const value of [extra?.webBotAuthAuthorization, extra?.identity33]) {
    const claim = value as { signer?: unknown; authorizationFailure?: WebBotAuthAuthorizationFailure } | undefined;
    if (
      claim &&
      isVerifiedWebBotSigner(claim.signer) &&
      claim.authorizationFailure &&
      authorizationFailures.has(claim.authorizationFailure)
    )
      return claim.authorizationFailure;
  }
  return undefined;
}
export function webBotAuthToolFailure(
  failure: WebBotAuthAuthorizationFailure,
  version?: string
): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          adcp_error: failure,
          status: 'failed',
          ...(version && { adcp_version: toReleasePrecisionVersion(version) }),
        }),
      },
    ],
  };
}
const verifiedSigners = new WeakSet<object>();
export function isVerifiedWebBotSigner(value: unknown): value is VerifiedWebBotSigner {
  return typeof value === 'object' && value !== null && verifiedSigners.has(value);
}
export interface VerifiedWebBotSigner {
  profile: 'web-bot-auth';
  origin: string;
  keyid: string;
  label: string;
  verified_at: number;
  authorizationFailure?: WebBotAuthAuthorizationFailure;
}
export interface VerifyWebBotAuthOptions {
  /** Key discovery (WBA §5.5). The only network dependency of verification. */
  directory: SignatureDirectoryResolver;
  /** Published fixture keys are allowed only outside production. */
  allowTestKeys?: boolean;
  /** Atomic, shared across endpoints and replicas. Nonce scope is the identity origin, not the rotating kid. */
  replayStore: ReplayStore;
  now?: () => number;
  /**
   * @deprecated No effect. A reused signature or nonce is always 429 with
   * `Accept-Signature` carrying a fresh nonce (adcp#7894, `negative/002`).
   */
  replayStatus?: 403 | 429;
  /**
   * @deprecated Revocation is an identity and authorization check, not part of
   * signature verification: call `OriginRevocationResolver.status()` after
   * verification (`createIdentity33PrincipalResolver({ revocation })` does).
   * When supplied it is still consulted: a revoked key is a 403 without
   * `Accept-Signature`, unknown status leaves the identity unverified, and a
   * history-store failure is a {@link WebBotAuthUnavailableError}.
   */
  isRevoked?: (origin: string, keyid: string) => Promise<boolean>;
  /** @deprecated Only affects the deprecated `isRevoked` path: `false` tolerates unknown status. */
  requireFreshRevocation?: boolean;
  /** @deprecated No effect; revocation outcomes are no longer deferred into tool errors. */
  deferAuthorizationErrors?: boolean;
}
/**
 * Verify a Web Bot Auth request (wba-profile.mdx "Verification"). Resolves to
 * exactly one verified signer: the profile takes one `web-bot-auth` signature
 * and one `Signature-Agent` member per request, and does not read signatures
 * with other tags. The array shape is kept for principal resolvers written
 * against earlier drafts.
 */
export async function verifyWebBotAuth(
  request: RequestLike,
  options: VerifyWebBotAuthOptions
): Promise<VerifiedWebBotSigner[]> {
  const hasBody = request.body !== undefined && request.body !== '';
  let label = 'sig1';
  try {
    if (!(options.directory instanceof SignatureDirectoryResolver)) denied('directory_unverified');
    const now = Math.floor((options.now ?? (() => Date.now() / 1000))());
    if (!Number.isFinite(now)) denied('verification_unavailable');

    // 1. Signature, Signature-Input and Signature-Agent parse as Structured
    //    Fields (400), before any profile check or key fetch.
    const inputHeader = getHeaderValue(request.headers, 'signature-input');
    const signatureHeader = getHeaderValue(request.headers, 'signature');
    const agentHeader = getHeaderValue(request.headers, 'signature-agent');
    const present = (value: string | undefined) => value !== undefined && value !== '';
    const inputMembers = present(inputHeader) ? dictionary(inputHeader, 'Signature-Input') : undefined;
    const signatureMembers = present(signatureHeader) ? dictionary(signatureHeader, 'Signature') : undefined;
    const agents = present(agentHeader) ? dictionary(agentHeader, 'Signature-Agent') : undefined;
    // Member shapes are part of each field's definition (RFC 9421 §4, WBA
    // §5.2.1): a member of the wrong shape is a field that does not parse.
    for (const member of inputMembers?.values() ?? [])
      if (!Array.isArray(member[0]) || member[0].some(item => typeof item[0] !== 'string')) bad('signature_input');
    for (const member of signatureMembers?.values() ?? [])
      if (!(member[0] instanceof ArrayBuffer) || member[1].size !== 0) bad('signature');
    for (const member of agents?.values() ?? []) if (typeof member[0] !== 'string') bad('signature_agent');
    if (!inputMembers || !signatureMembers) return denied('headers_missing');

    // 2. Exactly one signature tagged web-bot-auth. Members with other tags are
    //    not read (WBA §5.2.2 allows several signatures per request). Exactly
    //    one Signature-Agent member, keyed to that signature's label and covered.
    const tagged = [...inputMembers].filter(([, member]) => member[1].get('tag') === WEB_BOT_AUTH_PROFILE);
    if (tagged.length === 0) denied('profile');
    if (tagged.length > 1) denied('signature_count');
    label = tagged[0]![0];
    if (!signatureMembers.has(label)) denied('signature_label');
    try {
      // RFC 8941 sf-binary is padded standard Base64; the parser tolerates less.
      parseSignature(signatureHeader!, label, 'rfc8941-base64');
    } catch {
      return bad('signature');
    }
    let input: ParsedSignatureInput;
    try {
      input = parseSignatureInputMember(label, inputMembers.get(label));
    } catch {
      // The field parsed; a parameter of the wrong type is a profile failure.
      return denied('parameters');
    }
    if (!agents || agents.size !== 1) denied(agents ? 'agent_count' : 'agent_missing');
    const agentMember = `signature-agent;key="${label}"`;
    const agentComponents = input.components.filter(c => c.startsWith('signature-agent;'));
    // An uncovered member is a claim the verifier must not attach policy to (WBA §4.1).
    if (agentComponents.length !== 1 || agentComponents[0] !== agentMember) denied('agent_not_covered');
    const member = agents.get(label);
    if (!member) denied('agent_not_covered');
    // A member of another type is ignored (WBA §5.2.1), leaving none to resolve.
    const type = member[1].get('type');
    if (type !== undefined && type !== 'directory') denied('agent_type');
    // Checked in step 1: every Signature-Agent member is an sf-string.
    const origin = receivedAgentOrigin(member[0] as string);

    // Profile parameters, lifetime, and covered components.
    const { created, expires, nonce, keyid, alg } = input.params;
    if ([created, expires, nonce, keyid, alg].some(value => value === undefined)) denied('parameters_missing');
    const nonceKey = nonceBytes(nonce)?.toString('base64url');
    if (
      !nonceKey ||
      !Number.isSafeInteger(created) ||
      !Number.isSafeInteger(expires) ||
      typeof keyid !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(keyid) ||
      !(WEB_BOT_AUTH_ALGORITHMS as readonly string[]).includes(alg)
    )
      denied('parameters');
    if (
      expires <= created ||
      expires - created > MAX_LIFETIME_SECONDS ||
      created > now + CLOCK_SKEW_SECONDS ||
      expires < now - CLOCK_SKEW_SECONDS
    )
      denied('window');
    if (new Set(input.components).size !== input.components.length) denied('coverage');
    const required = [component('@method'), component('@target-uri'), component('@authority')];
    if (hasBody) required.push(component('content-type'), component('content-digest'));
    required.push(component('signature-agent', { key: label }));
    const covered = new Set(input.components);
    if (required.some(c => !covered.has(componentIdentity(c).replace(/^"([^"]*)"/, '$1')))) denied('coverage');
    if (hasBody) assertDigest(request.headers, request.body!);
    let components: ComponentDescriptor[];
    try {
      components = input.components.map(componentDescriptor);
    } catch {
      return denied('component');
    }

    // 3-4. Resolve the key from the directory of the origin the member names,
    //      selected by (origin, thumbprint), and verify with http-message-sig.
    const fields: FieldOccurrence[] = [
      ...coveredFields(components, request.headers),
      { name: 'signature-input', value: inputHeader! },
      { name: 'signature', value: signatureHeader! },
    ];
    await verifyWithLibrary(
      {
        kind: 'request',
        method: request.method.toUpperCase(),
        targetUri: receivedTargetUri(request.url),
        fields,
      },
      label,
      { requiredComponents: required, requiredParameters: REQUIRED_PARAMETERS, maxAge: MAX_LIFETIME_SECONDS, now },
      async () => keyVerifier(await directoryKey(options, origin, keyid, now))
    );

    // 5. Replay: the nonce, per identity, recorded only after the signature verified.
    let result: Awaited<ReturnType<ReplayStore['insert']>>;
    try {
      result = await options.replayStore.insert(
        origin,
        WEB_BOT_AUTH_PROFILE,
        nonceKey!,
        // Acceptance is inclusive of expires + skew, so the nonce must outlive it.
        expires + CLOCK_SKEW_SECONDS - now + 1,
        now
      );
    } catch (cause) {
      // Replay state is unknown: an infrastructure outage, not a signature outcome.
      throw new WebBotAuthUnavailableError('replay_unavailable', cause);
    }
    if (result === 'replayed') throw new WebBotAuthError(429, 'replayed');
    if (result !== 'ok') throw new WebBotAuthError(429, result);

    // 7. Deprecated in-verifier revocation; the identity layer normally runs it.
    if (options.isRevoked) await legacyRevocationCheck(options, origin, keyid);
    const signer: VerifiedWebBotSigner = Object.freeze({
      profile: WEB_BOT_AUTH_PROFILE,
      origin,
      keyid,
      label,
      verified_at: now,
    });
    verifiedSigners.add(signer);
    return [signer];
  } catch (error) {
    if (error instanceof WebBotAuthError) throw challengeFor(error, label, hasBody);
    if (error instanceof WebBotAuthUnavailableError) throw error;
    throw challengeFor(new WebBotAuthError(403, 'verification_unavailable'), label, hasBody);
  }
}
/** The verifying key for `keyid`, read only from the directory of `origin`. */
async function directoryKey(
  options: VerifyWebBotAuthOptions,
  origin: string,
  keyid: string,
  now: number
): Promise<AdcpJsonWebKey> {
  await options.directory.resolve(keyid, origin);
  const checkedDirectory = options.directory.getVerifiedDirectory(origin);
  if (!checkedDirectory || new URL(checkedDirectory.proof.request.url).origin !== origin) denied('directory_origin');
  if (checkedDirectory.expires <= now) denied('directory_expired');
  if (
    !testKeysAllowed(options.allowTestKeys ?? options.directory.allowsTestKeys) &&
    checkedDirectory.keys.some(key => TEST_KIDS.has(key.kid as string))
  )
    denied('directory_key');
  const key = checkedDirectory.keys.find(key => key.kid === keyid);
  // A directory that resolves without the key leaves the request unverified (WBA §6.10).
  if (!key || jwkThumbprint(key) !== keyid) denied('key');
  return key;
}
async function legacyRevocationCheck(options: VerifyWebBotAuthOptions, origin: string, keyid: string): Promise<void> {
  let revoked: boolean;
  try {
    revoked = await options.isRevoked!(origin, keyid);
  } catch (error) {
    if (error instanceof WebBotAuthUnavailableError) throw error;
    if (error instanceof WebBotAuthError && error.reason === 'revocation_persistence_failed')
      throw new WebBotAuthUnavailableError('revocation_persistence_failed', error);
    if (error instanceof WebBotAuthError && error.reason === 'key_revoked') return denied('key_revoked');
    // Unknown (or absent) status. The deprecated tolerance applies to that only.
    if (
      options.requireFreshRevocation === false &&
      error instanceof WebBotAuthError &&
      (error.reason === 'revocation_unavailable' || error.reason === 'revocation_absent')
    )
      return;
    // The deprecated path cannot express "established but not bindable", so it
    // stays conservative: the identity is not established.
    return denied('identity_unverified');
  }
  if (revoked) denied('key_revoked');
}

function testKeysAllowed(allowTestKeys: boolean | undefined): boolean {
  return allowTestKeys === true && ['test', 'development'].includes(process.env.NODE_ENV ?? '');
}
export interface VerifiedSignatureDirectory {
  keys: AdcpJsonWebKey[];
  /** The earliest proof expiry. */
  expires: number;
  /** @deprecated Always `true`: the profile accepts only signed directories (WBA Appendix B.1). */
  signed: true;
  /** Preserve exact bytes and response headers for auditing. */
  proof: ResponseLike;
}
/**
 * Verify a key directory response (wba-profile.mdx "Key directories", WBA
 * Appendix B.1). The response must be signed once per usable key, each
 * signature covering `"@authority";req` and `content-digest` with `created`,
 * `expires`, the key's thumbprint as `keyid` and
 * `tag="http-message-signatures-directory"`, and verifying under the key the
 * directory itself provides. Keys the profile cannot use, and their
 * signatures, are ignored. An unsigned directory, or one without a usable
 * key, is a discovery failure.
 */
export async function verifyKeyDirectory(
  response: ResponseLike,
  now = Date.now() / 1000,
  options: {
    allowTestKeys?: boolean;
    /** @deprecated No effect: directories must always be signed. */
    requireSigned?: boolean;
    /** @deprecated No effect: unsigned directories are refused. */
    maxUnsignedAgeSeconds?: number;
  } = {}
): Promise<VerifiedSignatureDirectory> {
  try {
    if (!Number.isFinite(now)) denied('directory_invalid');
    const origin = canonicalAgentOrigin(response.request.url);
    if (response.request.url !== origin + SIGNATURE_DIRECTORY_PATH || response.status !== 200)
      denied('directory_response');
    const inputHeader = getHeaderValue(response.headers, 'signature-input');
    const signatureHeader = getHeaderValue(response.headers, 'signature');
    if (!inputHeader || !signatureHeader) denied('directory_unsigned');
    const mediaType = getHeaderValue(response.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase();
    if (mediaType !== SIGNATURE_DIRECTORY_MEDIA_TYPE) denied('directory_response');
    const body = response.body ?? '';
    if (Buffer.byteLength(body) > 256 * 1024) denied('directory_size');
    try {
      assertDigest(response.headers, body);
    } catch {
      denied('directory_digest');
    }
    const document = parseStrictJson(body, 32) as { keys?: AdcpJsonWebKey[] };
    if (!Array.isArray(document.keys) || !document.keys.length || document.keys.length > 64) denied('directory_keys');
    // One proof per key, at most 64 keys: bound the labels before verifying any.
    const signatures = inputs(response.headers, 64);
    const kids = new Set<string>();
    const keys: AdcpJsonWebKey[] = [];
    let expires = Infinity;
    for (const raw of document.keys) {
      if (!raw || typeof raw !== 'object') denied('directory_key');
      // A key the profile cannot use is ignored, and so is any signature it
      // made (RFC 7517 section 5): a WBA directory may list keys of other
      // registered algorithms (WBA section 5.5.1). Every usable key signs.
      if (!keyAlgorithm(raw)) continue;
      const thumbprint = jwkThumbprint(raw);
      // `kid` may be omitted; when present it must be the thumbprint.
      const key = { ...raw, kid: raw.kid ?? thumbprint } as AdcpJsonWebKey;
      if (
        key.kid !== thumbprint ||
        kids.has(key.kid) ||
        key.d !== undefined ||
        Object.keys(key).some(k => k.startsWith('_private')) ||
        key.adcp_use !== undefined ||
        (!testKeysAllowed(options.allowTestKeys) && TEST_KIDS.has(key.kid))
      )
        denied('directory_key');
      kids.add(key.kid);
      keys.push(key);
      const proof = signatures.find(input => input.params.keyid === key.kid && input.params.tag === DIRECTORY_TAG);
      if (
        !proof ||
        !proof.components.includes('@authority;req') ||
        !proof.components.includes('content-digest') ||
        !Number.isSafeInteger(proof.params.created) ||
        !Number.isSafeInteger(proof.params.expires) ||
        proof.params.expires <= now ||
        proof.params.expires <= proof.params.created
      )
        denied('directory_proof');
      const proofComponents = [component('@authority', { req: true }), component('content-digest')];
      // Appendix B.1 sets the minimum coverage; a proof may cover more.
      let covered: ComponentDescriptor[];
      try {
        covered = proof.components.map(componentDescriptor);
      } catch {
        return denied('directory_proof');
      }
      const requestHeaders = response.request.headers ?? {};
      await verifyWithLibrary(
        {
          kind: 'response',
          status: response.status,
          fields: [
            ...coveredFields(
              covered.filter(c => c.parameters.req === undefined),
              response.headers
            ),
            { name: 'signature-input', value: inputHeader },
            { name: 'signature', value: signatureHeader },
          ],
          request: {
            kind: 'request',
            method: response.request.method,
            targetUri: response.request.url,
            fields: coveredFields(
              covered.filter(c => c.parameters.req !== undefined),
              requestHeaders
            ),
          },
        },
        proof.label,
        // The library rejects a proof whose `created` is in the future (beyond skew).
        { requiredComponents: proofComponents, requiredParameters: ['created', 'expires', 'keyid', 'tag'], now },
        async () => keyVerifier(key)
      );
      expires = Math.min(expires, proof.params.expires);
    }
    if (!keys.length) denied('directory_keys');
    return { keys, expires, signed: true, proof: response };
  } catch (error) {
    if (error instanceof WebBotAuthError) {
      // Any defect in what the origin serves is a discovery failure (§6.10), not a request-header error.
      throw error.reason.startsWith('directory_') ? error : new WebBotAuthError(403, `directory_${error.reason}`);
    }
    return denied('directory_invalid');
  }
}
/** @deprecated Same as {@link verifyKeyDirectory}: every directory must be signed. */
export function verifySignatureDirectory(
  response: ResponseLike,
  now = Date.now() / 1000,
  allowTestKeys = false
): Promise<VerifiedSignatureDirectory> {
  return verifyKeyDirectory(response, now, { allowTestKeys });
}

export interface SignatureDirectoryResolverOptions {
  now?: () => number;
  fetchOptions?: Pick<SsrfFetchOptions, 'lookup' | 'trustedFetchFn'>;
  allowTestKeys?: boolean;
  maxOrigins?: number;
  /** Globally bound concurrency across attacker-selected origins. */
  maxConcurrentFetches?: number;
  /** @deprecated No effect: signed directories (WBA Appendix B.1) are always required. */
  requireSignedDirectories?: boolean;
  /** @deprecated No effect: unsigned directories are refused. */
  maxUnsignedDirectoryAgeSeconds?: number;
}
/**
 * Multi-origin key discovery. Cache keys never collapse origins sharing a
 * kid. A failed refresh (any transport error or non-200, 404/410 included) is
 * a discovery failure: it never evicts a cached, unexpired directory, which
 * keeps verifying (WBA §6.10). Without one, the request is unverified.
 */
export class SignatureDirectoryResolver implements JwksResolver {
  private readonly cache = new Map<string, { directory: VerifiedSignatureDirectory; freshUntil: number }>();
  private readonly failures = new Map<string, number>();
  private readonly keyMissCooldown = new Map<string, number>();
  private readonly pending = new Map<string, Promise<VerifiedSignatureDirectory>>();
  constructor(private readonly options: SignatureDirectoryResolverOptions = {}) {}
  async resolve(keyid: string, signerOrigin?: string): Promise<AdcpJsonWebKey | null> {
    if (!signerOrigin) return denied('origin_required');
    const origin = receivedAgentOrigin(signerOrigin);
    const now = (this.options.now ?? (() => Date.now() / 1000))();
    const cached = this.cache.get(origin);
    const usable = () => (cached && cached.directory.expires > now ? cached.directory : undefined);
    if (cached && cached.freshUntil > now && cached.directory.expires > now) {
      const key = cached.directory.keys.find(k => k.kid === keyid);
      if (key || (this.keyMissCooldown.get(origin) ?? 0) > now) return key ?? null;
      this.keyMissCooldown.set(origin, now + 60);
    }
    // During a discovery failure, cached keys keep verifying; a kid they lack
    // (for example a key rotated in during the outage) is still a discovery
    // failure, because no current directory was read.
    const fromFallback = (): AdcpJsonWebKey => {
      const key = usable()?.keys.find(k => k.kid === keyid);
      return key ?? denied('directory_unavailable');
    };
    if ((this.failures.get(origin) ?? 0) > now) return fromFallback();
    let pending = this.pending.get(origin);
    if (!pending) {
      if (
        [...this.pending.keys()].filter(pendingOrigin => eTldPlusOne(pendingOrigin) === eTldPlusOne(origin)).length >=
          2 ||
        this.pending.size >= (this.options.maxConcurrentFetches ?? 16)
      ) {
        const key = usable()?.keys.find(k => k.kid === keyid);
        if (key) return key;
        // Local load shedding, not a statement about the signer: 429 with
        // Retry-After, never a re-sign challenge.
        throw new WebBotAuthError(429, 'directory_fetch_limit');
      }
      pending = this.fetch(origin, now);
      this.pending.set(origin, pending);
    }
    try {
      return (await pending).keys.find(k => k.kid === keyid) ?? null;
    } catch (error) {
      // A failed fetch never proves removal: keep verifying under unexpired
      // cached keys. A successful refresh replaces the whole key set.
      if (usable()) return fromFallback();
      throw error;
    } finally {
      if (this.pending.get(origin) === pending) this.pending.delete(origin);
    }
  }
  private async fetch(origin: string, now: number): Promise<VerifiedSignatureDirectory> {
    try {
      const url = origin + SIGNATURE_DIRECTORY_PATH;
      const result = await ssrfSafeFetch(url, {
        ...this.options.fetchOptions,
        headers: { accept: SIGNATURE_DIRECTORY_MEDIA_TYPE },
        timeoutMs: 10_000,
        maxBodyBytes: 256 * 1024,
      });
      if (result.status !== 200) denied('directory_unavailable');
      // ignoreBOM: the digest covers the exact bytes, including any BOM.
      const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.body);
      const directory = await verifyKeyDirectory(
        { status: result.status, headers: result.headers, body, request: { method: 'GET', url } },
        now,
        { allowTestKeys: this.options.allowTestKeys }
      );
      const cacheControl = result.headers['cache-control'] ?? '';
      const maxAge = /(?:^|,)\s*(?:no-cache|no-store)(?:,|$)/i.test(cacheControl)
        ? 0
        : Number(cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 300);
      const age = Number(result.headers.age ?? 0);
      if (!Number.isFinite(age) || age < 0) denied('directory_invalid');
      if (this.cache.size >= (this.options.maxOrigins ?? 1000) && !this.cache.has(origin)) {
        const oldest = this.cache.keys().next().value!;
        this.cache.delete(oldest);
        this.keyMissCooldown.delete(oldest);
      }
      this.cache.set(origin, {
        directory,
        freshUntil: Math.min(directory.expires, now + Math.max(0, Math.min(maxAge - age, 300))),
      });
      this.failures.delete(origin);
      return directory;
    } catch (error) {
      if (this.failures.size >= (this.options.maxOrigins ?? 1000))
        this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(origin, now + 60);
      throw error instanceof WebBotAuthError ? error : new WebBotAuthError(403, 'directory_unavailable');
    }
  }
  get allowsTestKeys(): boolean {
    return testKeysAllowed(this.options.allowTestKeys);
  }
  /** The directory currently used to verify `origin`, including one kept through a failed refresh. */
  getVerifiedDirectory(origin: string): VerifiedSignatureDirectory | undefined {
    return this.cache.get(receivedAgentOrigin(origin))?.directory;
  }
  getAuditProof(origin: string): ResponseLike | undefined {
    return this.getVerifiedDirectory(origin)?.proof;
  }
}

export interface WebBotSigningOptions {
  origin: string;
  label?: string;
  now?: () => number;
  /** 64 bytes, unpadded Base64URL or canonical Base64. Defaults to 64 fresh random bytes. */
  nonce?: string;
  windowSeconds?: number;
}
export type WebBotSigningKey =
  | { privateKey: AdcpJsonWebKey }
  | { publicKey: AdcpJsonWebKey; provider: SigningProvider };
/**
 * The RFC 9421 signer handed to `http-message-sig`. AdCP keeps the key policy
 * (profile algorithms, test-key refusal, provider/keyid binding) and
 * KMS-backed providers.
 */
function webBotSigner(key: WebBotSigningKey): Signer {
  const jwk = 'privateKey' in key ? key.privateKey : key.publicKey;
  const alg = signingAlgorithm(jwk);
  if (!['test', 'development'].includes(process.env.NODE_ENV ?? '') && TEST_KIDS.has(jwkThumbprint(jwk)))
    throw new TypeError('Published Web Bot Auth test keys cannot sign in production');
  if ('provider' in key) {
    if (key.provider.keyid !== jwkThumbprint(jwk) || key.provider.algorithm !== alg)
      throw new TypeError('Web Bot Auth provider identity does not match its public key');
    // Buffer.from accepts the Uint8Array the contract names and the ArrayBuffer
    // a WebCrypto-backed provider may return; the library's copy would not.
    return { algorithm: alg, sign: async data => Buffer.from(await key.provider.sign(Buffer.from(data))) };
  }
  return { algorithm: alg, sign: data => signWithPrivateJwkAsync(alg, jwk, Buffer.from(data)) };
}
/**
 * Run `http-message-sig`, keeping the SDK's error surface: a message the
 * library refuses (a covered field that is not RFC 9110 field content, a
 * method that is not a token) is a malformed Web Bot Auth message.
 */
async function createWebBotSignature(...args: Parameters<typeof createSignature>): Promise<SignatureFields> {
  try {
    return await createSignature(...args);
  } catch (error) {
    if (isSignatureError(error)) throw new WebBotAuthError(400, 'component_value');
    throw error;
  }
}
/**
 * Sign a request under the profile: one `web-bot-auth` signature labelled
 * `label`, one covered `Signature-Agent` member naming `origin`, a 64-byte
 * nonce, and a lifetime of at most 300 seconds.
 */
export async function signWebBotAuth(
  request: RequestLike,
  key: WebBotSigningKey,
  options: WebBotSigningOptions
): Promise<Record<string, string>> {
  if ((options as { relay?: unknown }).relay)
    throw new TypeError(
      'Web Bot Auth relays were removed from the profile (adcp#7894): an intermediary signs as itself with one signature'
    );
  const origin = canonicalAgentOrigin(options.origin);
  const label = options.label ?? 'sig1';
  if (!/^[a-z][a-z0-9_.*-]*$/.test(label)) throw new TypeError('Invalid signature label');
  const jwk = 'privateKey' in key ? key.privateKey : key.publicKey;
  const now = Math.floor((options.now ?? (() => Date.now() / 1000))());
  const window = options.windowSeconds ?? MAX_LIFETIME_SECONDS;
  const nonce = options.nonce ?? freshNonce();
  if (!Number.isSafeInteger(now)) throw new TypeError('Invalid Web Bot Auth clock');
  if (!Number.isInteger(window) || window < 1 || window > MAX_LIFETIME_SECONDS || !nonceBytes(nonce))
    throw new TypeError('Invalid Web Bot Auth lifetime or nonce (the nonce is 64 bytes, Base64URL or Base64)');
  if (
    ['signature', 'signature-input', 'signature-agent'].some(
      name => getHeaderValue(request.headers, name) !== undefined
    )
  )
    throw new TypeError('Request already carries signature fields; the profile takes exactly one signature');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers))
    if (value !== undefined && name.toLowerCase() !== 'content-digest')
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  const components: ComponentDescriptor[] = [component('@method'), component('@target-uri'), component('@authority')];
  if (request.body !== undefined && request.body !== '') {
    if (!getHeaderValue(headers, 'content-type'))
      throw new TypeError('Body-bearing Web Bot Auth requests need Content-Type');
    headers['content-digest'] = computeContentDigest(request.body, 'rfc8941-base64');
    components.push(component('content-type'), component('content-digest'));
  }
  headers['signature-agent'] = `${label}="${origin}"`;
  components.push(component('signature-agent', { key: label }));
  // RFC 9421 signature base and field serialization come from http-message-sig.
  // Sign the target URI exactly as the HTTP client will send it: normalized by
  // the WHATWG URL parser, and without a fragment, which never reaches the wire.
  const targetUri = new URL(request.url);
  targetUri.hash = '';
  const signed = await createWebBotSignature(
    {
      kind: 'request',
      method: request.method.toUpperCase(),
      targetUri: targetUri.href,
      fields: coveredFields(components, headers),
    },
    {
      label,
      components,
      parameters: {
        created: now,
        expires: now + window,
        nonce,
        keyid: jwkThumbprint(jwk),
        alg: signingAlgorithm(jwk),
        tag: WEB_BOT_AUTH_PROFILE,
      },
      signer: webBotSigner(key),
    }
  );
  headers['signature-input'] = signed.signatureInput;
  headers.signature = signed.signature;
  return headers;
}
/** Regenerate after rotation and periodically before proofs expire. No private material is published. */
export async function createSignedSignatureDirectory(
  originUrl: string,
  signingKeys: WebBotSigningKey[],
  options: { now?: () => number; lifetimeSeconds?: number } = {}
): Promise<ResponseLike> {
  const origin = canonicalAgentOrigin(originUrl);
  const now = Math.floor((options.now ?? (() => Date.now() / 1000))());
  const lifetime = options.lifetimeSeconds ?? 86_400;
  if (!Number.isFinite(now) || !Number.isSafeInteger(lifetime) || lifetime < 1 || !Number.isSafeInteger(now + lifetime))
    throw new TypeError('Invalid directory proof clock or lifetime');
  if (!signingKeys.length || signingKeys.length > 64) throw new TypeError('Invalid directory keys or lifetime');
  const keys = signingKeys.map(key => {
    const jwk = 'privateKey' in key ? key.privateKey : key.publicKey;
    signingAlgorithm(jwk);
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: jwkThumbprint(jwk), use: 'sig' } as AdcpJsonWebKey;
  });
  if (new Set(keys.map(k => k.kid)).size !== keys.length) throw new TypeError('Duplicate directory key');
  const body = JSON.stringify({ keys });
  const response: ResponseLike = {
    status: 200,
    body,
    request: { method: 'GET', url: origin + SIGNATURE_DIRECTORY_PATH },
    headers: {
      'content-type': SIGNATURE_DIRECTORY_MEDIA_TYPE,
      'content-digest': computeContentDigest(body, 'rfc8941-base64'),
      'cache-control': `max-age=${Math.min(lifetime, 300)}`,
    },
  };
  const signatureInputs: string[] = [],
    signatures: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const signed = await createWebBotSignature(
      {
        kind: 'response',
        status: response.status,
        fields: coveredFields([component('content-digest')], response.headers),
        request: { kind: 'request', method: 'GET', targetUri: response.request.url, fields: [] },
      },
      {
        label: `key${i + 1}`,
        components: [component('@authority', { req: true }), component('content-digest')],
        parameters: {
          // Backdate created so verifiers whose clocks run slightly behind accept a fresh proof.
          created: now - CLOCK_SKEW_SECONDS,
          expires: now + lifetime,
          keyid: keys[i]!.kid as string,
          alg: signingAlgorithm(keys[i]!),
          tag: DIRECTORY_TAG,
        },
        signer: webBotSigner(signingKeys[i]!),
      }
    );
    signatureInputs.push(signed.signatureInput);
    signatures.push(signed.signature);
  }
  response.headers['signature-input'] = signatureInputs.join(', ');
  response.headers.signature = signatures.join(', ');
  return response;
}

/** Inject into the official MCP/A2A transport; signs the final outgoing bytes. */
export function createWebBotAuthFetch(
  upstream: typeof fetch,
  key: WebBotSigningKey,
  options: WebBotSigningOptions & { shouldSign?: (url: string, init?: RequestInit) => boolean }
): typeof fetch {
  assertWebBotAuthSigningKey(key);
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (options.shouldSign && !options.shouldSign(url, init)) return upstream(input, init);
    if (input instanceof Request)
      throw new TypeError('Pass a URL and init to Web Bot Auth fetch so the exact body can be signed');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
      throw new TypeError('Signed targets must be HTTPS without credentials or fragments');
    let body: string | undefined;
    if (init?.body != null) {
      if (typeof init.body === 'string') body = init.body;
      else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer)
        // ignoreBOM: sign and send exactly the caller's bytes.
        body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(init.body);
      else throw new TypeError('Web Bot Auth fetch requires a UTF-8 string or byte body');
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    const method = init?.method ?? 'GET';
    const signed = await signWebBotAuth({ method, url, headers, body }, key, options);
    return upstream(url, { ...init, method, body, headers: signed, redirect: 'manual' });
  };
}
