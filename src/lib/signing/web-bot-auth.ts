import { toReleasePrecisionVersion } from '../version';
/** Experimental AdCP 3.3 profile, pinned to adcp#7894 and IETF webbotauth-00. */
import { createHash, createPrivateKey, randomBytes, sign as nodeSign, type JsonWebKey } from 'crypto';
import { parseDictionary, parseItem, serializeItem } from 'structured-headers';
import { ssrfSafeFetch, type SsrfFetchOptions } from '../net';
import { eTldPlusOne } from './agent-resolver/etld';
import { canonicalAgentOrigin } from './agent-resolver/canonicalize';
import { canonicalAgentUrl } from './agent-resolver/select-agent';
import { parseStrictJson } from './agent-resolver/strict-json';
import {
  canonicalAuthority,
  canonicalTargetUri,
  getHeaderValue,
  type RequestLike,
  type ResponseLike,
} from './canonicalize';
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

/** HTTP outcome, deliberately separate from the legacy request_signature_* taxonomy. */
export class WebBotAuthError extends Error {
  readonly headers: Record<string, string>;
  get body(): Record<string, unknown> {
    if (
      [
        'key_revoked',
        'identity_not_bound',
        'revocation_unavailable',
        'revocation_persistence_failed',
        'replay_unavailable',
      ].includes(this.reason)
    ) {
      const transient = this.reason.endsWith('_unavailable') || this.reason === 'revocation_persistence_failed';
      return {
        adcp_error: {
          code: transient ? 'SERVICE_UNAVAILABLE' : 'PERMISSION_DENIED',
          message: this.message,
          recovery: transient ? 'transient' : 'correctable',
        },
      };
    }
    return { error: this.message };
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
      status === 403 &&
      ![
        'key_revoked',
        'identity_not_bound',
        'revocation_unavailable',
        'revocation_persistence_failed',
        'replay_unavailable',
        'profile_disabled',
      ].includes(reason)
        ? {
            'Accept-Signature':
              'sig1=("@method" "@target-uri" "@authority" "content-type" "content-digest" "signature-agent";key="sig1");created;expires;nonce;keyid;tag="web-bot-auth"',
          }
        : status === 429
          ? { 'Retry-After': '60' }
          : {};
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
export function jwkThumbprint(jwk: Partial<Pick<AdcpJsonWebKey, 'kty' | 'crv' | 'x' | 'y'>>): string {
  let fields: Record<string, unknown>;
  if (jwk.kty === 'OKP' && typeof jwk.crv === 'string' && typeof jwk.x === 'string')
    fields = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  else if (jwk.kty === 'EC' && typeof jwk.crv === 'string' && typeof jwk.x === 'string' && typeof jwk.y === 'string')
    fields = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  else return denied('unsupported_key');
  return createHash('sha256').update(JSON.stringify(fields)).digest('base64url');
}
function algorithm(jwk: AdcpJsonWebKey): AdcpSignAlg {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'ed25519';
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ecdsa-p256-sha256';
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
      else if (bare === '@target-uri') value = canonicalTargetUri(request.url, '3.2');
      else if (bare === '@authority') value = canonicalAuthority(request.url, '3.2');
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
export interface WebBotAuthAuthorizationFailure {
  code: 'PERMISSION_DENIED' | 'SERVICE_UNAVAILABLE';
  message: string;
  recovery: 'correctable' | 'transient';
}
const authorizationFailures = new WeakSet<object>();
export function createWebBotAuthAuthorizationFailure(
  reason: 'key_revoked' | 'identity_not_bound' | 'revocation_unavailable'
): WebBotAuthAuthorizationFailure {
  const failure: WebBotAuthAuthorizationFailure = Object.freeze({
    code: reason === 'revocation_unavailable' ? 'SERVICE_UNAVAILABLE' : 'PERMISSION_DENIED',
    message:
      reason === 'revocation_unavailable'
        ? 'Identity revocation information is unavailable'
        : reason === 'key_revoked'
          ? 'Agent identity key is revoked'
          : 'Agent identity is not onboarded for this operation',
    recovery: reason === 'revocation_unavailable' ? 'transient' : 'correctable',
  });
  authorizationFailures.add(failure);
  return failure;
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
  directory: SignatureDirectoryResolver;
  /** Published fixture keys are allowed only outside production. */
  allowTestKeys?: boolean;
  /** Unknown revocation state is acceptable only for trusted read operations. */
  requireFreshRevocation?: boolean;
  /** SDK server adapters carry verified authorization denials into normal tool errors. */
  deferAuthorizationErrors?: boolean;
  /** Atomic, shared across endpoints and replicas. Nonce scope is the identity origin, not the rotating kid. */
  replayStore: ReplayStore;
  now?: () => number;
  isRevoked: (origin: string, keyid: string) => Promise<boolean>;
  /** Older #7894 vector draft expects 403; ratified R2 defaults to 429. */
  replayStatus?: 403 | 429;
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
      const proof = options.directory.getAuditProof(origin);
      if (!proof || new URL(proof.request.url).origin !== origin) denied('directory_origin');
      const checkedDirectory = verifySignatureDirectory(
        proof,
        now,
        options.allowTestKeys ?? options.directory.allowsTestKeys
      );
      const key = checkedDirectory.keys.find(key => key.kid === keyid);
      if (!key || jwkThumbprint(key) !== keyid) denied('key');
      verifyBytes(input, request, key);
      let authorizationFailure: WebBotAuthAuthorizationFailure | undefined;
      try {
        if (await options.isRevoked(origin, keyid)) denied('key_revoked');
      } catch (thrown) {
        // The signature verified: an unexpected checker failure is unknown
        // revocation state, never a signature challenge.
        const error = thrown instanceof WebBotAuthError ? thrown : new WebBotAuthError(403, 'revocation_unavailable');
        if (
          options.requireFreshRevocation === false &&
          error instanceof WebBotAuthError &&
          error.reason === 'revocation_unavailable'
        ) {
          /* Reads tolerate unknown state. */
        } else if (
          options.deferAuthorizationErrors &&
          error instanceof WebBotAuthError &&
          ['key_revoked', 'revocation_unavailable', 'revocation_persistence_failed'].includes(error.reason)
        )
          authorizationFailure = createWebBotAuthAuthorizationFailure(
            error.reason === 'revocation_persistence_failed'
              ? 'revocation_unavailable'
              : (error.reason as 'key_revoked' | 'revocation_unavailable')
          );
        else throw error;
      }
      const nonceTuple = JSON.stringify([origin, nonce]);
      if (nonces.has(nonceTuple)) throw new WebBotAuthError(options.replayStatus ?? 429, 'nonce_replayed');
      nonces.add(nonceTuple);
      const signer: VerifiedWebBotSigner = Object.freeze({
        profile: WEB_BOT_AUTH_PROFILE,
        origin,
        keyid,
        label: input.label,
        verified_at: now,
        ...(authorizationFailure && { authorizationFailure }),
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
      } catch {
        // Replay state is unavailable for a correctly signed request: transient, no challenge.
        throw new WebBotAuthError(403, 'replay_unavailable');
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
    return denied('verification_unavailable');
  }
}

export interface VerifiedSignatureDirectory {
  keys: AdcpJsonWebKey[];
  expires: number;
  /** Preserve exact signed bytes and response headers for auditing. */
  proof: ResponseLike;
}
export function verifySignatureDirectory(
  response: ResponseLike,
  now = Date.now() / 1000,
  allowTestKeys = false
): VerifiedSignatureDirectory {
  try {
    if (!Number.isFinite(now)) denied('directory_invalid');
    const origin = canonicalAgentOrigin(response.request.url);
    if (
      response.request.url !== origin + SIGNATURE_DIRECTORY_PATH ||
      response.status !== 200 ||
      getHeaderValue(response.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase() !==
        SIGNATURE_DIRECTORY_MEDIA_TYPE
    )
      denied('directory_response');
    const body = response.body ?? '';
    if (Buffer.byteLength(body) > 256 * 1024) denied('directory_size');
    assertDigest(response.headers, body);
    const document = parseStrictJson(body, 32) as { keys?: AdcpJsonWebKey[] };
    if (!Array.isArray(document.keys) || !document.keys.length || document.keys.length > 64) denied('directory_keys');
    const signatures = inputs(response.headers);
    const keys = new Set<string>();
    let expires = Infinity;
    for (const key of document.keys) {
      if (
        !key ||
        typeof key !== 'object' ||
        typeof key.kid !== 'string' ||
        key.kid !== jwkThumbprint(key) ||
        keys.has(key.kid) ||
        key.d !== undefined ||
        Object.keys(key).some(k => k.startsWith('_private')) ||
        key.adcp_use !== undefined ||
        ((!allowTestKeys || !['test', 'development'].includes(process.env.NODE_ENV ?? '')) && TEST_KIDS.has(key.kid))
      )
        denied('directory_key');
      keys.add(key.kid);
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
    return { keys: document.keys, expires, proof: response };
  } catch (error) {
    if (error instanceof WebBotAuthError) throw error;
    return denied('directory_invalid');
  }
}

export interface SignatureDirectoryResolverOptions {
  now?: () => number;
  fetchOptions?: Pick<SsrfFetchOptions, 'lookup' | 'trustedFetchFn'>;
  allowTestKeys?: boolean;
  maxOrigins?: number;
  /** Globally bound concurrency across attacker-selected origins. */
  maxConcurrentFetches?: number;
}
/** Multi-origin discovery. Cache keys never collapse origins sharing a kid. */
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
    if (cached && cached.freshUntil > now && cached.directory.expires > now) {
      const key = cached.directory.keys.find(k => k.kid === keyid);
      if (key || (this.keyMissCooldown.get(origin) ?? 0) > now) return key ?? null;
      this.keyMissCooldown.set(origin, now + 60);
    }
    if ((this.failures.get(origin) ?? 0) > now) {
      if (cached && cached.directory.expires > now) return cached.directory.keys.find(k => k.kid === keyid) ?? null;
      return denied('directory_unavailable');
    }
    let pending = this.pending.get(origin);
    if (!pending) {
      if (
        [...this.pending.keys()].filter(pendingOrigin => eTldPlusOne(pendingOrigin) === eTldPlusOne(origin)).length >=
          2 ||
        this.pending.size >= (this.options.maxConcurrentFetches ?? 16)
      ) {
        if (cached && cached.directory.expires > now) return cached.directory.keys.find(k => k.kid === keyid) ?? null;
        throw new WebBotAuthError(429, 'directory_fetch_limit');
      }
      pending = this.fetch(origin, now);
      this.pending.set(origin, pending);
    }
    try {
      return (await pending).keys.find(k => k.kid === keyid) ?? null;
    } catch (error) {
      // A failed fetch never proves removal, but cached possession proof must
      // still be valid. Successful refresh replaces the whole key set.
      if (cached && cached.directory.expires > now) return cached.directory.keys.find(k => k.kid === keyid) ?? null;
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
      // ignoreBOM: the digest covers the exact bytes, including any BOM.
      const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.body);
      const directory = verifySignatureDirectory(
        { status: result.status, headers: result.headers, body, request: { method: 'GET', url } },
        now,
        this.options.allowTestKeys
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
    return this.options.allowTestKeys === true && ['test', 'development'].includes(process.env.NODE_ENV ?? '');
  }
  getAuditProof(origin: string): ResponseLike | undefined {
    return this.cache.get(receivedAgentOrigin(origin))?.directory.proof;
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
  const nonce = options.nonce ?? randomBytes(32).toString('base64url');
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
  const bytes = await signBase(buildWebBotAuthSignatureBase(input, { ...request, headers }), key);
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
      crv: jwk.crv,
      x: jwk.x,
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
