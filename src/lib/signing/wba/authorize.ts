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
   * Operations (or JSON-RPC methods) an identity-established caller may
   * invoke. Match your anonymous surface; add `sync_principal` only when it
   * implements an explicit `open` policy. Default
   * `['get_adcp_capabilities', 'get_principal']`.
   */
  unboundFor?: readonly string[];
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
    ...(config.onIdentityEstablished !== undefined && { onIdentityEstablished: config.onIdentityEstablished }),
  };
}

/**
 * Verify a WBA request and apply the binding rules (spec R5): an unbound
 * origin may only reach `unboundFor`; a bound origin must still be listed by
 * its operator with the binding role. The originating (first) signer is the
 * AdCP caller; relays are verified but do not acquire its access.
 */
export async function authenticateWebBotAuthRequest(
  request: WebBotAuthRequestLike,
  config: ResolvedWebBotAuthConfig,
  options: { replayStore: ReplayStore; now?: () => number; operation?: string }
): Promise<{ signer: VerifiedSigner; signers: VerifiedWebBotAuthSigner[] }> {
  const signers = await verifyWebBotAuthRequest(request, {
    keys: config.keys,
    replayStore: options.replayStore,
    revocation: config.revocation,
    ...(options.now !== undefined && { now: options.now }),
  });
  const originator = signers[0]!;
  const principal = config.bindings ? await config.bindings.principalFor(originator.origin) : undefined;
  if (principal === undefined) {
    if (options.operation === undefined || !config.unboundFor.has(options.operation)) {
      throw new WebBotAuthAuthorizationError('signer identity is not bound');
    }
    if (config.onIdentityEstablished) {
      try {
        await config.onIdentityEstablished({
          origin: originator.origin,
          keyid: originator.keyid,
          verified_at: originator.verified_at,
          ...(options.operation !== undefined && { operation: options.operation }),
        });
      } catch (error) {
        console.error(`[adcp/web-bot-auth] onIdentityEstablished hook failed: ${(error as Error)?.name ?? 'Error'}`);
      }
    }
  } else {
    try {
      // A binding caches the trust-record evaluation; re-check on the
      // polling-interval schedule. Delisting removes authority but never
      // the historical binding, so the origin cannot downgrade to RFC 9421.
      await config.trustRecords.evaluate(originator.origin, { role: config.bindingRole });
    } catch (error) {
      throw new WebBotAuthAuthorizationError('signer origin is not authorized by its operator', { cause: error });
    }
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

/** JSON-RPC `method` of a request body, for `unboundFor` checks on protocol methods. */
export function jsonRpcMethod(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { method?: unknown }).method === 'string'
      ? (parsed as { method: string }).method
      : undefined;
  } catch {
    return undefined;
  }
}
