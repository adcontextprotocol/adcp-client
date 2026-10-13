/**
 * Experimental (AdCP 3.3) transport-level Web Bot Auth authentication and
 * binding authorization, shared by `createExpressVerifier({ webBotAuth })` and
 * `createAdcpServer({ signedRequests: { webBotAuth } })`.
 */
import type { JwksResolver } from '../jwks';
import type { ReplayStore } from '../replay';
import type { VerifiedSigner } from '../types';
import type { OriginBindingResolver } from '../trust/bindings';
import { TrustRecordEvaluator } from '../trust/record';
import { parseStrictJson } from '../agent-resolver/strict-json';
import { MUTATING_TASKS } from '../../utils/idempotency';
import { WebBotAuthAuthorizationError } from './errors';
import { tryWebBotAuthOrigin } from './origin';
import { OriginRevocationChecker } from './revocation';
import {
  verifyWebBotAuthRequest,
  type VerifiedWebBotAuthSigner,
  type WebBotAuthRequestLike,
  type WebBotAuthRevocationCheck,
} from './verifier';

/** A verified origin the seller has not bound: identity without authority. */
export interface EstablishedWebBotAuthIdentity {
  origin: string;
  keyid: string;
  verified_at: number;
  /** AdCP operation or JSON-RPC method the request carried. */
  operation?: string;
}

export interface WebBotAuthVerifierConfig {
  /**
   * Origin-aware key resolver, usually a {@link WebBotAuthKeyDirectoryResolver}
   * (pass the RFC 9421 resolver as its `legacy` option to serve both
   * profiles on one endpoint).
   */
  keys: JwksResolver;
  /** Origin revocation check. Defaults to an {@link OriginRevocationChecker} over `keys`. */
  revocation?: WebBotAuthRevocationCheck;
  /**
   * Seller-owned origin → principal bindings. Without it every verified
   * origin is identity-established (anonymous-equivalent).
   */
  bindings?: OriginBindingResolver;
  /**
   * Re-evaluates the operator's record for a bound origin on every request
   * (bounded by its polling-interval cache). Defaults to a fresh
   * {@link TrustRecordEvaluator}. Never consulted on the signature path.
   */
  trustRecords?: TrustRecordEvaluator;
  /** Role the operator record must list for a bound origin. Default `adcp:buying`. */
  bindingRole?: string;
  /**
   * Operations (or JSON-RPC methods) on which an identity-established
   * (verified, unbound) origin is attached as an authenticated caller with
   * no principal and no credential, e.g. `get_principal` so it can read its
   * relationship. Add `sync_principal` only when it implements an explicit
   * `open` policy. Default `['get_adcp_capabilities', 'get_principal']`.
   */
  unboundFor?: readonly string[];
  /**
   * What an unbound origin gets on other operations. `'anonymous'` (default,
   * spec R5 rule 1: "it gets what an anonymous caller gets"): the request
   * proceeds exactly as an unsigned one, with nothing attached, so the
   * server's own authentication and anonymous policy apply. `'reject'`:
   * answer `PERMISSION_DENIED` (adcp-client-python's behavior).
   */
  unbound?: 'anonymous' | 'reject';
  /**
   * Called for a verified, unbound origin, e.g. to queue it for one-click
   * approval. Confers nothing; failures are logged and ignored. Rate-limit
   * submissions per operator domain.
   */
  onIdentityEstablished?: (identity: EstablishedWebBotAuthIdentity) => void | Promise<void>;
}

export interface ResolvedWebBotAuthConfig {
  keys: JwksResolver;
  revocation: WebBotAuthRevocationCheck;
  bindings?: OriginBindingResolver;
  trustRecords: TrustRecordEvaluator;
  bindingRole: string;
  unboundFor: ReadonlySet<string>;
  unbound: 'anonymous' | 'reject';
  /** @internal Hook dedupe state: origin → last report time, or in flight. */
  reported: Map<string, number | 'pending'>;
  onIdentityEstablished?: (identity: EstablishedWebBotAuthIdentity) => void | Promise<void>;
}

/** Instantiate defaults once at wire-up so state is shared across requests. */
export function resolveWebBotAuthConfig(config: WebBotAuthVerifierConfig): ResolvedWebBotAuthConfig {
  if (!config?.keys?.resolveWithMetadata) {
    throw new TypeError('webBotAuth.keys must be an origin-aware resolver (WebBotAuthKeyDirectoryResolver)');
  }
  return {
    keys: config.keys,
    revocation: config.revocation ?? new OriginRevocationChecker(config.keys),
    ...(config.bindings !== undefined && { bindings: config.bindings }),
    trustRecords: config.trustRecords ?? new TrustRecordEvaluator(),
    bindingRole: config.bindingRole ?? 'adcp:buying',
    unboundFor: new Set(config.unboundFor ?? ['get_adcp_capabilities', 'get_principal']),
    unbound: config.unbound ?? 'anonymous',
    reported: new Map(),
    ...(config.onIdentityEstablished !== undefined && { onIdentityEstablished: config.onIdentityEstablished }),
  };
}

/**
 * Operations whose acceptance commits spend or state: a bound origin needs
 * current revocation status for them (spec R3: fail closed for
 * spend-committing operations). Unbound origins proceed as anonymous callers
 * and never depend on revocation status beyond a key the list revokes.
 */
function requiresCurrentRevocationStatus(operation: string | undefined): boolean {
  return operation !== undefined && MUTATING_TASKS.has(operation);
}

/** Report each unbound origin at most once a minute, one call in flight. */
const IDENTITY_HOOK_DEDUPE_SECONDS = 60;

/**
 * Verify a WBA request and apply the binding rules (spec R5). The originating
 * (first) signer is the AdCP caller; relays are verified but do not acquire
 * its access. Returns `signer: undefined` when an unbound origin proceeds as
 * an anonymous caller.
 */
export async function authenticateWebBotAuthRequest(
  request: WebBotAuthRequestLike,
  config: ResolvedWebBotAuthConfig,
  options: { replayStore: ReplayStore; now?: () => number; operation?: string }
): Promise<{ signer: VerifiedSigner | undefined; signers: VerifiedWebBotAuthSigner[] }> {
  const signers = await verifyWebBotAuthRequest(request, {
    keys: config.keys,
    replayStore: options.replayStore,
    revocation: config.revocation,
    // Decided below, once the binding is known.
    requireRevocationStatus: false,
    ...(options.now !== undefined && { now: options.now }),
  });
  const originator = signers[0]!;
  const principal = config.bindings ? await config.bindings.principalFor(originator.origin) : undefined;
  if (principal === undefined) {
    if (config.onIdentityEstablished) reportEstablished(config, originator, options.operation);
    if (options.operation === undefined || !config.unboundFor.has(options.operation)) {
      if (config.unbound === 'reject') throw new WebBotAuthAuthorizationError('signer identity is not bound');
      return { signer: undefined, signers };
    }
  } else {
    if (
      requiresCurrentRevocationStatus(options.operation) &&
      signers.some(signer => signer.revocation_status !== 'current')
    ) {
      throw new WebBotAuthAuthorizationError('origin revocation status unavailable');
    }
    try {
      // A binding caches the trust-record evaluation; re-check on the
      // polling-interval schedule. Delisting removes authority but never
      // the historical binding, so the origin cannot downgrade to RFC 9421.
      await config.trustRecords.evaluate(originator.origin, { role: config.bindingRole });
    } catch (error) {
      throw new WebBotAuthAuthorizationError('signer origin is not authorized by its operator', { cause: error });
    }
    // A bound origin's revocation history is never evicted.
    (config.revocation as { pin?: (origin: string) => void }).pin?.(originator.origin);
  }
  return {
    signer: {
      keyid: originator.keyid,
      agent_url: originator.origin,
      verified_at: originator.verified_at,
      profile: 'web-bot-auth',
      ...(principal !== undefined && { principal_id: principal }),
    },
    signers,
  };
}

function reportEstablished(
  config: ResolvedWebBotAuthConfig,
  originator: VerifiedWebBotAuthSigner,
  operation: string | undefined
): void {
  const now = originator.verified_at;
  const last = config.reported.get(originator.origin);
  if (last !== undefined && (last === 'pending' || now - last < IDENTITY_HOOK_DEDUPE_SECONDS)) return;
  config.reported.delete(originator.origin);
  config.reported.set(originator.origin, 'pending');
  while (config.reported.size > 1024) config.reported.delete(config.reported.keys().next().value as string);
  const hook = config.onIdentityEstablished!;
  // Fire and forget: the hook confers nothing and must not delay or fail the
  // request. One call in flight per origin, then at most one a minute.
  void Promise.resolve()
    .then(() =>
      hook({
        origin: originator.origin,
        keyid: originator.keyid,
        verified_at: originator.verified_at,
        ...(operation !== undefined && { operation }),
      })
    )
    .catch(error =>
      console.error(`[adcp/web-bot-auth] onIdentityEstablished hook failed: ${(error as Error)?.name ?? 'Error'}`)
    )
    .finally(() => config.reported.set(originator.origin, now));
}

/**
 * No downgrade (spec R4): once an origin is bound, RFC 9421 signatures for
 * any agent URL at that origin are refused.
 */
export async function assertNoRfc9421Downgrade(
  agentUrl: string | undefined,
  config: Pick<ResolvedWebBotAuthConfig, 'bindings'>
): Promise<void> {
  if (agentUrl === undefined || !config.bindings) return;
  const origin = tryWebBotAuthOrigin(agentUrl);
  if (origin !== undefined && (await config.bindings.principalFor(origin)) !== undefined) {
    throw new WebBotAuthAuthorizationError('bound origin requires the Web Bot Auth profile');
  }
}

/**
 * JSON-RPC `method` of a POST JSON-RPC 2.0 envelope, for `unboundFor` checks
 * on protocol methods. Anything else (other HTTP methods, non-envelopes,
 * non-strict JSON) has no method, so a URL-routed request cannot claim one.
 */
export function jsonRpcMethod(httpMethod: string | undefined, body: string | undefined): string | undefined {
  if (!body || (httpMethod ?? '').toUpperCase() !== 'POST') return undefined;
  try {
    const parsed = parseStrictJson(body) as Record<string, unknown> | null;
    return parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.jsonrpc === '2.0' &&
      typeof parsed.method === 'string'
      ? parsed.method
      : undefined;
  } catch {
    return undefined;
  }
}
