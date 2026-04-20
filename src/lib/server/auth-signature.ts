/**
 * Bridge between {@link verifyRequestSignature} and the {@link Authenticator}
 * surface so RFC 9421 signatures compose with bearer / API-key auth via
 * {@link anyOf}.
 *
 * Use when an agent declares the `signed-requests` specialism AND also
 * accepts bearer-authed callers — the composition signals "either credential
 * type is sufficient". Unsigned-but-bearered requests fall through to the
 * next authenticator; signed requests with a valid signature short-circuit
 * the chain and surface a principal derived from the signing key.
 *
 * A request with a present-but-invalid signature throws {@link AuthError}
 * so `serve()` can return a 401 — `anyOf` surfaces that as "credentials
 * rejected" rather than falling through.
 *
 * ```ts
 * import { serve, verifyApiKey, anyOf, verifySignatureAsAuthenticator } from '@adcp/client/server';
 *
 * serve(createAgent, {
 *   authenticate: anyOf(
 *     verifyApiKey({ keys: { 'sk_live_abc': { principal: 'acct_42' } } }),
 *     verifySignatureAsAuthenticator({
 *       jwks, replayStore, revocationStore,
 *       capability: { supported: true, required_for: [], covers_content_digest: 'either' },
 *       resolveOperation: req => {
 *         try {
 *           const body = JSON.parse(req.rawBody ?? '');
 *           if (body.method === 'tools/call') return body.params?.name;
 *         } catch {}
 *         return undefined;
 *       },
 *     }),
 *   ),
 * });
 * ```
 *
 * The returned authenticator is tagged with {@link AUTH_NEEDS_RAW_BODY} so
 * `serve()` buffers `req.rawBody` before authentication runs.
 */
import type { IncomingMessage } from 'http';
import type { RequestLike } from '../signing/canonicalize';
import { RequestSignatureError } from '../signing/errors';
import type { JwksResolver } from '../signing/jwks';
import type { ReplayStore } from '../signing/replay';
import type { RevocationStore } from '../signing/revocation';
import type { VerifiedSigner, VerifierCapability, VerifyResult } from '../signing/types';
import { verifyRequestSignature } from '../signing/verifier';
import {
  AuthError,
  type AuthPrincipal,
  type AuthResult,
  type Authenticator,
  authenticatorNeedsRawBody,
  tagAuthenticatorNeedsRawBody,
  tagAuthenticatorPresenceGated,
} from './auth';

export interface VerifySignatureAsAuthenticatorOptions {
  /** Verifier capability block. `required_for` is not enforced here — unsigned
   *  requests fall through to the next authenticator — so set it to whatever
   *  your `request_signing` capability claim advertises. */
  capability: VerifierCapability;
  /** Resolves verification keys by `keyid`. */
  jwks: JwksResolver;
  /** Stores `(keyid, signature-bytes, expires)` tuples for replay detection. */
  replayStore: ReplayStore;
  /** Consulted for revoked `kid` / `jti` before accepting a signature. */
  revocationStore: RevocationStore;
  /** Override clock for tests. */
  now?: () => number;
  /**
   * Extract the AdCP operation name from the incoming request. Called with
   * the raw `IncomingMessage`; `req.rawBody` has been buffered by `serve()`
   * before this runs. Same semantics as
   * `ExpressMiddlewareOptions.resolveOperation` on {@link createExpressVerifier}.
   *
   * SECURITY: a resolver that always returns `undefined` disables
   * `capability.required_for` enforcement for this authenticator. Since the
   * bypass here is intentional (this adapter is for composition with other
   * authenticators — see the module docstring), the fall-through still
   * happens when the resolver returns `undefined`, so `required_for`
   * enforcement should live in a separate `preTransport`-mounted verifier
   * when composition is active.
   */
  resolveOperation: (req: IncomingMessage & { rawBody?: string }) => string | undefined;
  /**
   * Override how the request's full URL is reconstructed. Use when the
   * server sits behind a TLS-terminating or path-rewriting load balancer
   * and `req.headers.host` / `req.url` don't reflect what the signer signed.
   */
  getUrl?: (req: IncomingMessage & { rawBody?: string }) => string;
  /** Resolve the `agent_url` claim the verifier stamps on verified results. */
  agentUrlForKeyid?: (keyid: string) => string | undefined;
  /**
   * Shape the principal returned on successful signature verification.
   * Defaults to `{ principal: `signing:${keyid}`, claims: { signature: VerifiedSigner } }`.
   */
  makePrincipal?: (signer: VerifiedSigner) => AuthPrincipal;
}

/**
 * Build an {@link Authenticator} that verifies an RFC 9421 request signature.
 *
 * Behavior matrix:
 * - No `Signature-Input` header → returns `null` (fall through to next authenticator).
 * - Signature present and valid → returns {@link AuthPrincipal}.
 * - Signature present but invalid → throws {@link AuthError} (surfaces as 401).
 *
 * Populates `req.verifiedSigner` on success so downstream handlers see the
 * same side-channel state as the Express-shaped middleware.
 */
export function verifySignatureAsAuthenticator(options: VerifySignatureAsAuthenticatorOptions): Authenticator {
  const authenticator: Authenticator = async req => {
    if (!hasSignatureHeader(req)) return null;

    const body = (req as IncomingMessage & { rawBody?: string }).rawBody ?? '';
    const url = options.getUrl ? options.getUrl(req as IncomingMessage & { rawBody?: string }) : defaultUrl(req);
    const requestLike: RequestLike = {
      method: req.method ?? 'GET',
      url,
      headers: req.headers,
      body,
    };

    let result: VerifyResult;
    try {
      result = await verifyRequestSignature(requestLike, {
        capability: options.capability,
        jwks: options.jwks,
        replayStore: options.replayStore,
        revocationStore: options.revocationStore,
        now: options.now,
        operation: options.resolveOperation(req as IncomingMessage & { rawBody?: string }),
        agentUrlForKeyid: options.agentUrlForKeyid,
      });
    } catch (err) {
      if (err instanceof RequestSignatureError) {
        throw new AuthError(`Signature rejected (${err.code}).`, { cause: err });
      }
      throw new AuthError('Signature verification failed.', { cause: err });
    }

    if (result.status !== 'verified') {
      // Unreachable: `hasSignatureHeader` already gated entry, so the verifier
      // either throws (missing-pair / invalid / replayed / etc.) or returns
      // `status: 'verified'`. Fail loud if the verifier contract changes —
      // silently returning `null` would fall through to the next authenticator
      // as if no signature were present, breaking the auth invariant.
      throw new AuthError('Signature verification returned unexpected status.', {
        cause: new Error(`verifier returned status="${result.status}"`),
      });
    }

    // keyid is buyer-controlled (JWK spec places no charset restriction on
    // `kid`). Bound it to a URL-safe shape — explicitly excluding `:` — before
    // interpolating into the principal string, so downstream tenant-isolation
    // checks that split `signing:<keyid>` on the first `:` can't be confused
    // by a colon embedded in the signer's key id.
    if (!SAFE_KEYID.test(result.keyid)) {
      throw new AuthError('Signature key id contains unsupported characters.', {
        cause: new Error(`keyid=${JSON.stringify(result.keyid)} fails /^[A-Za-z0-9._-]{1,256}$/`),
      });
    }

    const signer: VerifiedSigner = {
      keyid: result.keyid,
      verified_at: result.verified_at,
      ...(result.agent_url !== undefined ? { agent_url: result.agent_url } : {}),
    };

    const principal = options.makePrincipal
      ? options.makePrincipal(signer)
      : {
          principal: `signing:${signer.keyid}`,
          claims: {
            signature: {
              keyid: signer.keyid,
              verified_at: signer.verified_at,
              ...(signer.agent_url !== undefined ? { agent_url: signer.agent_url } : {}),
            },
          },
        };

    // Write the side-channel state only after the principal is fully built so
    // a throw from `makePrincipal` leaves `req.verifiedSigner` unset — the
    // request didn't actually authenticate, downstream handlers must not see
    // a stale "verified" marker on a rejected request.
    (req as IncomingMessage & { verifiedSigner?: VerifiedSigner }).verifiedSigner = signer;
    return principal;
  };

  return tagAuthenticatorNeedsRawBody(authenticator);
}

/**
 * Compose a signature authenticator with a fallback under presence-gated
 * semantics: if the incoming request declares a `Signature-Input` header,
 * the signature authenticator is the ONLY path — its result (principal,
 * `null`, or thrown {@link AuthError}) is the final outcome and the fallback
 * never runs. Without `Signature-Input`, the fallback handles the request.
 *
 * This is the correct composition for the `signed-requests` specialism.
 * {@link anyOf}'s either-or contract incorrectly accepts a bearer-authed
 * request whose signature is present-but-invalid — fine for "either
 * credential is sufficient" but wrong for spec conformance, where a
 * declared-but-invalid signature MUST be rejected even when a valid bearer
 * accompanies it (revocation, window expiry, malformed covered-components,
 * etc.).
 *
 * ```ts
 * import {
 *   serve,
 *   anyOf,
 *   verifyApiKey,
 *   verifySignatureAsAuthenticator,
 *   requireSignatureWhenPresent,
 * } from '@adcp/client/server';
 *
 * serve(createAgent, {
 *   authenticate: requireSignatureWhenPresent(
 *     verifySignatureAsAuthenticator({ jwks, replayStore, revocationStore, capability, resolveOperation }),
 *     anyOf(verifyApiKey({ keys }), verifyBearer({ jwksUri, issuer, audience })),
 *   ),
 * });
 * ```
 *
 * Presence is detected from RFC 9421 signature headers: either
 * `Signature-Input` or the paired `Signature`. A request carrying only one of
 * the two is malformed but still treated as "signed intent" — the signature
 * authenticator runs and throws, which is what AdCP's negative conformance
 * vectors expect.
 *
 * Behavior matrix:
 *
 * | RFC 9421 signature header present? | Signature result          | Outcome                      |
 * |------------------------------------|---------------------------|------------------------------|
 * | yes                                | verified                  | signature principal          |
 * | yes                                | throws {@link AuthError}  | 401 (does NOT fall through)  |
 * | yes                                | returns `null`            | 401 via re-thrown `AuthError` (does NOT fall through) |
 * | no                                 | —                         | fallback runs verbatim       |
 *
 * The returned authenticator is tagged with {@link AUTH_NEEDS_RAW_BODY} when
 * either branch needs the raw body, so `serve()` buffers `req.rawBody` ahead
 * of authentication.
 *
 * **Do not nest this helper inside {@link anyOf}.** `anyOf` catches thrown
 * `AuthError`s and tries the next authenticator, which re-introduces the
 * bypass this helper exists to prevent. `anyOf` refuses such composition at
 * wire-up time (throws synchronously) — invert the order instead:
 * `requireSignatureWhenPresent(sig, anyOf(bearer, apiKey))`.
 */
export interface RequireSignatureWhenPresentOptions {
  /**
   * Operations that MUST be signed. When the incoming request carries no
   * RFC 9421 signature header AND the fallback authenticator returns
   * `null` (no credentials at all), the gate throws an {@link AuthError}
   * whose `cause` is {@link RequestSignatureError} with
   * `request_signature_required` — `serve()` maps that into a 401 with
   * `WWW-Authenticate: Signature error="request_signature_required"`.
   *
   * "Fallback bypass" is deliberately allowed: if the caller presents a
   * valid bearer (or API key) on a `requiredFor` operation, the fallback
   * succeeds and the request is accepted without a signature. This
   * matches the consensus on
   * [adcp#2586](https://github.com/adcontextprotocol/adcp/issues/2586):
   * `required_for` signals "signatures are the mandatory mechanism for
   * unauthenticated callers" — not "signatures are mandatory on top of
   * every other credential."
   *
   * When the request IS signed, `required_for` enforcement happens inside
   * the signature verifier itself (via `capability.required_for`), not
   * here — this pre-check is only for the no-signature path.
   */
  requiredFor?: readonly string[];
  /**
   * Extract the AdCP operation name (or any identifier that can be
   * matched against `requiredFor`) from the incoming request.
   *
   * For MCP agents, this usually parses `req.rawBody` as JSON-RPC and
   * pulls `params.name` when `method === 'tools/call'`:
   *
   * ```ts
   * resolveOperation: (req) => {
   *   try {
   *     const body = JSON.parse(req.rawBody ?? '');
   *     if (body?.method === 'tools/call') return body.params?.name;
   *   } catch {}
   *   return undefined;
   * }
   * ```
   *
   * When `requiredFor` is set but `resolveOperation` is omitted OR
   * returns `undefined`, the pre-check is skipped — better to let the
   * downstream handler produce a precise `INVALID_REQUEST` than to
   * reject every unsigned call as signature-required.
   */
  resolveOperation?: (req: IncomingMessage & { rawBody?: string }) => string | undefined;
}

/**
 * Compose a signature authenticator with a fallback under presence-gated
 * semantics: if the incoming request declares a `Signature-Input` header,
 * the signature authenticator is the ONLY path — its result (principal,
 * `null`, or thrown {@link AuthError}) is the final outcome and the fallback
 * never runs. Without `Signature-Input`, the fallback handles the request.
 *
 * Pass {@link RequireSignatureWhenPresentOptions.requiredFor} to enforce
 * `required_for` for the no-signature path: when the fallback produces no
 * principal on an operation that MUST be signed, the gate throws an
 * {@link AuthError} whose cause is a {@link RequestSignatureError} with
 * code `request_signature_required` — `serve()` maps that into a 401
 * with the RFC 9421 `WWW-Authenticate: Signature` challenge.
 */
export function requireSignatureWhenPresent(
  signatureAuth: Authenticator,
  fallbackAuth: Authenticator,
  options: RequireSignatureWhenPresentOptions = {}
): Authenticator {
  const requiredFor = new Set(options.requiredFor ?? []);
  const resolveOperation = options.resolveOperation;
  const combined: Authenticator = async req => {
    if (hasSignatureHeader(req)) {
      const result = await signatureAuth(req);
      if (result === null) {
        // A signature was declared but the sig authenticator didn't recognize
        // it. Falling through to the fallback would re-open the bypass the
        // presence gate exists to prevent — fail closed.
        throw new AuthError('Signature declared but not recognized.');
      }
      return result;
    }
    // Catch the fallback's throw so the `requiredFor` pre-check can run
    // regardless of fallback outcome. Without this, a caller presenting
    // a bad bearer on a required-for op triggers `anyOf` to throw an
    // `AuthError` with Bearer semantics, propagating past the pre-check
    // and producing `WWW-Authenticate: Bearer` — the conformance grader
    // reads the wrong error code on the exact vector this helper
    // exists to close.
    let fallbackResult: AuthResult | null = null;
    let fallbackError: unknown;
    let fallbackThrew = false;
    try {
      fallbackResult = await fallbackAuth(req);
    } catch (err) {
      fallbackThrew = true;
      fallbackError = err;
    }
    // `requiredFor` pre-check: when the op requires a signature AND no
    // signature was presented, surface `request_signature_required`
    // REGARDLESS of whether the fallback threw (bad bearer) or returned
    // null (no creds). Valid bearer is the only escape — if the fallback
    // returned a principal, we already returned above.
    if (requiredFor.size > 0 && resolveOperation) {
      const operation = resolveOperation(req as IncomingMessage & { rawBody?: string });
      if (operation && requiredFor.has(operation) && fallbackResult === null) {
        throw new AuthError(`Signature required for ${operation}.`, {
          cause: new RequestSignatureError(
            'request_signature_required',
            0,
            `Operation ${operation} requires an RFC 9421 request signature when no other credentials are presented.`
          ),
        });
      }
    }
    // Op not in requiredFor (or no resolver): rethrow the fallback's
    // original error so the 401 carries the fallback's challenge
    // (Bearer for bad-bearer, invalid_token for no-creds).
    if (fallbackThrew) throw fallbackError;
    if (fallbackResult !== null) return fallbackResult;
    return null;
  };
  const anyChildNeedsRawBody = authenticatorNeedsRawBody(signatureAuth) || authenticatorNeedsRawBody(fallbackAuth);
  // When `resolveOperation` is wired, it almost always reads
  // `req.rawBody` to parse the JSON-RPC body — the SDK's documented
  // pattern. If no child is tagged (test stubs, agents whose signature
  // path is non-SDK), `serve()` won't buffer the body and
  // `resolveOperation` silently sees `undefined`, bypassing
  // `requiredFor`. Tag the combined authenticator whenever a resolver
  // is present so buffering happens regardless of the child shapes.
  if (anyChildNeedsRawBody || resolveOperation) {
    tagAuthenticatorNeedsRawBody(combined);
  }
  tagAuthenticatorPresenceGated(combined);
  return combined;
}

export interface RequireAuthenticatedOrSignedOptions {
  /** RFC 9421 request-signature authenticator. Usually built with {@link verifySignatureAsAuthenticator}. */
  signature: Authenticator;
  /**
   * Credential authenticator that runs when no signature is present.
   * Usually {@link anyOf} of `verifyApiKey` / `verifyBearer` — whatever
   * credential types the agent accepts on unsigned calls.
   */
  fallback: Authenticator;
  /**
   * Operations that MUST be authenticated with a signature when no other
   * credential is presented. See
   * {@link RequireSignatureWhenPresentOptions.requiredFor}.
   *
   * Pass `MUTATING_TASKS` (exported from `@adcp/client`) to require
   * signatures on every mutating AdCP operation — matches the common
   * declaration in `capabilities.request_signing.required_for`.
   */
  requiredFor?: readonly string[];
  /** See {@link RequireSignatureWhenPresentOptions.resolveOperation}. */
  resolveOperation?: (req: IncomingMessage & { rawBody?: string }) => string | undefined;
}

/**
 * Bundled composition of {@link requireSignatureWhenPresent} with an
 * operation resolver — one call produces an authenticator that:
 *
 *   1. Prefers the RFC 9421 signature path when a `Signature-Input`
 *      header is present, with no bearer fall-through on invalid
 *      signatures (matches the `signed-requests` specialism contract).
 *   2. Accepts bearer / API key when no signature is present, including
 *      on `requiredFor` operations — valid credentials bypass the
 *      signature requirement.
 *   3. Rejects unsigned calls with no credentials on `requiredFor`
 *      operations with a `WWW-Authenticate: Signature` challenge whose
 *      error is `request_signature_required`.
 *
 * ```ts
 * import {
 *   serve,
 *   verifyApiKey,
 *   verifyBearer,
 *   anyOf,
 *   verifySignatureAsAuthenticator,
 *   requireAuthenticatedOrSigned,
 *   MUTATING_TASKS,
 * } from '@adcp/client/server';
 *
 * serve(createAgent, {
 *   authenticate: requireAuthenticatedOrSigned({
 *     signature: verifySignatureAsAuthenticator({ jwks, replayStore, revocationStore, capability, resolveOperation }),
 *     fallback: anyOf(verifyApiKey({ keys }), verifyBearer({ jwksUri, issuer, audience })),
 *     requiredFor: [...MUTATING_TASKS],
 *     resolveOperation: req => {
 *       try {
 *         const body = JSON.parse(req.rawBody ?? '');
 *         if (body?.method === 'tools/call') return body.params?.name;
 *       } catch {}
 *       return undefined;
 *     },
 *   }),
 * });
 * ```
 */
export function requireAuthenticatedOrSigned(options: RequireAuthenticatedOrSignedOptions): Authenticator {
  return requireSignatureWhenPresent(options.signature, options.fallback, {
    requiredFor: options.requiredFor,
    resolveOperation: options.resolveOperation,
  });
}

const SAFE_KEYID = /^[A-Za-z0-9._-]{1,256}$/;

function hasSignatureHeader(req: IncomingMessage): boolean {
  // RFC 9421 pairs `Signature-Input` with `Signature`. Either is sufficient
  // "signed intent" — a request carrying only one is malformed, but routing
  // it to the fallback would mean a half-formed signing attempt (e.g., client
  // bug that dropped the Signature-Input header) silently auths via bearer.
  // Fail closed: send it to the signature authenticator, which will throw.
  return nonEmptyHeader(req.headers['signature-input']) || nonEmptyHeader(req.headers['signature']);
}

function nonEmptyHeader(v: string | string[] | undefined): boolean {
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return false;
}

function defaultUrl(req: IncomingMessage): string {
  const forwardedProto = firstHeader(req.headers['x-forwarded-proto']);
  const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  const proto = forwardedProto ?? (encrypted ? 'https' : 'http');
  const host = firstHeader(req.headers['host']);
  if (!host) {
    throw new Error(
      'verifySignatureAsAuthenticator: missing Host header. Pass `getUrl` to reconstruct the canonical URL explicitly.'
    );
  }
  return `${proto}://${host}${req.url ?? '/'}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
}
