/**
 * Principal-level reporting subscriptions (experimental `media_buy.reporting_subscriptions`,
 * AdCP 3.3): the normative period calendar, selector resolution, scope membership and the
 * buyer-computable coverage rule. Pure functions shared by buyer and seller.
 *
 * @packageDocumentation
 */
export {
  assertReportingIanaTimezoneV1,
  createReportingPeriodCalendarV1,
  parseReportingPeriodDurationV1,
} from './calendar';
export type {
  ReportingIsoDurationPartsV1,
  ReportingPeriodAlignmentV1,
  ReportingPeriodCalendarSpecV1,
  ReportingPeriodCalendarV1,
} from './calendar';
export {
  compareReportingIdsByteOrderV1,
  effectiveReportingSubscriptionMatchV1,
  isReportingSubscriptionCandidateV1,
  reportingSubscriptionScopeIncludesV1,
  resolveReportingSubscriptionOfferingsV1,
  resolveReportingSubscriptionPackageV1,
} from './selection';
export type {
  ReportingSubscriptionDestinationMethodV1,
  ReportingSubscriptionMatchV1,
  ReportingSubscriptionOfferingV1,
  ReportingSubscriptionScopeAccountV1,
  ReportingSubscriptionSelectorV1,
  ResolveReportingSubscriptionOfferingsInputV1,
} from './selection';
export {
  owedSubscriptionPeriodsV1,
  groupOwedSubscriptionPeriodsV1,
  expectedSubscriptionPeriods,
  groupExpectedSubscriptionPeriodsV1,
} from './coverage';
export type {
  OwedSubscriptionObligationV1,
  OwedSubscriptionPeriodV1,
  OwedSubscriptionPeriodsInputV1,
  ExpectedSubscriptionObligationV1,
  ExpectedSubscriptionPeriodV1,
  ExpectedSubscriptionPeriodsInputV1,
  ReportingSubscriptionBuyV1,
  ReportingSubscriptionCoverageAccountV1,
  ReportingSubscriptionGrantV1,
  ReportingSubscriptionFlightHistoryEntryV1,
  ReportingSubscriptionVersionRecordV1,
} from './coverage';
export { reportingConfigurationCapabilitiesV1 } from './capabilities';
export type { ReportingConfigurationCapabilitiesInputV1, ReportingConfigurationCapabilitiesV1 } from './capabilities';
