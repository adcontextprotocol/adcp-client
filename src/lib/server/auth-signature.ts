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
import { AuthError, type AuthPrincipal, type Authenticator, tagAuthenticatorNeedsRawBody } from './auth';

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

const SAFE_KEYID = /^[A-Za-z0-9._-]{1,256}$/;

function hasSignatureHeader(req: IncomingMessage): boolean {
  const v = req.headers['signature-input'];
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
