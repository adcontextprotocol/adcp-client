import { toReleasePrecisionVersion } from '../version';
/** Experimental AdCP 3.3 profile, pinned to adcp#7894 and IETF webbotauth-00. */
import {
  constants as cryptoConstants,
  createHash,
  createPrivateKey,
  randomBytes,
  sign as nodeSign,
  type JsonWebKey,
} from 'crypto';
import { parseDictionary, parseItem, serializeItem } from 'structured-headers';
import { ssrfSafeFetch, type SsrfFetchOptions } from '../net';
import { eTldPlusOne } from './agent-resolver/etld';
import { canonicalAgentOrigin } from './agent-resolver/canonicalize';
import { canonicalAgentUrl } from './agent-resolver/select-agent';
import { parseStrictJson } from './agent-resolver/strict-json';
import { getHeaderValue, type RequestLike, type ResponseLike } from './canonicalize';
import { computeContentDigest, contentDigestMatches, contentDigestUsesEncoding } from './content-digest';
import { jwkToPublicKey, verifySignature } from './crypto';
import {
  parseSignature,
  parseSignatureInput,
  rejectDuplicateDictionaryKeys,
  type ParsedSignatureInput,
} from './parser';
import type { JwksResolver } from './jwks';
import type { ReplayStore } from './replay';
import type { AdcpJsonWebKey, AdcpSignAlg } from './types';
import type { SigningProvider } from './provider';

export const WEB_BOT_AUTH_PROFILE = 'web-bot-auth' as const;
export const WEB_BOT_AUTH_DRAFT_REVISION = 'draft-ietf-webbotauth-httpsig-protocol-00' as const;
export const SIGNATURE_DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const SIGNATURE_DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
const DIRECTORY_TAG = 'http-message-signatures-directory';
/** Directory proofs are backdated by, and verified with, this much clock skew. */
const DIRECTORY_CLOCK_SKEW_SECONDS = 60;
const TEST_KIDS = new Set([
  '6WsKMCObba49V3uN0vIENnk1BKAk7c9zjBJcWKyQ9_I',
  'hHurKlVBnPJ4AGiPyl6HWMhxgkIcRBzaC8qWwEtnuVI',
  'ZtaFf5jj-EzorJmZn6mX3YnmK_QyZKVLbbinzIQKOjQ',
  '1XlJ3EIte7bPOEqKQtKrKNTNy5hywTyrwFXWrMbXKqE',
]);

/**
 * Outcomes that are not signature failures and must not ask the signer to
 * re-sign: a revoked key (the signer must stop using it) and refusals made
 * after verification.
 */
const NO_CHALLENGE_REASONS = new Set(['key_revoked', 'identity_not_bound', 'profile_disabled']);
/**
 * Signature-path outcome (WBA §4, DR-0023): 400 for a field that does not
 * parse, 403 for a signature that does not verify (with `Accept-Signature`
 * unless the key is revoked), 429 for a replay. Any AdCP body is the generic
 * authentication error; signature-specific detail stays in `reason` (logs).
 * Infrastructure the verifier depends on is reported separately by
 * {@link WebBotAuthUnavailableError}.
 */
export class WebBotAuthError extends Error {
  readonly headers: Record<string, string>;
  get body(): Record<string, unknown> {
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
          ? 'Web Bot Auth rate limit'
          : 'Web Bot Auth verification failed'
    );
    this.name = 'WebBotAuthError';
    this.headers =
      status === 403 && !NO_CHALLENGE_REASONS.has(reason)
        ? {
            'Accept-Signature':
              'sig1=("@method" "@target-uri" "@authority" "content-type" "content-digest" "signature-agent";key="sig1");created;expires;nonce;keyid;tag="web-bot-auth"',
          }
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

function dictionary(value: string | undefined, field: string) {
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
/** Web Bot Auth key algorithms: the AdCP set plus RSA-PSS (draft Appendix E vectors). */
type WebBotAuthAlg = AdcpSignAlg | 'rsa-pss-sha512';
function algorithm(jwk: AdcpJsonWebKey): WebBotAuthAlg {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'ed25519';
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ecdsa-p256-sha256';
  // RSA: 2048–4096-bit moduli and e = 65537 only (bounds verification cost).
  if (jwk.kty === 'RSA' && typeof jwk.n === 'string' && jwk.e === 'AQAB') {
    const bytes = Buffer.from(jwk.n, 'base64url').length;
    if (bytes >= 256 && bytes <= 512) return 'rsa-pss-sha512';
  }
  return denied('unsupported_key');
}
function inputs(headers: RequestLike['headers']): ParsedSignatureInput[] {
  const value = getHeaderValue(headers, 'signature-input');
  return [...dictionary(value, 'Signature-Input').keys()].map(label => {
    try {
      return parseSignatureInput(value!, label);
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
    if (value !== origin || /[^\x21-\x7e]/.test(value) || value.includes('%')) return bad('agent_origin');
    return origin;
  } catch {
    return bad('agent_origin');
  }
}

/** RFC 9421 dictionary-member extraction, including relay member coverage. */
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
        if (Array.isArray(member[0])) {
          // Signature-Input relay members are inner lists.
          const selected = parseSignatureInput(value!, params.get('key') as string);
          value = selected.signatureParamsValue;
        } else value = serializeItem(member as Parameters<typeof serializeItem>[0]);
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
    return bad('target_uri');
  }
  return url;
}
function receivedAuthority(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return bad('target_uri');
  }
}
function assertDigest(headers: RequestLike['headers'], body: string): void {
  const digest = getHeaderValue(headers, 'content-digest');
  if (!digest || !contentDigestUsesEncoding(digest, 'rfc8941-base64') || !contentDigestMatches(digest, body))
    denied('content_digest');
}
function verifyBytes(
  input: ParsedSignatureInput,
  request: RequestLike,
  jwk: AdcpJsonWebKey,
  response?: ResponseLike
): void {
  const alg = algorithm(jwk);
  if (input.params.alg !== undefined && input.params.alg !== alg) denied('algorithm');
  const signature = getHeaderValue(response?.headers ?? request.headers, 'signature');
  if (signature === undefined || signature === '') denied('headers_missing');
  let bytes: Uint8Array;
  try {
    bytes = parseSignature(signature ?? '', input.label, 'rfc8941-base64').bytes;
  } catch {
    return bad('signature');
  }
  let valid = false;
  try {
    valid = verifySignature(
      alg,
      jwkToPublicKey(jwk),
      Buffer.from(buildWebBotAuthSignatureBase(input, request, response)),
      bytes
    );
  } catch (error) {
    if (error instanceof WebBotAuthError) throw error;
  }
  if (!valid) denied('signature_invalid');
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
    (error as { code?: unknown } | undefined)?.code === 'PERMISSION_DENIED'
      ? 'authorization_failed'
      : 'authorization_unavailable'
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
  /** Older #7894 vector draft expects 403; ratified R2 defaults to 429. */
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
export async function verifyWebBotAuth(
  request: RequestLike,
  options: VerifyWebBotAuthOptions
): Promise<VerifiedWebBotSigner[]> {
  try {
    if (!(options.directory instanceof SignatureDirectoryResolver)) denied('directory_unverified');
    const now = Math.floor((options.now ?? (() => Date.now() / 1000))());
    if (!Number.isFinite(now)) denied('verification_unavailable');
    const all = inputs(request.headers);
    const candidates = all.filter(input => input.params.tag === WEB_BOT_AUTH_PROFILE);
    const selected: ParsedSignatureInput[] = [];
    const remaining = [...candidates];
    while (remaining.length) {
      const index = remaining.findIndex(input =>
        candidates.every(
          other =>
            !input.components.some(
              c => c === `signature-input;key="${other.label}"` || c === `signature;key="${other.label}"`
            ) || selected.some(done => done.label === other.label)
        )
      );
      if (index < 0) denied('relay_cycle');
      selected.push(remaining.splice(index, 1)[0]!);
    }
    if (!selected.length || selected.length > 8) denied('profile');
    const agents = dictionary(getHeaderValue(request.headers, 'signature-agent'), 'Signature-Agent');
    const verified: VerifiedWebBotSigner[] = [];
    const nonces = new Set<string>();
    for (const input of selected) {
      const { created, expires, nonce, keyid } = input.params;
      if ([created, expires, nonce, keyid].some(value => value === undefined)) denied('parameters_missing');
      if (
        !Number.isInteger(created) ||
        !Number.isInteger(expires) ||
        typeof nonce !== 'string' ||
        !/^[A-Za-z0-9_+\/-]{22,256}={0,2}$/.test(nonce) ||
        typeof keyid !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(keyid)
      )
        bad('parameters');
      if (expires <= created || expires - created > 300 || created > now + 60 || expires < now - 60) denied('window');
      const agentComponents = input.components.filter(
        c =>
          c.startsWith('signature-agent;key=') &&
          !verified.some(s => selected.find(i => i.label === s.label)!.components.includes(c))
      );
      if (agentComponents.length !== 1) denied('agent_not_covered');
      const component = parseItem(`"${agentComponents[0]!.replace('signature-agent;', 'signature-agent";')}`);
      const memberKey = component[1].get('key');
      if (typeof memberKey !== 'string' || memberKey !== input.label) bad('agent_member');
      const member = agents.get(memberKey);
      // An absent member is unattributed (403); a member of the wrong type is malformed (400).
      if (!member) denied('agent_not_covered');
      if (typeof member[0] !== 'string') bad('signature_agent');
      const type = member[1].get('type');
      if (type !== undefined && type !== 'directory') denied('agent_type');
      const origin = receivedAgentOrigin(member[0]);
      // Every later relay must bind all earlier signatures and their coverage.
      for (const earlier of verified) {
        const inner = selected.find(i => i.label === earlier.label)!;
        const required = [
          ...inner.components,
          `signature-input;key="${inner.label}"`,
          `signature;key="${inner.label}"`,
        ];
        if (required.some(c => !input.components.includes(c))) denied('relay_coverage');
      }
      if (
        new Set(input.components).size !== input.components.length ||
        ['@method', '@target-uri', '@authority'].some(c => !input.components.includes(c))
      )
        denied('coverage');
      if (request.body !== undefined && request.body !== '') {
        if (['content-type', 'content-digest'].some(c => !input.components.includes(c))) denied('body_coverage');
        assertDigest(request.headers, request.body);
      }
      await options.directory.resolve(keyid, origin);
      const checkedDirectory = options.directory.getVerifiedDirectory(origin);
      if (!checkedDirectory || new URL(checkedDirectory.proof.request.url).origin !== origin)
        denied('directory_origin');
      // Signed proofs and unsigned freshness both bound how long keys verify.
      if (checkedDirectory.expires <= now) denied('directory_expired');
      if (
        !testKeysAllowed(options.allowTestKeys ?? options.directory.allowsTestKeys) &&
        checkedDirectory.keys.some(key => TEST_KIDS.has(key.kid as string))
      )
        denied('directory_key');
      const key = checkedDirectory.keys.find(key => key.kid === keyid);
      if (!key || jwkThumbprint(key) !== keyid) denied('key');
      verifyBytes(input, request, key);
      if (options.isRevoked) await legacyRevocationCheck(options, origin, keyid);
      const nonceTuple = JSON.stringify([origin, nonce]);
      if (nonces.has(nonceTuple)) throw new WebBotAuthError(options.replayStatus ?? 429, 'nonce_replayed');
      nonces.add(nonceTuple);
      const signer: VerifiedWebBotSigner = Object.freeze({
        profile: WEB_BOT_AUTH_PROFILE,
        origin,
        keyid,
        label: input.label,
        verified_at: now,
      });
      verified.push(signer);
    }
    // No nonce state is consumed until all cryptographic signatures pass.
    for (const signer of verified) {
      const input = selected.find(i => i.label === signer.label)!;
      let result: Awaited<ReturnType<ReplayStore['insert']>>;
      try {
        result = await options.replayStore.insert(
          signer.origin,
          WEB_BOT_AUTH_PROFILE,
          input.params.nonce,
          // Acceptance is inclusive of expires + 60, so the nonce must outlive it.
          input.params.expires + 60 - now + 1,
          now
        );
      } catch (cause) {
        // Replay state is unknown: an infrastructure outage, not a signature outcome.
        throw new WebBotAuthUnavailableError('replay_unavailable', cause);
      }
      if (result !== 'ok')
        throw new WebBotAuthError(result === 'replayed' ? (options.replayStatus ?? 429) : 429, result);
    }
    for (const signer of verified) verifiedSigners.add(signer);
    return verified;
  } catch (error) {
    if (error instanceof WebBotAuthError) {
      if (error.headers['Accept-Signature']) {
        let label = 'sig1';
        try {
          label = inputs(request.headers)[0]?.label ?? 'sig1';
        } catch {
          // Missing or malformed Signature-Input: challenge with the default label.
        }
        const bodyComponents = request.body ? '"content-type" "content-digest" ' : '';
        error.headers['Accept-Signature'] =
          `${label}=("@method" "@target-uri" "@authority" ${bodyComponents}"signature-agent";key="${label}");created;expires;nonce;keyid;tag="web-bot-auth"`;
      }
      throw error;
    }
    if (error instanceof WebBotAuthUnavailableError) throw error;
    return denied('verification_unavailable');
  }
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
  /** Signed: the earliest proof expiry. Unsigned: verification time plus the unsigned-age bound. */
  expires: number;
  /** Whether every key carried an Appendix B signature. */
  signed: boolean;
  /** Preserve exact bytes and response headers for auditing. */
  proof: ResponseLike;
}
/** Media types a plain (unsigned) JWKS directory may use. */
const UNSIGNED_DIRECTORY_MEDIA_TYPES = new Set([
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  'application/jwk-set+json',
  'application/json',
]);
/**
 * Verify a key directory response (draft-meunier-http-message-signatures-directory).
 * Appendix B signatures are a SHOULD there: a directory without
 * `Signature-Input` is accepted as a plain JWKS unless `requireSigned`, with
 * every key checked against its RFC 7638 thumbprint. When signatures are
 * present, every key must carry a valid one.
 */
export function verifyKeyDirectory(
  response: ResponseLike,
  now = Date.now() / 1000,
  options: { allowTestKeys?: boolean; requireSigned?: boolean; maxUnsignedAgeSeconds?: number } = {}
): VerifiedSignatureDirectory {
  try {
    if (!Number.isFinite(now)) denied('directory_invalid');
    const origin = canonicalAgentOrigin(response.request.url);
    if (response.request.url !== origin + SIGNATURE_DIRECTORY_PATH || response.status !== 200)
      denied('directory_response');
    const signed = getHeaderValue(response.headers, 'signature-input') !== undefined;
    if (!signed && options.requireSigned) denied('directory_unsigned');
    const mediaType = getHeaderValue(response.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase();
    if (signed ? mediaType !== SIGNATURE_DIRECTORY_MEDIA_TYPE : !UNSIGNED_DIRECTORY_MEDIA_TYPES.has(mediaType ?? ''))
      denied('directory_response');
    const body = response.body ?? '';
    if (Buffer.byteLength(body) > 256 * 1024) denied('directory_size');
    if (signed || getHeaderValue(response.headers, 'content-digest') !== undefined)
      assertDirectoryDigest(response.headers, body);
    const document = parseStrictJson(body, 32) as { keys?: AdcpJsonWebKey[] };
    if (!Array.isArray(document.keys) || !document.keys.length || document.keys.length > 64) denied('directory_keys');
    const signatures = signed ? inputs(response.headers) : [];
    const kids = new Set<string>();
    const keys: AdcpJsonWebKey[] = [];
    let expires = Infinity;
    for (const raw of document.keys) {
      if (!raw || typeof raw !== 'object') denied('directory_key');
      const thumbprint = jwkThumbprint(raw);
      // A plain JWKS may omit kid; when present it must be the thumbprint.
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
      algorithm(key);
      kids.add(key.kid);
      keys.push(key);
      if (!signed) continue;
      const proof = signatures.find(input => input.params.keyid === key.kid && input.params.tag === DIRECTORY_TAG);
      if (
        !proof ||
        !proof.components.includes('@authority;req') ||
        !proof.components.includes('content-digest') ||
        !Number.isInteger(proof.params.created) ||
        !Number.isInteger(proof.params.expires) ||
        proof.params.created > now + DIRECTORY_CLOCK_SKEW_SECONDS ||
        proof.params.expires <= now ||
        proof.params.expires <= proof.params.created
      )
        denied('directory_proof');
      verifyBytes(proof, { ...response.request, headers: response.request.headers ?? {} }, key, response);
      expires = Math.min(expires, proof.params.expires);
    }
    // Unsigned keys carry no proof expiry: they verify for a bounded time from `now`.
    if (!signed) expires = now + unsignedAge(options.maxUnsignedAgeSeconds);
    return { keys, expires, signed, proof: response };
  } catch (error) {
    if (error instanceof WebBotAuthError) {
      // Any defect in what the origin serves is a discovery failure (§6.10), not a request-header error.
      throw error.reason.startsWith('directory_') ? error : new WebBotAuthError(403, `directory_${error.reason}`);
    }
    return denied('directory_invalid');
  }
}
function unsignedAge(seconds: number | undefined): number {
  const value = seconds ?? 86_400;
  if (!Number.isFinite(value) || value < 60)
    throw new TypeError('Unsigned directory age must be a finite number of seconds, at least 60');
  return value;
}
/** Signed directories only (Appendix B). Prefer {@link verifyKeyDirectory}. */
export function verifySignatureDirectory(
  response: ResponseLike,
  now = Date.now() / 1000,
  allowTestKeys = false
): VerifiedSignatureDirectory {
  return verifyKeyDirectory(response, now, { allowTestKeys, requireSigned: true });
}
function assertDirectoryDigest(headers: RequestLike['headers'], body: string): void {
  try {
    assertDigest(headers, body);
  } catch {
    denied('directory_digest');
  }
}

export interface SignatureDirectoryResolverOptions {
  now?: () => number;
  fetchOptions?: Pick<SsrfFetchOptions, 'lookup' | 'trustedFetchFn'>;
  allowTestKeys?: boolean;
  maxOrigins?: number;
  /** Globally bound concurrency across attacker-selected origins. */
  maxConcurrentFetches?: number;
  /** Refuse plain JWKS directories without Appendix B signatures. Default false. */
  requireSignedDirectories?: boolean;
  /** How long an unsigned directory may keep verifying after a failed refresh (seconds). Default 86400. */
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
  constructor(private readonly options: SignatureDirectoryResolverOptions = {}) {
    unsignedAge(options.maxUnsignedDirectoryAgeSeconds);
  }
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
        headers: {
          accept: `${SIGNATURE_DIRECTORY_MEDIA_TYPE}, application/jwk-set+json;q=0.9, application/json;q=0.8`,
        },
        timeoutMs: 10_000,
        maxBodyBytes: 256 * 1024,
      });
      if (result.status !== 200) denied('directory_unavailable');
      // ignoreBOM: the digest covers the exact bytes, including any BOM.
      const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.body);
      const directory = verifyKeyDirectory(
        { status: result.status, headers: result.headers, body, request: { method: 'GET', url } },
        now,
        {
          allowTestKeys: this.options.allowTestKeys,
          requireSigned: this.options.requireSignedDirectories,
          maxUnsignedAgeSeconds: this.options.maxUnsignedDirectoryAgeSeconds,
        }
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
  nonce?: string;
  windowSeconds?: number;
  relay?: boolean;
}
export type WebBotSigningKey =
  | { privateKey: AdcpJsonWebKey }
  | { publicKey: AdcpJsonWebKey; provider: SigningProvider };
async function signBase(base: string, key: WebBotSigningKey): Promise<Uint8Array> {
  const jwk = 'privateKey' in key ? key.privateKey : key.publicKey;
  const alg = algorithm(jwk);
  if (!['test', 'development'].includes(process.env.NODE_ENV ?? '') && TEST_KIDS.has(jwkThumbprint(jwk)))
    throw new TypeError('Published Web Bot Auth test keys cannot sign in production');
  if ('provider' in key) {
    if (key.provider.keyid !== jwkThumbprint(jwk) || key.provider.algorithm !== alg)
      throw new TypeError('Web Bot Auth provider identity does not match its public key');
    return key.provider.sign(Buffer.from(base));
  }
  const privateKey = createPrivateKey({ key: jwk as JsonWebKey, format: 'jwk' });
  if (alg === 'rsa-pss-sha512')
    return nodeSign('sha512', Buffer.from(base), {
      key: privateKey,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: 64,
    });
  return alg === 'ed25519'
    ? nodeSign(null, Buffer.from(base), privateKey)
    : nodeSign('sha256', Buffer.from(base), { key: privateKey, dsaEncoding: 'ieee-p1363' });
}
export async function signWebBotAuth(
  request: RequestLike,
  key: WebBotSigningKey,
  options: WebBotSigningOptions
): Promise<Record<string, string>> {
  const origin = canonicalAgentOrigin(options.origin);
  const label = options.label ?? 'sig1';
  if (!/^[a-z][a-z0-9_.*-]*$/.test(label)) throw new TypeError('Invalid signature label');
  const jwk = 'privateKey' in key ? key.privateKey : key.publicKey;
  const now = Math.floor((options.now ?? (() => Date.now() / 1000))());
  const window = options.windowSeconds ?? 300;
  const nonce = options.nonce ?? randomBytes(64).toString('base64url');
  if (!Number.isInteger(window) || window < 1 || window > 300 || !/^[A-Za-z0-9_+\/-]{22,256}={0,2}$/.test(nonce))
    throw new TypeError('Invalid Web Bot Auth lifetime or nonce');
  if (
    !options.relay &&
    ['signature', 'signature-input', 'signature-agent'].some(
      name => getHeaderValue(request.headers, name) !== undefined
    )
  )
    throw new TypeError(
      'Request already carries signature fields; pass relay: true to add a covering signature instead of replacing them'
    );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers))
    if (
      value !== undefined &&
      !['signature', 'signature-input', 'signature-agent', 'content-digest'].includes(name.toLowerCase())
    )
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  const components = ['"@method"', '"@target-uri"', '"@authority"'];
  if (request.body !== undefined && request.body !== '') {
    if (!getHeaderValue(headers, 'content-type'))
      throw new TypeError('Body-bearing Web Bot Auth requests need Content-Type');
    headers['content-digest'] = computeContentDigest(request.body, 'rfc8941-base64');
    components.push('"content-type"', '"content-digest"');
  }
  if (
    options.relay &&
    ['signature', 'signature-input', 'signature-agent'].some(name => !getHeaderValue(request.headers, name))
  )
    throw new TypeError('Relay requires the existing signature fields');
  const earlier = options.relay ? inputs(request.headers) : [];
  if (earlier.some(input => input.label === label || input.params.tag !== WEB_BOT_AUTH_PROFILE))
    throw new TypeError('Relay requires existing Web Bot Auth signatures and a fresh label');
  const priorAgent = options.relay ? getHeaderValue(request.headers, 'signature-agent') : undefined;
  if (priorAgent) dictionary(priorAgent, 'Signature-Agent');
  headers['signature-agent'] = `${priorAgent ? priorAgent + ', ' : ''}${label}="${origin}"`;
  components.push(`"signature-agent";key="${label}"`);
  for (const inner of earlier) {
    for (const component of inner.components) {
      const bare = component.split(';', 1)[0]!;
      const encoded = `"${bare}"${component.slice(bare.length)}`;
      if (!components.includes(encoded)) components.push(encoded);
    }
    components.push(`"signature-input";key="${inner.label}"`, `"signature";key="${inner.label}"`);
  }
  const priorInput = options.relay ? getHeaderValue(request.headers, 'signature-input') : undefined;
  const priorSignature = options.relay ? getHeaderValue(request.headers, 'signature') : undefined;
  if (options.relay && (!priorInput || !priorSignature || !priorAgent))
    throw new TypeError('Relay requires the existing signature fields');
  headers['signature-input'] =
    `${priorInput ? priorInput + ', ' : ''}${label}=(${components.join(' ')});created=${now};expires=${now + window};nonce="${nonce}";keyid="${jwkThumbprint(jwk)}";alg="${algorithm(jwk)}";tag="web-bot-auth"`;
  const input = parseSignatureInput(headers['signature-input'], label);
  if (priorSignature) headers.signature = priorSignature;
  // Sign the target URI exactly as the HTTP client will send it.
  const bytes = await signBase(
    buildWebBotAuthSignatureBase(input, { ...request, url: new URL(request.url).href, headers }),
    key
  );
  headers.signature = `${priorSignature ? priorSignature + ', ' : ''}${label}=:${Buffer.from(bytes).toString('base64')}:`;
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
  if (!signingKeys.length || signingKeys.length > 64 || !Number.isInteger(lifetime) || lifetime < 1)
    throw new TypeError('Invalid directory keys or lifetime');
  const keys = signingKeys.map(key => {
    const jwk = 'privateKey' in key ? key.privateKey : key.publicKey;
    return {
      kty: jwk.kty,
      ...(jwk.kty === 'RSA' ? { n: jwk.n, e: jwk.e } : { crv: jwk.crv, x: jwk.x }),
      ...(jwk.y ? { y: jwk.y } : {}),
      kid: jwkThumbprint(jwk),
      use: 'sig',
    } as AdcpJsonWebKey;
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
    const label = `key${i + 1}`;
    // Backdate created so verifiers whose clocks run slightly behind accept a fresh proof.
    const value = `${label}=("@authority";req "content-digest");created=${now - DIRECTORY_CLOCK_SKEW_SECONDS};expires=${now + lifetime};keyid="${keys[i]!.kid}";alg="${algorithm(keys[i]!)}";tag="${DIRECTORY_TAG}"`;
    const input = parseSignatureInput(value, label);
    const bytes = await signBase(
      buildWebBotAuthSignatureBase(input, { method: 'GET', url: response.request.url, headers: {} }, response),
      signingKeys[i]!
    );
    signatureInputs.push(value);
    signatures.push(`${label}=:${Buffer.from(bytes).toString('base64')}:`);
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
