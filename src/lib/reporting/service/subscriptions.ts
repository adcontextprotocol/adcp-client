/**
 * The Reliable Reporting service's principal-level reporting-subscription options (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3) and the `get_reporting_status` coverage hook.
 *
 * Internal to the service: these are published from `@adcp/sdk/reporting/advanced`, not from
 * `@adcp/sdk/reporting/service`.
 */
import type { Account } from '../../server/decisioning/account';
import type { RequestContext } from '../../server/decisioning/context';
import type { ReliableReportingPlatform } from '../../server/decisioning/specialisms/reporting';
import { AdcpError } from '../../server/decisioning/async-outcome';
import type { PrincipalLifecycleRuntimeSubscriptions, PrincipalRef } from '../../server/principal/types';
import type { PrincipalLifecycleRuntime } from '../../server/principal/runtime';
import {
  reportingSubscriptionCoverageForReleaseV1,
  reportingSubscriptionReleaseFieldsV1,
} from '../../server/reporting-subscription-release';
import type { ReportingDeliveryOffering } from '../../types/tools.generated';
import { isAdcpVersionAtLeast } from '../../utils/adcp-version-config';
import type { ReportingLedgerConfigurationV1 } from '../ledger';
import type { ReportingSourceOfferingV1 } from '../source';
import type { ReportingSubscriptionEngineV1, ReportingSubscriptionFrozenOwedSetV1 } from '../subscriptions/engine';

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface ReliableReportingSubscriptionsOptionsV1<TCtxMeta = Record<string, unknown>> {
  engine: Pick<ReportingSubscriptionEngineV1, 'subscriptionCoverage' | 'settings' | 'frozenOwedSets'> &
    Partial<Pick<ReportingSubscriptionEngineV1, 'isAuthorized'>>;
  /**
   * The principal runtime. A composition that delivers managed subscription obligations (the
   * production service in `@adcp/reporting-storage/service`) resolves each subscription's
   * destination through it.
   */
  principal?: Pick<PrincipalLifecycleRuntimeSubscriptions, 'listReportingSubscriptions'> &
    Pick<PrincipalLifecycleRuntime, 'resolveReportingDestination'>;
  /**
   * The same authenticated mapping the principal runtime uses. Never derive it from request content.
   * It also scopes `get_reporting_status`, `get_media_buy_delivery` and `sync_reporting_status`: a
   * caller sees account configurations plus only its own subscription generations.
   */
  resolvePrincipal(context: RequestContext<Account<TCtxMeta>>): PrincipalRef | Promise<PrincipalRef>;
  /**
   * Every principal whose subscription obligations `runCycle` writes into the ledger, for example
   * `engine.listSubscriptionPrincipals(tenantId)` across your tenants. Each cycle plans the engine's frozen
   * owed set of each of them (on the cycle's account) before it plans account configurations.
   */
  listSubscriptionPrincipals(): readonly PrincipalRef[] | Promise<readonly PrincipalRef[]>;
  /**
   * The account `resolveSource`, `resolveCurrency` and `resolveCoverage` receive for a subscription
   * generation. Defaults to `{ id: accountId, ctx_metadata: {} }`.
   */
  resolveSubscriptionAccount?(
    accountId: string
  ): Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'> | Promise<Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>>;
  /**
   * Seller policy for one subscription generation: the facts a host also supplies when it maps a
   * `sync_accounts` configuration onto `installConfiguration`. The service takes identity, feed
   * purpose, required finality, report definition and schedule from the subscription version and the
   * resolved offering, and the source route, currency and authorized coverage from
   * `resolveSource`, `resolveCurrency` and `resolveCoverage`, as for an account configuration.
   */
  resolveSubscriptionConfiguration(
    input: ReliableReportingSubscriptionGenerationContextV1<TCtxMeta>
  ): ReliableReportingSubscriptionPolicyV1 | Promise<ReliableReportingSubscriptionPolicyV1>;
  /**
   * Called for each subscription whose obligations a cycle could not write. One subscription never
   * stops the others or the account's own configurations. Without it, `runCycle` rejects with an
   * `AggregateError` of these failures after the rest of the cycle has run.
   */
  onPlanningError?(
    error: unknown,
    context: { principal: PrincipalRef; accountId?: string; subscriptionId?: string }
  ): void | Promise<void>;
  /**
   * Binds a managed subscription generation to its destination before its first obligation is
   * written. Supplied by a composition that owns managed delivery, such as
   * `createPostgresReliableReportingProductionService`; a subscription that resolves a managed
   * offering without it fails to plan. A rejection writes nothing, and the next cycle tries again.
   */
  bindManagedGeneration?(input: ReliableReportingSubscriptionBindingInputV1): Promise<void>;
  /** Standard dimensions the seller maps its report definitions onto (`subscriptions.dimensions`). */
  dimensions?: readonly string[];
  /** Keep serving `sync_accounts` `reporting_delivery_configs`. Defaults to true. */
  accountConfigurations?: boolean;
}

/**
 * One managed subscription generation to bind to its destination.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReliableReportingSubscriptionBindingInputV1 {
  /** The owning principal. */
  principal: PrincipalRef;
  /** The installed generation, with its `subscription` block. */
  configuration: ReportingLedgerConfigurationV1;
  /** The subscription version's configuration, naming `destination.destination_id` and `path_template`. */
  subscription: ReportingSubscriptionFrozenOwedSetV1['versions'][number]['configuration'];
  /** The destination's pattern and transport, frozen when the version was accepted. */
  destinationMethod?: NonNullable<ReportingSubscriptionFrozenOwedSetV1['versions'][number]['destination_method']>;
  /** The resolved managed offering. */
  offering: ReportingDeliveryOffering;
  /**
   * Where this account's data goes (adcp#8619): the `account_ids` override naming it, else the
   * `operator_domains` override naming its operator, else `subscription.destination`.
   */
  destination?: { destination_id: string; path_template?: string };
}

/**
 * What {@link ReliableReportingSubscriptionsOptionsV1.resolveSubscriptionConfiguration} is asked about.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReliableReportingSubscriptionGenerationContextV1<TCtxMeta = Record<string, unknown>> {
  principal: PrincipalRef;
  account: Pick<Account<TCtxMeta>, 'id' | 'ctx_metadata'>;
  /** The subscription version's configuration. */
  subscription: ReportingSubscriptionFrozenOwedSetV1['versions'][number]['configuration'];
  offering: ReportingDeliveryOffering;
  sourceOffering: ReportingSourceOfferingV1;
}

/**
 * Seller policy for one subscription generation.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReliableReportingSubscriptionPolicyV1 {
  requestedMetrics: string[];
  requestedDimensions: string[];
  sourceSettings: Omit<ReportingLedgerConfigurationV1['sourceSettings'], 'currency'>;
  finalityPolicy?: ReportingLedgerConfigurationV1['finalityPolicy'];
  canonicalization?: ReportingLedgerConfigurationV1['canonicalization'];
}

/**
 * Add `subscription_coverage[]` to a completed summary or periods response. The revision
 * view never carries it, and an account the caller cannot read has no entries. Exported for
 * compositions that serve `get_reporting_status` from their own handler, such as the production
 * service in `@adcp/reporting-storage/service`.
 *
 * @experimental Storage-facing building block: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function withReportingSubscriptionCoverageV1<TCtxMeta>(
  response: Awaited<ReturnType<ReliableReportingPlatform<TCtxMeta>['getReportingStatus']>>,
  context: RequestContext<Account<TCtxMeta>>,
  subscriptions: ReliableReportingSubscriptionsOptionsV1<TCtxMeta>
) {
  const body = response as unknown as Record<string, unknown>;
  if (body.status !== 'completed' || (body.view !== 'summary' && body.view !== 'periods')) return response;
  // subscription_coverage is a 3.3 field; earlier response shapes are closed.
  const served = (context as { servedAdcpVersion?: string }).servedAdcpVersion;
  if (served !== undefined && !isAdcpVersionAtLeast(served, '3.3.0-beta.1')) return response;
  const accountId = (context.account as { id?: unknown } | undefined)?.id;
  if (typeof accountId !== 'string') return response;
  const principal = await subscriptions.resolvePrincipal(context);
  // Fields settled after 3.3.0-beta.1 only when the served bundle defines them.
  const fields = reportingSubscriptionReleaseFieldsV1(served);
  const coverage = (await subscriptions.engine.subscriptionCoverage(principal, accountId)).map(entry =>
    reportingSubscriptionCoverageForReleaseV1(entry as unknown as Record<string, unknown>, fields)
  );
  if (coverage.length === 0) return response;
  return { ...body, subscription_coverage: coverage } as unknown as typeof response;
}

/**
 * Partial grants (`core/reporting-subscription.json` `x-adcp-validation.coverage`, adcontextprotocol/adcp#8619):
 * coverage depends only on `get_reporting_status`, so a grant without `sync_reporting_receipts` or
 * `sync_reporting_status` keeps the account covered, and the seller refuses the missing task for that
 * account with `SCOPE_INSUFFICIENT`, not as an unknown identifier. Call it once the account is resolved:
 * an `authorization` whose `allowed_tasks` leaves out `task` is refused; an absent `authorization`, or one
 * that restricts no task, passes. A billing obligation the buyer can't receipt stays receipt-pending,
 * attributed to the buyer.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function assertReportingTaskGrantedV1(
  context: unknown,
  task: 'sync_reporting_receipts' | 'sync_reporting_status'
): void {
  const account = (context as { account?: { id?: unknown; authorization?: { allowed_tasks?: unknown } } } | undefined)
    ?.account;
  const allowed = account?.authorization?.allowed_tasks;
  if (!Array.isArray(allowed) || allowed.includes(task)) return;
  throw new AdcpError('SCOPE_INSUFFICIENT', {
    message: `The caller's grant on account ${JSON.stringify(account?.id)} does not include ${task}`,
    field: 'account',
  });
}
