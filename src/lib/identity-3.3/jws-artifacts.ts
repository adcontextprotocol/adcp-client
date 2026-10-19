/**
 * JWS artifacts on the issuer's Web Bot Auth key directory (AdCP 3.3,
 * `specs/agent-identity-3-3.md` R4, adcontextprotocol/adcp#8299).
 *
 * Three JWS artifacts move to the issuer's WBA key directory in 3.3. `O` is
 * the canonical origin of the signing agent's URL:
 *
 * | Artifact                          | `O` is the origin of |
 * | --------------------------------- | -------------------- |
 * | governance context                | `iss`                |
 * | designated-task response signing  | `agent_url`          |
 * | rights attestation                | `rights_agent.url`   |
 *
 * When the trust record derived from `O` (R3a step 1) lists `O`, the JWS is
 * verified with a key from `O`'s key directory, never under the 3.2 profile:
 * `alg` is `EdDSA`, `kid` is the key's JWK thumbprint, the 3.2 key-purpose
 * checks (`use`, `key_ops`, `adcp_use`) do not apply, and revocation is `O`'s
 * list. Historical verification of a governance context uses the governance
 * key archive at `O`. An issuer whose `O` no trust record lists stays on the
 * 3.2 profile. A trust-record fetch failure is not absence: it never selects
 * the 3.2 profile.
 *
 * Profile selection never reads an unsigned field: callers pass the signing
 * agent URL from their own context (the governance agent they expect, the
 * agent they called, the rights agent named in the constraint they hold),
 * never a value read from the unverified token.
 *
 * Only `import type` reaches the trust and revocation modules, so loading this
 * file (and the governance verifier that uses it) does not load Ajv or the
 * draft schemas.
 */
import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';

import { ssrfSafeFetch, type SsrfFetchOptions } from '../net';
import { canonicalAgentOrigin } from '../signing/agent-resolver/canonicalize';
import { eTldPlusOne } from '../signing/agent-resolver/etld';
import { parseStrictJson } from '../signing/agent-resolver/strict-json';
import type { AdcpJsonWebKey } from '../signing/types';
import {
  isRefusedWebBotAuthTestKey,
  jwkThumbprint,
  receivedAgentOrigin,
  type SignatureDirectoryResolver,
} from '../signing/web-bot-auth';
import type { OriginRevocationResolver } from './revocation';
import type { TrustEvaluator } from './trust';

/** The three artifacts R4 moves to the WBA key directory. */
export type JwsArtifactKind = 'governance_context' | 'designated_task_response' | 'rights_attestation';

/** Which profile verifies a JWS artifact from origin `O`. */
export type JwsArtifactProfile =
  | {
      profile: 'web-bot-auth';
      /** `O`, the canonical origin of the signing agent's URL. */
      origin: string;
      /** The registrable domain whose trust record lists `O`. */
      operator: string;
    }
  | {
      profile: '3.2';
      origin: string;
      /**
       * `no_trust_record`: `O` has no registrable domain (IP literal, public
       * suffix), or its operator has never published a trust record (404/410
       * before any 200). `unlisted`: the record does not list `O`.
       */
      reason: 'no_trust_record' | 'unlisted';
    };

export type JwsArtifactErrorCode =
  /** A trust record, key directory, archive or revocation list could not be read. Retryable. */
  | 'jws_key_unavailable'
  /** No key at `O` (directory, or archive for history) carries the `kid`. */
  | 'jws_key_unknown'
  /** `alg` is not `EdDSA`, `kid` is not the key's thumbprint, or the signature does not verify. */
  | 'jws_invalid'
  /** `O`'s revocation list revokes the `kid`. */
  | 'jws_key_revoked'
  /** `O`'s revocation status is unknown, or (by default) `O` serves no list. Retryable. */
  | 'jws_revocation_unavailable';

export class JwsArtifactError extends Error {
  constructor(
    readonly code: JwsArtifactErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message);
    this.name = 'JwsArtifactError';
    if (options?.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause });
  }
  /** True for outages: retry later, never treat as absence or as a verdict on the artifact. */
  get transient(): boolean {
    return this.code === 'jws_key_unavailable' || this.code === 'jws_revocation_unavailable';
  }
}

/** Components the WBA path reuses. */
export interface JwsArtifactWebBotAuthOptions {
  /** Derives the trust record from `O` (R3a step 1) to select the profile. */
  trust: TrustEvaluator;
  /** `O`'s Web Bot Auth key directory. */
  directory: SignatureDirectoryResolver;
  /**
   * `O`'s revocation list (R3). Strongly recommended: without it, the WBA
   * path checks no key revocation.
   */
  revocation?: OriginRevocationResolver;
}

/**
 * Select the profile for a JWS artifact whose signing agent URL is
 * `signingAgentUrl` (R4). Throws {@link JwsArtifactError}
 * `jws_key_unavailable` when the trust record cannot be read: a fetch failure
 * is never absence and never selects the 3.2 profile.
 */
export async function selectJwsArtifactProfile(
  signingAgentUrl: string,
  trust: TrustEvaluator
): Promise<JwsArtifactProfile> {
  const origin = canonicalAgentOrigin(signingAgentUrl);
  try {
    // An origin with no registrable domain has no trust record (R3a step 1).
    eTldPlusOne(origin);
  } catch {
    return { profile: '3.2', origin, reason: 'no_trust_record' };
  }
  let record: Awaited<ReturnType<TrustEvaluator['get']>>;
  try {
    record = await trust.get(origin);
  } catch (cause) {
    // TrustRecordUnavailableError, or any other failure to read the record:
    // never absence. A once-authoritative operator's 404/410 lands here too.
    throw new JwsArtifactError('jws_key_unavailable', 'Issuer trust record is unavailable', { cause });
  }
  if (record.status !== 'present') return { profile: '3.2', origin, reason: 'no_trust_record' };
  const listed = (record.record.agents ?? []).some(agent => {
    try {
      return canonicalAgentOrigin(agent.url) === origin;
    } catch {
      return false;
    }
  });
  return listed
    ? { profile: 'web-bot-auth', origin, operator: record.operator }
    : { profile: '3.2', origin, reason: 'unlisted' };
}

export interface VerifyWebBotAuthJwsArtifactOptions {
  directory: SignatureDirectoryResolver;
  revocation?: OriginRevocationResolver;
  /**
   * How to treat `O`'s revocation status `absent` (the origin serves no list).
   * `reject` (default) fails closed, as a WBA identity without a list cannot be
   * bound for spend. `accept` treats it as nothing revoked.
   */
  revocationAbsent?: 'reject' | 'accept';
  /**
   * Historical verification: also look the `kid` up in the governance key
   * archive at `O` when the directory does not carry it. Governance contexts
   * only; only governance agents publish an archive.
   */
  archive?: GovernanceKeyArchiveResolver;
  /** Critical header parameters the surface understands (jose `crit`). */
  crit?: Record<string, boolean>;
}

export interface VerifiedWebBotAuthJwsArtifact {
  origin: string;
  kid: string;
  key: AdcpJsonWebKey;
  /** Where the key came from: `O`'s key directory, or (history) its archive. */
  keySource: 'directory' | 'archive';
  protectedHeader: Record<string, unknown>;
  payload: Uint8Array;
}

/**
 * Verify a compact JWS with a key from `origin`'s WBA key directory (R4):
 * `alg` `EdDSA`, `kid` the key's JWK thumbprint, no `use`/`key_ops`/`adcp_use`
 * checks, and revocation from `origin`'s list. Signature and key only: every
 * other check of the surface (claims, audience, freshness, replay) stays with
 * the surface. Throws {@link JwsArtifactError}.
 */
export async function verifyWebBotAuthJwsArtifact(
  token: string,
  origin: string,
  options: VerifyWebBotAuthJwsArtifactOptions
): Promise<VerifiedWebBotAuthJwsArtifact> {
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(token) as Record<string, unknown>;
  } catch {
    throw new JwsArtifactError('jws_invalid', 'Malformed JWS protected header');
  }
  if (header.alg !== 'EdDSA') throw new JwsArtifactError('jws_invalid', 'A Web Bot Auth JWS artifact uses alg EdDSA');
  const kid = header.kid;
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 256)
    throw new JwsArtifactError('jws_key_unknown', 'JWS kid is missing');
  // Directory, revocation and archive are all keyed by the exact canonical https origin.
  try {
    origin = receivedAgentOrigin(canonicalAgentOrigin(origin));
  } catch {
    throw new JwsArtifactError('jws_key_unknown', 'Signing origin is not an https origin');
  }

  let key: AdcpJsonWebKey | null = null;
  let keySource: VerifiedWebBotAuthJwsArtifact['keySource'] = 'directory';
  let directoryFailure: unknown;
  try {
    key = await options.directory.resolve(kid, origin);
  } catch (cause) {
    directoryFailure = cause;
  }
  if (!key && options.archive) {
    const archived = await options.archive.resolve(origin, kid);
    if (archived) {
      key = archived;
      keySource = 'archive';
    }
  }
  if (!key) {
    if (directoryFailure !== undefined)
      throw new JwsArtifactError('jws_key_unavailable', 'Issuer key directory is unavailable', {
        cause: directoryFailure,
      });
    throw new JwsArtifactError('jws_key_unknown', 'No key at the issuer origin carries this kid');
  }
  if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || typeof key.x !== 'string')
    throw new JwsArtifactError('jws_invalid', 'A Web Bot Auth JWS artifact is signed with an Ed25519 key');
  let thumbprint: string;
  try {
    thumbprint = jwkThumbprint(key);
  } catch {
    throw new JwsArtifactError('jws_invalid', 'Key thumbprint cannot be computed');
  }
  if (kid !== thumbprint) throw new JwsArtifactError('jws_invalid', 'JWS kid is not the key JWK thumbprint');

  let verified: Awaited<ReturnType<typeof compactVerify>>;
  try {
    const publicKey: JWK = { kty: 'OKP', crv: 'Ed25519', x: key.x };
    verified = await compactVerify(token, await importJWK(publicKey, 'EdDSA'), {
      algorithms: ['EdDSA'],
      ...(options.crit ? { crit: options.crit } : {}),
    });
  } catch {
    throw new JwsArtifactError('jws_invalid', 'JWS signature verification failed');
  }

  if (options.revocation) {
    let status: Awaited<ReturnType<OriginRevocationResolver['status']>>;
    try {
      status = await options.revocation.status(origin, kid);
    } catch (cause) {
      throw new JwsArtifactError('jws_revocation_unavailable', 'Issuer revocation status could not be established', {
        cause,
      });
    }
    if (status === 'revoked') throw new JwsArtifactError('jws_key_revoked', 'Signing key is revoked by its origin');
    if (status === 'unknown' || (status === 'absent' && (options.revocationAbsent ?? 'reject') === 'reject'))
      throw new JwsArtifactError('jws_revocation_unavailable', 'Issuer revocation status could not be established');
  }

  return {
    origin,
    kid,
    key,
    keySource,
    protectedHeader: verified.protectedHeader as Record<string, unknown>,
    payload: verified.payload,
  };
}

export const GOVERNANCE_KEY_ARCHIVE_PATH = '/.well-known/jwks-archive.json';

export interface GovernanceKeyArchiveResolverOptions {
  now?: () => number;
  fetchOptions?: Pick<SsrfFetchOptions, 'lookup' | 'trustedFetchFn'>;
  /** Seconds an archive read stays cached. Default 300. */
  maxAgeSeconds?: number;
  /** Origins cached at once. Default 256. */
  maxOrigins?: number;
  /** Published fixture keys are read only outside production, as for the key directory. */
  allowTestKeys?: boolean;
}

/**
 * The governance key archive at an origin (`security.mdx` §Revocation):
 * `{origin}/.well-known/jwks-archive.json`, a JWKS of retired governance keys
 * kept discoverable for audit. On the WBA path only Ed25519 keys whose `kid`
 * (when present) is their JWK thumbprint are read; other keys are ignored. A
 * 404/410 is an origin with no archive. Any other failure is
 * `jws_key_unavailable`, never absence.
 */
export class GovernanceKeyArchiveResolver {
  private readonly cache = new Map<string, { keys: AdcpJsonWebKey[]; freshUntil: number }>();
  private readonly pending = new Map<string, Promise<AdcpJsonWebKey[]>>();
  constructor(private readonly options: GovernanceKeyArchiveResolverOptions = {}) {
    const maxAge = options.maxAgeSeconds ?? 300;
    if (!Number.isFinite(maxAge) || maxAge < 0)
      throw new TypeError('maxAgeSeconds must be a finite, non-negative number');
  }
  async resolve(origin: string, kid: string): Promise<AdcpJsonWebKey | null> {
    origin = receivedAgentOrigin(canonicalAgentOrigin(origin));
    const now = (this.options.now ?? (() => Date.now() / 1000))();
    const cached = this.cache.get(origin);
    let keys: AdcpJsonWebKey[];
    if (cached && cached.freshUntil > now) keys = cached.keys;
    else {
      let pending = this.pending.get(origin);
      if (!pending) {
        pending = this.fetch(origin, now);
        this.pending.set(origin, pending);
      }
      try {
        keys = await pending;
      } finally {
        if (this.pending.get(origin) === pending) this.pending.delete(origin);
      }
    }
    return keys.find(key => key.kid === kid) ?? null;
  }
  private async fetch(origin: string, now: number): Promise<AdcpJsonWebKey[]> {
    let keys: AdcpJsonWebKey[];
    try {
      const response = await ssrfSafeFetch(origin + GOVERNANCE_KEY_ARCHIVE_PATH, {
        ...this.options.fetchOptions,
        headers: { accept: 'application/json' },
        timeoutMs: 10_000,
        maxBodyBytes: 1024 * 1024,
      });
      if (response.status === 404 || response.status === 410) keys = [];
      else {
        if (response.status !== 200) throw new Error(`Archive answered ${response.status}`);
        const document = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(response.body), 32) as {
          keys?: unknown;
        };
        if (!Array.isArray(document.keys) || document.keys.length > 4096) throw new Error('Invalid key archive');
        keys = [];
        for (const raw of document.keys) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const jwk = raw as AdcpJsonWebKey & Record<string, unknown>;
          // Published private material is a leak: refuse the archive, as the directory does.
          if (Object.keys(jwk).some(name => PRIVATE_JWK_MEMBERS.has(name.toLowerCase())))
            throw new Error('Key archive publishes private key material');
          if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') continue;
          const thumbprint = jwkThumbprint(jwk);
          if (jwk.kid !== undefined && jwk.kid !== thumbprint) continue;
          if (isRefusedWebBotAuthTestKey(thumbprint, this.options.allowTestKeys)) continue;
          keys.push({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: thumbprint } as AdcpJsonWebKey);
        }
      }
    } catch (cause) {
      throw new JwsArtifactError('jws_key_unavailable', 'Governance key archive is unavailable', { cause });
    }
    if (this.cache.size >= (this.options.maxOrigins ?? 256) && !this.cache.has(origin))
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(origin, { keys, freshUntil: now + (this.options.maxAgeSeconds ?? 300) });
    return keys;
  }
}

/** RFC 7517/7518 private JWK members, compared case-insensitively. */
const PRIVATE_JWK_MEMBERS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
