/**
 * Selector resolution and scope membership for principal-level reporting subscriptions
 * (`core/reporting-subscription.json`, experimental `media_buy.reporting_subscriptions`).
 *
 * Pure functions shared by the buyer coverage calculation and the seller obligation engine,
 * so both sides resolve the same offering for the same facts.
 */
import type { ReportingDeliveryOffering, ReportingSubscription } from '../../types/core.generated';

/**
 * A seller delivery offering plus the dimension mapping selection needs.
 *
 * The wire offering does not carry its mapped standard dimensions: the seller maps each
 * report definition's native dimensions onto `enums/reporting-dimension.json`. A buyer
 * reads that mapping from the report definition or from the seller's documentation.
 */
export type ReportingSubscriptionOfferingV1 = ReportingDeliveryOffering & {
  /** Standard-vocabulary dimensions this offering's report definition maps onto. */
  dimensions: readonly string[];
  /**
   * Native dimensions that map to no standard value. They count as distinct, so a
   * `package` × device offering never equals a `package` selector under `exact`.
   */
  unmapped_dimensions?: readonly string[];
  /**
   * When the seller began offering it. A resolution that changes because an offering
   * appears or is withdrawn is a cutover at that instant. Absent: always available.
   */
  available_from?: string;
  /** When the seller withdrew it. Absent: still available. */
  withdrawn_at?: string;
};

export type ReportingSubscriptionSelectorV1 = ReportingSubscription['selector'];
export type ReportingSubscriptionMatchV1 = 'exact' | 'finest' | 'all';

/** `pattern` and `transport` of the principal `reporting_destinations` entry a subscription names. */
export interface ReportingSubscriptionDestinationMethodV1 {
  pattern: string;
  transport: string;
}

export interface ResolveReportingSubscriptionOfferingsInputV1 {
  selector: ReportingSubscriptionSelectorV1;
  reconciliation_mode: ReportingSubscription['reconciliation_mode'];
  /**
   * The destination's method when the subscription names one. Absent selects only
   * API-delivered (Core) offerings, which carry no `method`.
   */
  destination_method?: ReportingSubscriptionDestinationMethodV1;
  /** Seller offerings, with their dimension mapping. */
  offerings: readonly ReportingSubscriptionOfferingV1[];
  /** The product's `reporting_capabilities.reporting_delivery_offering_ids`. */
  eligible_offering_ids: readonly string[];
  /**
   * Epoch milliseconds at which to evaluate `available_from`/`withdrawn_at`. Absent:
   * availability is not considered.
   */
  at?: number;
}

/** `match` defaults to `exact` when `dimensions` is present and `finest` when absent. */
export function effectiveReportingSubscriptionMatchV1(
  selector: ReportingSubscriptionSelectorV1
): ReportingSubscriptionMatchV1 {
  return selector.match ?? (selector.dimensions !== undefined ? 'exact' : 'finest');
}

/** UTF-8 byte-order comparison, as the spec's "lowest offering_id in byte order" requires. */
export function compareReportingIdsByteOrderV1(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const UTC_ZONE_NAMES = new Set([
  'UTC',
  'Etc/UTC',
  'Etc/UCT',
  'UCT',
  'Etc/Universal',
  'Universal',
  'Etc/Zulu',
  'Zulu',
  'GMT',
  'Etc/GMT',
  'Etc/GMT+0',
  'Etc/GMT-0',
  'Etc/GMT0',
  'GMT+0',
  'GMT-0',
  'GMT0',
  'Etc/Greenwich',
  'Greenwich',
]);

/**
 * Whether an offering's published schedule can produce periods in a `period_timezone`
 * override. A `utc` schedule only in a UTC alias; a fixed-timezone schedule only in that
 * zone; an account-resolved or account-timezone schedule in any zone; a configurable
 * billing cycle has no anchor a subscription can supply and so is never resolvable.
 */
function canProduceTimezone(offering: ReportingDeliveryOffering, timezone: string | undefined): boolean {
  const schedule = offering.schedule;
  if (schedule.alignment === 'billing_cycle' && schedule.period_anchor_policy !== 'fixed') return false;
  if (timezone === undefined) return true;
  switch (schedule.alignment) {
    case 'utc':
      return UTC_ZONE_NAMES.has(timezone);
    case 'account_timezone':
      return true;
    case 'source_timezone':
      return schedule.period_timezone_policy !== 'fixed' || schedule.period_timezone === timezone;
    case 'billing_cycle':
      return schedule.period_timezone === timezone;
    default:
      return false;
  }
}

/** Candidate filter from `x-adcp-validation.selection`, before `match` applies. */
export function isReportingSubscriptionCandidateV1(
  offering: ReportingSubscriptionOfferingV1,
  input: Omit<ResolveReportingSubscriptionOfferingsInputV1, 'offerings'>
): boolean {
  const { selector } = input;
  if (!input.eligible_offering_ids.includes(offering.offering_id)) return false;
  if (offering.feed_purpose !== selector.feed_purpose) return false;
  if (offering.schedule.period_duration !== selector.period_duration) return false;
  if (offering.reconciliation_mode !== input.reconciliation_mode) return false;
  if (!offering.supported_finality.includes(selector.required_finality)) return false;
  if (selector.alignment !== undefined && offering.schedule.alignment !== selector.alignment) return false;
  if (input.destination_method === undefined) {
    if (offering.method !== undefined) return false;
  } else {
    // The generated wire type drops this object's properties; the schema defines both.
    const method = offering.method as { pattern?: unknown; transport?: unknown } | undefined;
    if (
      method === undefined ||
      method.pattern !== input.destination_method.pattern ||
      method.transport !== input.destination_method.transport
    ) {
      return false;
    }
  }
  if (!canProduceTimezone(offering, selector.period_timezone)) return false;
  if (input.at !== undefined) {
    if (offering.available_from !== undefined && Date.parse(offering.available_from) > input.at) return false;
    if (offering.withdrawn_at !== undefined && Date.parse(offering.withdrawn_at) <= input.at) return false;
  }
  return true;
}

/**
 * Resolve a selector against one product's eligible offerings. Returns the resolved
 * offering IDs in byte order: at most one for `exact` and `finest`, every match for `all`,
 * none when nothing matches (the seller then records `offering_unsupported`).
 */
export function resolveReportingSubscriptionOfferingsV1(input: ResolveReportingSubscriptionOfferingsInputV1): string[] {
  const match = effectiveReportingSubscriptionMatchV1(input.selector);
  const wanted = input.selector.dimensions;
  const candidates = input.offerings
    .filter(offering => isReportingSubscriptionCandidateV1(offering, input))
    .sort((left, right) => compareReportingIdsByteOrderV1(left.offering_id, right.offering_id));
  const includesWanted = (offering: ReportingSubscriptionOfferingV1) =>
    wanted === undefined || wanted.every(dimension => offering.dimensions.includes(dimension));
  if (match === 'exact') {
    const equal = candidates.filter(offering => {
      if (wanted === undefined) return true;
      const own = new Set(offering.dimensions);
      return (
        (offering.unmapped_dimensions?.length ?? 0) === 0 &&
        own.size === new Set(wanted).size &&
        wanted.every(dimension => own.has(dimension))
      );
    });
    return equal.length > 0 ? [equal[0]!.offering_id] : [];
  }
  const including = candidates.filter(includesWanted);
  if (match === 'all') return including.map(offering => offering.offering_id);
  let best: ReportingSubscriptionOfferingV1 | undefined;
  for (const offering of including) {
    if (best === undefined || new Set(offering.dimensions).size > new Set(best.dimensions).size) best = offering;
  }
  return best ? [best.offering_id] : [];
}

export interface ReportingSubscriptionScopeAccountV1 {
  account_id: string;
  /** The account's `operator` domain, needed when the scope names `operator_domains`. */
  operator?: string;
}

/**
 * Whether a subscription's scope selects an account: `account_ids` naming it, or
 * `all_authorized_accounts` with the account outside `exclude_account_ids` and, when
 * `operator_domains` is present, its operator listed. Authorization is checked separately.
 */
export function reportingSubscriptionScopeIncludesV1(
  subscription: Pick<ReportingSubscription, 'scope' | 'exclude_account_ids' | 'operator_domains'>,
  account: ReportingSubscriptionScopeAccountV1
): boolean {
  const scope = subscription.scope as { all_authorized_accounts?: true; account_ids?: string[] };
  let selected: boolean;
  if (scope.account_ids !== undefined) selected = scope.account_ids.includes(account.account_id);
  else
    selected =
      scope.all_authorized_accounts === true && !subscription.exclude_account_ids?.includes(account.account_id);
  if (!selected) return false;
  if (subscription.operator_domains !== undefined) {
    return account.operator !== undefined && subscription.operator_domains.includes(account.operator);
  }
  return true;
}
