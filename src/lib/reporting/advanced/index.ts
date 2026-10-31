/**
 * Low-level building blocks for principal-level reporting subscriptions (experimental
 * `media_buy.reporting_subscriptions`, AdCP 3.3): the coverage engine and its stores, the coverage
 * function, the period calendar, offering selection, the capability builder, the bridge onto the
 * consumer runtime, and the Reliable Reporting service's subscription hooks.
 *
 * This is the third rung of the reporting-subscription ladder: the managed seller path and the buyer
 * facade sit on top of these pieces. Import from here when you compose the engine yourself, run your
 * own ledger, or compute coverage yourself.
 *
 * Every export is experimental: breaking changes may ship in minor releases of `@adcp/sdk`.
 *
 * Stability policy: https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 *
 * @experimental
 * @packageDocumentation
 */

// The calendar, selection, coverage function and capability builder.
export * from '../subscriptions';

// Coverage onto the consumer runtime's expected periods (buyer).
export {
  reportingSubscriptionVersionRecordsV1,
  toExpectedReportingPeriodsV1,
  subscriptionExpectedReportingPeriodsV1,
  type SubscriptionExpectationTemplateV1,
} from '../subscriptions/expectations';

// The coverage engine (seller) and its stores.
export {
  createInMemoryReportingSubscriptionEngineStoreV1,
  createReportingSubscriptionEngineV1,
  reportingSubscriptionCoverageGrantedV1,
  type CreateReportingSubscriptionEngineOptionsV1,
  type ReportingSubscriptionAccountConfigV1,
  type ReportingSubscriptionAccountFactV1,
  type ReportingSubscriptionCoverageEntryV1,
  type ReportingSubscriptionEngineHooksV1,
  type ReportingSubscriptionEngineStateV1,
  type ReportingSubscriptionEngineStoreV1,
  type ReportingSubscriptionEngineV1,
  type ReportingSubscriptionExclusionReasonV1,
  type ReportingSubscriptionExclusionV1,
  type ReportingSubscriptionFrozenOwedSetV1,
  type ReportingSubscriptionReadbackOverflowV1,
  type ReportingSubscriptionReconcileResultV1,
} from '../subscriptions/engine';
export {
  DEFAULT_REPORTING_SUBSCRIPTION_ENGINE_COLLECTION,
  createReportingSubscriptionEngineStateStoreV1,
  type CreateReportingSubscriptionEngineStateStoreOptionsV1,
} from '../subscriptions/engine-state-store';

// The Reliable Reporting service's subscription planner hooks and its coverage hook.
export {
  assertReportingTaskGrantedV1,
  withReportingSubscriptionCoverageV1,
  type ReliableReportingSubscriptionBindingInputV1,
  type ReliableReportingSubscriptionGenerationContextV1,
  type ReliableReportingSubscriptionPolicyV1,
  type ReliableReportingSubscriptionsOptionsV1,
} from '../service/subscriptions';

// Typed errors the coverage function and the engine throw (also exported from the package root).
export {
  CoverageInputError,
  ReportingSubscriptionEngineError,
  type CoverageInputErrorCode,
  type CoverageInputErrorDetail,
  type ReportingSubscriptionEngineErrorCode,
} from '../../errors';

// The principal identity every reporting-subscription API takes.
export type { PrincipalRef } from '../../server/principal/types';
