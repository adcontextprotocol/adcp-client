/**
 * Buyer-side `content_mismatch` detection (AdCP 3.2.0-rc.3).
 *
 * `content_mismatch` says: the buyer consumed the exact revision the seller
 * requires, and its content contradicts a fact the accepted configuration
 * generation **already fixed**. Every code is decidable from the obligation,
 * the pinned report definition, and the revision itself — with no reference to
 * either party's own measurement.
 *
 * Two boundaries govern everything below, and both are easy to breach in the
 * permissive direction:
 *
 * 1. **Never a measurement dispute.** A disagreement about *how many
 *    impressions the seller counted* belongs to `measurement_terms` and
 *    `makegood_policy`. Nothing here compares a delivered number against a
 *    buyer-side expectation, and nothing here should be extended to.
 * 2. **Never fire on evidence you do not have.** A false `content_mismatch` is
 *    expensive: per `consumer_status_projection` it forces the caller's view to
 *    `action_required`, and the seller MUST NOT return the period to healthy
 *    while that statement is the current leaf. So four of the six codes are
 *    **row-level** predicates that the obligation and revision *metadata*
 *    cannot decide, and they stay silent unless the caller supplies what it
 *    actually read. Silence is the safe default; a confident wrong answer is
 *    not.
 *
 * Which codes need row evidence, and why the metadata alone cannot substitute:
 *
 * | code | spec predicate | decidable from metadata? |
 * | --- | --- | --- |
 * | `scope_media_buy_missing` | a frozen buy is absent from the revision **and not represented by an explicit zero row** | **No.** `reporting-revision.json` defines `media_buy_ids` as the denominator *"inherited from the obligation, including buys with zero rows"*, so comparing the two sets is a tautology against a conformant seller. |
 * | `coverage_short` | revision covers fewer packages than the obligation's frozen `coverage.covered_package_ids` | **Yes.** |
 * | `metric_missing` | a metric named in the pinned definition's `metrics[].name` is absent | **No.** `control_totals` are profile-defined aggregates scoped to `coverage.covered_package_ids`, a different and usually smaller set than the definition's metrics. |
 * | `schema_nonconformant` | rows do not validate against the pinned `schema_uri`/`schema_sha256` | **No.** Requires actually validating rows. |
 * | `currency_mismatch` | a value's unit disagrees with the unit the pinned definition fixed | **Yes.** |
 * | `period_mismatch` | a row time dimension carries values outside the half-open period | **No.** The revision envelope is pinned stable by `slice_identity`; the violation lives in row values. |
 */

import type { ReportingControlTotal } from '../types';

/** Closed set of reasons a consumed revision contradicts the accepted generation. */
export type ReportingMismatchCodeV1 =
  | 'scope_media_buy_missing'
  | 'coverage_short'
  | 'metric_missing'
  | 'schema_nonconformant'
  | 'currency_mismatch'
  | 'period_mismatch';

/** Facts the accepted configuration generation froze, as the buyer recorded them. */
export interface ReportingContractFactsV1 {
  /** Frozen media-buy denominator from the obligation. */
  mediaBuyIds?: readonly string[];
  /** Frozen `coverage.covered_package_ids` from the obligation. */
  coveredPackageIds?: readonly string[];
  /** Half-open expected period. */
  period?: { start: string; end: string };
  /** `metrics[].name` from the pinned report definition. */
  committedMetrics?: readonly string[];
  /** Units the pinned report definition fixed, keyed by metric/control-total name. */
  metricUnits?: Readonly<Record<string, string>>;
}

/** The exact revision the buyer read, as the seller published it. */
export interface ReportingConsumedRevisionV1 {
  reporting_revision_id?: string;
  coverage?: { status?: string; covered_package_ids?: readonly string[] };
  control_totals?: readonly ReportingControlTotal[];
}

/**
 * What the buyer's own reader observed in the revision's rows.
 *
 * Supply only what you actually determined. Every field is optional and each
 * one gates exactly one code: omit it and that code cannot fire, which is the
 * correct outcome for a buyer that did not look.
 */
export interface ReportingRowEvidenceV1 {
  /**
   * Media buys represented in the rows, counting a buy carried by an explicit
   * zero row as represented — that zero row is precisely what lets the revision
   * distinguish zero delivery from an omitted buy.
   */
  representedMediaBuyIds?: readonly string[];
  /** Metric names actually present in the rows. */
  observedMetricNames?: readonly string[];
  /** `false` when the rows failed validation against the pinned profile schema. */
  rowsConformToPinnedSchema?: boolean;
  /** Range of the pinned grain's time dimension across the rows. */
  observedPeriodBounds?: { earliest: string; latest: string };
}

export interface ReportingContentMismatchV1 {
  mismatchCode: ReportingMismatchCodeV1;
  /** Non-secret, bounded diagnostic naming the exact contradicted fact. */
  detail: string;
}

/**
 * First applicable contradiction between a consumed revision and the frozen
 * contract, or `undefined` when nothing decidable is contradicted.
 *
 * **What `reconcileReporting` can reach, and what it cannot.** The reconciler
 * consumes the revision's rows to recompute its binding digest, so it calls
 * this with real row evidence — but it can only derive `observedMetricNames`,
 * and only when the buyer pinned `committedMetrics`. That makes
 * `coverage_short`, `currency_mismatch` and `metric_missing` reachable through
 * the reconcile loop. The remaining three are a **documented limitation**:
 *
 * - `scope_media_buy_missing` needs to know which media buy a row belongs to.
 * - `period_mismatch` needs the time dimension the pinned grain declares.
 * - `schema_nonconformant` needs the rows validated against the pinned schema.
 *
 * All three depend on the reporting profile's own row shape, which is
 * profile-defined and not readable from a generic row object. The SDK does not
 * guess at them, because the cost of being wrong is asymmetric: a false
 * `content_mismatch` pins the caller's view at `action_required` and the seller
 * MUST NOT return the period to healthy while the statement is the current
 * leaf. An adopter whose own reader *does* understand its profile can call this
 * function directly with a fuller `ReportingRowEvidenceV1` and act on the
 * result.
 *
 * **Precedence.** The spec pins exactly one ordering rule: a metric that is
 * simply absent uses `metric_missing` even when the pinned schema declares it
 * required, so `metric_missing` is evaluated before `schema_nonconformant`.
 * The remaining order is this SDK's, chosen so the most structural fact wins —
 * a revision missing a whole media buy reports that, not whichever metric
 * happened to go missing with it — and is stable so the code does not flap
 * between reads of the same bytes.
 */
export function detectReportingContentMismatch(
  facts: ReportingContractFactsV1,
  revision: ReportingConsumedRevisionV1,
  rows: ReportingRowEvidenceV1 = {}
): ReportingContentMismatchV1 | undefined {
  if (rows.representedMediaBuyIds) {
    const omitted = (facts.mediaBuyIds ?? []).find(id => !rows.representedMediaBuyIds!.includes(id));
    if (omitted !== undefined) {
      return {
        mismatchCode: 'scope_media_buy_missing',
        detail: `media_buy_id ${bounded(omitted)} is in the obligation denominator but has no rows and no explicit zero row`,
      };
    }
  }

  // Unconditional. Under `allow_partial` the obligation already froze the
  // reduced denominator, so a revision narrower than that frozen set is still
  // short of what the generation promised.
  // `Array.isArray`, not `?? []`: the latter caught null and undefined and
  // nothing else, so a scalar `covered_package_ids` reached `.includes` and
  // threw `TypeError`. `COVERAGE_SCOPE_MISMATCH` is deliberately not
  // disqualifying, so a revision with malformed coverage reaches here — after
  // receipts have synced — and the throw suppressed every period in scope on
  // every run, which is exactly the `package_missing` accusation this check
  // exists to produce.
  const frozenPackageIds = Array.isArray(facts.coveredPackageIds) ? facts.coveredPackageIds : [];
  const revisionPackageIds = Array.isArray(revision.coverage?.covered_package_ids)
    ? revision.coverage.covered_package_ids
    : [];
  const missingPackage = frozenPackageIds.find(id => !revisionPackageIds.includes(id));
  if (missingPackage !== undefined) {
    return {
      mismatchCode: 'coverage_short',
      detail: `package_id ${bounded(missingPackage)} is in the obligation's frozen coverage but absent from the revision`,
    };
  }

  if (facts.period && rows.observedPeriodBounds) {
    const start = Date.parse(facts.period.start);
    const end = Date.parse(facts.period.end);
    const earliest = Date.parse(rows.observedPeriodBounds.earliest);
    const latest = Date.parse(rows.observedPeriodBounds.latest);
    // Half-open: [start, end). A row exactly at `end` is outside.
    if ([start, end, earliest, latest].every(Number.isFinite) && (earliest < start || latest >= end)) {
      return {
        mismatchCode: 'period_mismatch',
        detail: `rows carry time-dimension values from ${bounded(rows.observedPeriodBounds.earliest)} to ${bounded(rows.observedPeriodBounds.latest)}, outside the obligation's half-open period`,
      };
    }
  }

  // Before schema_nonconformant, per the spec's explicit precedence note.
  if (rows.observedMetricNames) {
    const missingMetric = (facts.committedMetrics ?? []).find(name => !rows.observedMetricNames!.includes(name));
    if (missingMetric !== undefined) {
      return {
        mismatchCode: 'metric_missing',
        detail: `metric ${bounded(missingMetric)} is promised by the pinned report definition but absent from the revision`,
      };
    }
  }

  const totalsByName = new Map(
    (revision.control_totals ?? []).map(total => [total.name, total as { name: string; unit?: string }])
  );
  for (const [name, expectedUnit] of Object.entries(facts.metricUnits ?? {})) {
    const total = totalsByName.get(name);
    // A control total with no `unit` declares none; only a stated disagreement counts.
    if (total && total.unit !== undefined && total.unit !== expectedUnit) {
      return {
        mismatchCode: 'currency_mismatch',
        detail: `metric ${bounded(name)} reports unit ${bounded(total.unit)} where the pinned definition fixed ${bounded(expectedUnit)}`,
      };
    }
  }

  if (rows.rowsConformToPinnedSchema === false) {
    return {
      mismatchCode: 'schema_nonconformant',
      detail: 'rows do not validate against the reporting profile schema pinned by the accepted generation',
    };
  }

  return undefined;
}

/**
 * Bound a seller- or buyer-supplied identifier before it lands in a diagnostic
 * that may reach a log line or a wire detail.
 */
function bounded(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 64);
}
