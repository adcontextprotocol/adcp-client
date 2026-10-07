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
 * import {
 *   serve,
 *   verifyApiKey,
 *   anyOf,
 *   verifySignatureAsAuthenticator,
 *   adcpOperationResolver,
 * } from '@adcp/sdk/server';
 *
 * serve(createAgent, {
 *   authenticate: anyOf(
 *     verifyApiKey({ keys: { 'sk_live_abc': { principal: 'acct_42' } } }),
 *     verifySignatureAsAuthenticator({
 *       jwks, replayStore, revocationStore,
 *       capability: { supported: true, required_for: [], covers_content_digest: 'either' },
 *       resolveOperation: adcpOperationResolver,
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
import { InMemoryReplayStore, type ReplayStore } from '../signing/replay';
import { InMemoryRevocationStore, type RevocationStore } from '../signing/revocation';
import type { VerifiedSigner, VerifierCapability, VerifyResult } from '../signing/types';
import {
  isUnresolvableOperation,
  resolveRequestOperation,
  describeUnresolvable,
  type OperationResolutionInput,
  type ResolvedOperation,
} from '../signing/operation-resolution';
import {
  assertUnsignedOperationNotRequired,
  assertUnsignedProtocolMethodNotRequired,
  assertUnsignedWebhookAuthenticationAbsent,
  unresolvableOperationError,
  verifyRequestSignature,
} from '../signing/verifier';
import { markVerifiedHttpSig } from './decisioning/buyer-agent';
import {
  AuthError,
  authenticatorNeedsRawBody,
  type AuthPrincipal,
  type AuthResult,
  type Authenticator,
  getServeRequestContext,
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
  /**
   * Stores `(keyid, signature-bytes, expires)` tuples for replay detection.
   * Defaults to a fresh {@link InMemoryReplayStore} — fine for single-process
   * deployments. Wire a shared store (Redis, Postgres, etc.) for multi-replica
   * setups where a signature accepted on one replica must be rejected on the
   * others.
   */
  replayStore?: ReplayStore;
  /**
   * Consulted for revoked `kid` / `jti` before accepting a signature.
   * Defaults to a fresh {@link InMemoryRevocationStore}. Most agents don't
   * revoke at runtime; when you do, swap in a store backed by your secrets
   * manager or admin tooling.
   */
  revocationStore?: RevocationStore;
  /** Override clock for tests. */
  now?: () => number;
  /**
   * Trusted endpoint release pin used to select the 3.0/3.1 or 3.2 signature
   * profile. Set it on every endpoint that advertises a 3.2 release: a 3.2
   * pin rejects Base64URL `Signature` / `Content-Digest` values as
   * `request_signature_header_malformed` whatever `capability` says. When
   * omitted, verification accepts both encodings for SDK 13 compatibility
   * while digest coverage follows `capability`.
   */
  adcpVersion?: string;
  /**
   * Extract the AdCP operation name from the incoming request. Called with
   * the raw `IncomingMessage`; `req.rawBody` has been buffered by `serve()`
   * before this runs. Same semantics as
   * `ExpressMiddlewareOptions.resolveOperation` on {@link createExpressVerifier}.
   *
   * Pass {@link adcpOperationResolver}: it resolves MCP `tools/call` and A2A
   * `SendMessage` / `message/send` requests, and reports a body that does not
   * resolve to exactly one operation as unresolvable, which the verifier
   * rejects with `request_body_malformed`.
   *
   * SECURITY: a resolver that always returns `undefined` disables
   * `capability.required_for` enforcement for this authenticator. This adapter
   * is for composition with other authenticators (see the module docstring),
   * so unsigned requests fall through to the next authenticator regardless;
   * `required_for` enforcement on the unsigned path belongs to
   * {@link requireSignatureWhenPresent}, which fails closed on an
   * unresolvable body.
   */
  resolveOperation: (req: IncomingMessage & { rawBody?: string }) => ResolvedOperation;
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
  // Instantiate defaults once at wire-up time so every request on this
  // authenticator shares the same replay/revocation state — lazy
  // per-request construction would defeat replay detection entirely.
  const replayStore = options.replayStore ?? new InMemoryReplayStore();
  const revocationStore = options.revocationStore ?? new InMemoryRevocationStore();

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
        replayStore,
        revocationStore,
        now: options.now,
        adcpVersion: options.adcpVersion,
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

    const signer: VerifiedSigner = {
      keyid: result.keyid,
      verified_at: result.verified_at,
      ...(result.operatorRecord !== undefined && { operatorRecord: result.operatorRecord }),
      ...(result.agent_url !== undefined ? { agent_url: result.agent_url } : {}),
    };
    const principal = principalForVerifiedSigner(signer, options.makePrincipal);

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
 * Build the authenticated principal shared by the authenticate-hook and the
 * auto-wired `signedRequests` verifier. A custom principal keeps its identity
 * fields, while the framework still attaches the branded HTTP-signature
 * credential unless the callback explicitly supplied a credential of its own.
 *
 * @internal
 */
export function principalForVerifiedSigner(
  signer: VerifiedSigner,
  makePrincipal?: (signer: VerifiedSigner) => AuthPrincipal
): AuthPrincipal {
  // keyid is buyer-controlled (JWK spec places no charset restriction on
  // `kid`). Bound it to a URL-safe shape — explicitly excluding `:` — before
  // interpolating into the principal string, so downstream tenant-isolation
  // checks that split `signing:<keyid>` on the first `:` cannot be confused.
  if (!SAFE_KEYID.test(signer.keyid)) {
    throw new AuthError('Signature key id contains unsupported characters.', {
      cause: new Error(`keyid=${JSON.stringify(signer.keyid)} fails /^[A-Za-z0-9._-]{1,256}$/`),
    });
  }

  const credential =
    signer.agent_url !== undefined
      ? markVerifiedHttpSig({
          kind: 'http_sig',
          keyid: signer.keyid,
          agent_url: signer.agent_url,
          verified_at: signer.verified_at,
        })
      : undefined;
  if (makePrincipal !== undefined) {
    const custom = makePrincipal(signer);
    if (
      !custom ||
      typeof custom !== 'object' ||
      typeof (custom as AuthPrincipal).principal !== 'string' ||
      (custom as AuthPrincipal).principal.length === 0
    ) {
      throw new AuthError('Signature key is not mapped to an authenticated principal.');
    }
    return credential !== undefined && custom.credential === undefined ? { ...custom, credential } : custom;
  }
  return {
    principal: `signing:${signer.keyid}`,
    claims: {
      signature: {
        keyid: signer.keyid,
        verified_at: signer.verified_at,
        ...(signer.agent_url !== undefined ? { agent_url: signer.agent_url } : {}),
      },
    },
    ...(credential !== undefined && { credential }),
  };
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
 * } from '@adcp/sdk/server';
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
   * JSON-RPC protocol methods (e.g. `CancelTask`, `tasks/cancel`) that MUST be
   * signed, matching `capability.protocol_methods_required_for`. Matched
   * against the JSON-RPC `method` only, never against the resolved operation.
   * Like {@link requiredFor}, a valid fallback credential satisfies it.
   */
  protocolMethodsRequiredFor?: readonly string[];
  /**
   * Resolve the AdCP operation a request carries. Defaults to
   * {@link adcpOperationResolver}, which understands MCP `tools/call` and A2A
   * `SendMessage` / `SendStreamingMessage` / `message/send` / `message/stream`.
   *
   * A resolver may return:
   * - an operation name, matched against {@link requiredFor};
   * - `undefined` for a request that carries no AdCP operation (discovery
   *   probes, `tasks/*`) — the request is not subject to {@link requiredFor};
   * - {@link UNRESOLVABLE_OPERATION} for a body that does not resolve to
   *   exactly one operation. The gate rejects it with `request_body_malformed`
   *   before it looks at any signature header or credential, whether or not
   *   the request is signed. An ambiguous body is never treated as "an
   *   operation that is not in `requiredFor`".
   *
   * Omitting this option no longer disables the pre-check: a gate with
   * `requiredFor` set and no resolver used to skip enforcement for every
   * request. The default resolver is used instead. `requiredFor` and the
   * resolver are only as good as each other — a resolver that returns
   * `undefined` for A2A messages (such as {@link mcpToolNameResolver}) leaves
   * `requiredFor` unenforced over A2A.
   */
  resolveOperation?: (req: IncomingMessage & { rawBody?: string }) => ResolvedOperation;
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
  const unsignedCapability = {
    required_for: [...requiredFor],
    ...(options.protocolMethodsRequiredFor
      ? { protocol_methods_required_for: [...options.protocolMethodsRequiredFor] }
      : {}),
  };
  // A gate that lists operations but names no resolver gets the default one:
  // skipping resolution there would leave `requiredFor` unenforced.
  const resolveOperation =
    options.resolveOperation ??
    (requiredFor.size > 0 || unsignedCapability.protocol_methods_required_for ? adcpOperationResolver : undefined);
  const combined: Authenticator = async req => {
    const request = req as IncomingMessage & { rawBody?: string };
    // Pre-check 0 (adcp#7945): the request must resolve to exactly one
    // operation. Runs before the signature-header checks and before any
    // credential is consulted, and whether or not the request is signed.
    const operation = resolveOperation?.(request);
    if (isUnresolvableOperation(operation)) {
      logUnresolvable(request);
      throw signatureAuthError(unresolvableOperationError());
    }
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
    const body = bodyText(request);
    // Payload-driven elevation: webhook receiver credentials in an unsigned
    // request MUST be rejected even when the caller holds a valid bearer, so
    // this runs before the fallback can short-circuit.
    try {
      assertUnsignedWebhookAuthenticationAbsent(body);
    } catch (err) {
      throw asSignatureAuthError(err);
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
    // Valid fallback principal short-circuits everything: this is the
    // documented "bearer bypass on required_for" semantic (per adcp#2586 —
    // a valid credential is sufficient even when signing is required for
    // unauthenticated callers). Return before the pre-check so the
    // control flow below only runs on `fallbackResult === null`.
    if (fallbackResult !== null) return fallbackResult;
    // `requiredFor` pre-check: when the op requires a signature AND no
    // signature was presented AND no valid fallback credential,
    // surface `request_signature_required` regardless of whether the
    // fallback threw (bad bearer) or returned null (no creds).
    try {
      assertUnsignedOperationNotRequired(operation, unsignedCapability);
      assertUnsignedProtocolMethodNotRequired(body, unsignedCapability);
    } catch (err) {
      throw asSignatureAuthError(err);
    }
    // Op not in requiredFor: rethrow the fallback's original error so the
    // 401 carries the fallback's challenge (Bearer for bad-bearer,
    // invalid_token for no-creds).
    if (fallbackThrew) throw fallbackError;
    return null;
  };
  // The resolver reads `req.rawBody`. If no child is tagged (test stubs,
  // agents whose signature path is non-SDK), `serve()` would not buffer the
  // body and the resolver would see nothing, so tag the combined authenticator
  // whenever a resolver is in play.
  if (resolveOperation || authenticatorNeedsRawBody(signatureAuth) || authenticatorNeedsRawBody(fallbackAuth)) {
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
   * Pass `MUTATING_TASKS` (exported from `@adcp/sdk`) to require
   * signatures on every mutating AdCP operation — matches the common
   * declaration in `capabilities.request_signing.required_for`.
   */
  requiredFor?: readonly string[];
  /** See {@link RequireSignatureWhenPresentOptions.protocolMethodsRequiredFor}. */
  protocolMethodsRequiredFor?: readonly string[];
  /** See {@link RequireSignatureWhenPresentOptions.resolveOperation}. */
  resolveOperation?: (req: IncomingMessage & { rawBody?: string }) => ResolvedOperation;
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
 *   adcpOperationResolver,
 *   MUTATING_TASKS,
 * } from '@adcp/sdk/server';
 *
 * serve(createAgent, {
 *   authenticate: requireAuthenticatedOrSigned({
 *     signature: verifySignatureAsAuthenticator({
 *       jwks, replayStore, revocationStore, capability,
 *       resolveOperation: adcpOperationResolver,
 *     }),
 *     fallback: anyOf(verifyApiKey({ keys }), verifyBearer({ jwksUri, issuer, audience })),
 *     requiredFor: [...MUTATING_TASKS],
 *     resolveOperation: adcpOperationResolver,
 *   }),
 * });
 * ```
 */
export function requireAuthenticatedOrSigned(options: RequireAuthenticatedOrSignedOptions): Authenticator {
  return requireSignatureWhenPresent(options.signature, options.fallback, {
    requiredFor: options.requiredFor,
    protocolMethodsRequiredFor: options.protocolMethodsRequiredFor,
    resolveOperation: options.resolveOperation,
  });
}

/**
 * Resolve the AdCP operation a request carries, for MCP and A2A alike
 * (adcp#7945, "Operation resolution over A2A"). Pass it as `resolveOperation`
 * on {@link verifySignatureAsAuthenticator}, {@link requireSignatureWhenPresent},
 * {@link requireAuthenticatedOrSigned}, or `createExpressVerifier` from
 * `@adcp/sdk/signing`; it is the default for the composers.
 *
 * | Request                                                                 | Result                         |
 * |-------------------------------------------------------------------------|--------------------------------|
 * | MCP `tools/call`                                                        | `params.name`                  |
 * | A2A `SendMessage`, `SendStreamingMessage`, `message/send`, `message/stream` | `skill` of the sole DataPart |
 * | any other JSON-RPC method (`tasks/*`, `CancelTask`, `initialize`, …)    | `undefined` (no operation)     |
 * | non-`POST` request                                                      | `undefined`                    |
 * | anything ambiguous                                                      | {@link UNRESOLVABLE_OPERATION} |
 *
 * Ambiguous means: an empty or non-JSON body on a `POST`, a JSON-RPC batch or
 * non-object body, a missing `method`, duplicate object keys (compared after
 * JSON string decoding), a case variant of a recognized member name (`Skill`,
 * `Parts`), zero or more than one DataPart, a FilePart (`raw`, `url`, `file`),
 * a Part with other than one content member or a `kind` that disagrees with
 * it, `data` that is not an object, or a `skill` / `params.name` that is not a
 * non-empty string. Matching is exact and case-sensitive.
 *
 * The consumers reject {@link UNRESOLVABLE_OPERATION} with
 * `request_body_malformed`, never as "an operation that is not in
 * `required_for`". `req.rawBody` must hold the exact bytes the client sent.
 */
export function adcpOperationResolver(
  req: OperationResolutionInput | (IncomingMessage & { rawBody?: string | Buffer })
): ResolvedOperation {
  return resolveRequestOperation(operationInput(req));
}

/**
 * Resolver for MCP agents. Parses the buffered JSON-RPC body on `req.rawBody`
 * and returns `params.name` when `method === 'tools/call'`; returns
 * `undefined` for every other method, a missing body, or malformed JSON.
 *
 * **MCP only, and lenient.** It does not understand A2A: an A2A
 * `SendMessage` resolves to `undefined`, so a `requiredFor` list guarded by
 * this resolver is NOT enforced over A2A. It also treats an ambiguous body as
 * "no operation". Prefer {@link adcpOperationResolver}, which resolves A2A and
 * reports ambiguity as {@link UNRESOLVABLE_OPERATION}. Kept for callers that
 * pin the previous behavior.
 */
export function mcpToolNameResolver(req: { rawBody?: string }): string | undefined {
  const raw = req.rawBody;
  if (!raw) return undefined;
  try {
    const body = JSON.parse(raw) as { method?: unknown; params?: unknown };
    if (body?.method !== 'tools/call') return undefined;
    const params = body.params as { name?: unknown } | undefined;
    return typeof params?.name === 'string' ? params.name : undefined;
  } catch {
    return undefined;
  }
}

function operationInput(req: OperationResolutionInput | IncomingMessage): OperationResolutionInput {
  const candidate = req as OperationResolutionInput;
  return { rawBody: candidate.rawBody, method: candidate.method, url: candidate.url };
}

function bodyText(req: { rawBody?: string | Buffer }): string | undefined {
  const raw = req.rawBody;
  return typeof raw === 'string' ? raw : raw?.toString('utf8');
}

function signatureAuthError(err: RequestSignatureError): AuthError {
  return new AuthError(`Signature rejected (${err.code}).`, { cause: err });
}

function asSignatureAuthError(err: unknown): unknown {
  return err instanceof RequestSignatureError ? signatureAuthError(err) : err;
}

/** Server-side diagnostic; the client only sees the generic `request_body_malformed`. */
function logUnresolvable(req: IncomingMessage & { rawBody?: string }): void {
  const reason = describeUnresolvable(operationInput(req));
  console.error(`[adcp/auth] request body does not resolve to one operation: ${reason ?? 'unknown'}`);
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
  const serveContext = getServeRequestContext(req);
  if (serveContext?.publicUrl) {
    const canonical = new URL(serveContext.publicUrl);
    // `serve()` restricts requests to the exact origin-form mount target.
    // Preserve that path while deriving authority and scheme exclusively from
    // the validated server-owned public URL, never raw proxy headers.
    return new URL(req.url ?? canonical.pathname, canonical.origin).toString();
  }
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
