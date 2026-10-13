/**
 * Experimental (AdCP 3.3) demand-side grant gate (spec R6, DR-0025): runs
 * after commercial identity is established and before any account side
 * effect. Wire it on `platform.accounts.trustGrants`.
 */
import { grantAbsentError, requireGrant, type TrustGrantEvaluator } from '../../signing/trust/grants';
import { AdcpError } from './async-outcome';
import type { Account } from './account';
import { isVerifiedHttpSig, type BuyerAgent, type AdcpCredential } from './buyer-agent';

/** Acts-for claim the gate evaluates. Brand and operator come from seller-owned state or the declaration. */
export interface TrustGrantClaim {
  brandDomain: string;
  accountOperator: string;
  brandId?: string;
  countries?: readonly string[];
  /** Default `adcp:media_buying`. Other domains must name their scope explicitly. */
  scope?: string;
}

export interface TrustGrantGateOptions {
  evaluator: TrustGrantEvaluator;
  /**
   * Claim for an existing account on an account-scoped call, from
   * seller-owned state (never request fields, so a caller cannot omit the
   * brand to skip the check). Defaults to the account's `brand` and
   * `operator`. Return `undefined` for an account the gate does not cover
   * (no brand-scoped acts-for claim).
   */
  claimForAccount?: (
    account: Account<any>,
    agent: BuyerAgent,
    operation: string
  ) => TrustGrantClaim | undefined | Promise<TrustGrantClaim | undefined>;
}

/** Operations a default `adcp:media_buying` claim covers (R6: buys and their provisioning). */
export const MEDIA_BUYING_GRANT_OPERATIONS: ReadonlySet<string> = new Set([
  'sync_accounts',
  'get_products',
  'list_products',
  'request_proposals',
  'refine_proposals',
  'decline_proposals',
  'buy_products',
  'accept_proposal',
  'create_media_buy',
  'update_media_buy',
  'control_media_buy',
  'get_media_buys',
  'get_media_buy_delivery',
  'get_reporting_status',
  'sync_reporting_receipts',
  'provide_performance_feedback',
  'sync_creatives',
  'list_creatives',
  'list_creative_formats',
  'log_event',
  'sync_audiences',
  'sync_catalogs',
  'sync_event_sources',
  'sync_reporting_status',
]);

/**
 * Task lifecycle reads scoped by an account. The operation that created the
 * task was already gated; polling it does not assert a new acts-for claim.
 */
const TASK_LIFECYCLE_OPERATIONS: ReadonlySet<string> = new Set(['get_task_status', 'list_tasks']);

export interface TrustGrantGate {
  /** Check one natural-key `sync_accounts` declaration before any upsert. */
  requireDeclaration(declaration: unknown, ctx: TrustGrantContext): Promise<void>;
  /** Check an existing account before an account-scoped call (fresh before spend). */
  requireAccount(account: Account<any>, ctx: TrustGrantContext & { operation: string }): Promise<void>;
}

export interface TrustGrantContext {
  agent?: BuyerAgent;
  authInfo?: { credential?: AdcpCredential; extra?: Record<string, unknown> };
}

/**
 * Experimental (AdCP 3.3). Build the grant gate. A request with no
 * established buyer agent gets a bare `PERMISSION_DENIED` (no `details`,
 * under the cross-tenant oracle clamp); an established agent without a
 * covering grant gets `{ scope: "agent", reason: "grant_absent" }`. The
 * gate never creates an account or changes an account's status.
 */
export function createTrustGrantGate(options: TrustGrantGateOptions): TrustGrantGate {
  if (!options?.evaluator) throw new TypeError('createTrustGrantGate requires an evaluator');
  const evaluate = async (claim: TrustGrantClaim, ctx: TrustGrantContext) => {
    const agent = ctx.agent;
    if (agent === undefined) throw unestablished();
    // Profile and operator-record fields count only on a verifier-branded
    // credential; a custom authenticator cannot steer grant evaluation.
    const raw = ctx.authInfo?.credential;
    const credential = raw?.kind === 'http_sig' && isVerifiedHttpSig(raw) ? raw : undefined;
    const webBotAuth = credential?.profile === 'web-bot-auth';
    // An RFC 9421 signer's operator is the host of the brand.json record its
    // verified discovery selected, when the verifier recorded one.
    const signature = ctx.authInfo?.extra?.signature as { operator_record_url?: unknown } | undefined;
    const operatorRecordUrl =
      !webBotAuth && credential !== undefined && typeof signature?.operator_record_url === 'string'
        ? signature.operator_record_url
        : undefined;
    let signerOperatorDomain: string | undefined;
    try {
      signerOperatorDomain = operatorRecordUrl ? new URL(operatorRecordUrl).hostname : undefined;
    } catch {
      signerOperatorDomain = undefined;
    }
    return options.evaluator.check({
      agentOrigin: webBotAuth ? credential!.agent_url : agent.agent_url,
      brandDomain: claim.brandDomain,
      accountOperator: claim.accountOperator,
      ...(claim.brandId !== undefined && { brandId: claim.brandId }),
      ...(claim.countries !== undefined && { countries: claim.countries }),
      ...(claim.scope !== undefined && { scope: claim.scope }),
      // Trusted transport metadata only; never a declaration field. Bearer
      // and OAuth callers take the RFC 9421 (pre-3.3) authority path.
      signingProfile: webBotAuth ? 'web-bot-auth' : 'adcp/request-signing/v1',
      ...(signerOperatorDomain !== undefined && { signerOperatorDomain }),
    });
  };
  const check = async (claim: TrustGrantClaim, ctx: TrustGrantContext): Promise<void> => {
    requireGrant(await evaluate(claim, ctx));
  };
  return {
    async requireDeclaration(declaration, ctx) {
      const entry = (declaration ?? {}) as {
        brand?: { domain?: unknown; brand_id?: unknown; countries?: unknown };
        operator?: unknown;
      };
      if (typeof entry.brand?.domain !== 'string' || typeof entry.operator !== 'string') {
        if (ctx.agent === undefined) throw unestablished();
        throw grantAbsentError();
      }
      await check(
        {
          brandDomain: entry.brand.domain,
          accountOperator: entry.operator,
          ...(typeof entry.brand.brand_id === 'string' && { brandId: entry.brand.brand_id }),
          ...(Array.isArray(entry.brand.countries) && { countries: entry.brand.countries as string[] }),
        },
        ctx
      );
    },
    async requireAccount(account, ctx) {
      if (TASK_LIFECYCLE_OPERATIONS.has(ctx.operation)) return;
      if (ctx.agent === undefined) throw unestablished();
      let claim: TrustGrantClaim | undefined;
      if (options.claimForAccount) {
        claim = await options.claimForAccount(account, ctx.agent, ctx.operation);
        // Only an explicit extractor may exempt an account.
        if (claim === undefined) return;
      } else {
        claim = defaultClaim(account);
        // Without a brand and operator there is no claim to authorize: fail closed.
        if (claim === undefined) throw grantAbsentError();
      }
      if (
        !MEDIA_BUYING_GRANT_OPERATIONS.has(ctx.operation) &&
        (claim.scope ?? 'adcp:media_buying') === 'adcp:media_buying'
      ) {
        // A media-buying grant cannot authorize another domain merely because
        // both calls name an account. Implicit (same-domain) authority still
        // applies; anything else needs an explicit scope from claimForAccount.
        const result = await evaluate(claim, ctx);
        if (result.authorized && result.basis === 'implicit') return;
        if (!result.authorized && result.reason?.endsWith('_unavailable')) requireGrant(result);
        throw new AdcpError('PERMISSION_DENIED', {
          message: 'Operation requires an explicit grant scope',
          recovery: 'correctable',
          details: { scope: 'agent', reason: 'grant_absent' },
        });
      }
      await check(claim, ctx);
    },
  };
}

function defaultClaim(account: Account<any>): TrustGrantClaim | undefined {
  if (typeof account.brand?.domain !== 'string' || typeof account.operator !== 'string') return undefined;
  return {
    brandDomain: account.brand.domain,
    accountOperator: account.operator,
    ...(account.brand.brand_id !== undefined && { brandId: account.brand.brand_id }),
    ...(account.brand.countries !== undefined && { countries: account.brand.countries }),
  };
}

function unestablished(): AdcpError {
  return new AdcpError('PERMISSION_DENIED', { message: 'Buyer agent is not authorized', recovery: 'correctable' });
}
