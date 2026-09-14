/**
 * Buyer-side `content_mismatch` detection (AdCP 3.2.0-rc.3).
 *
 * `content_mismatch` says: the buyer consumed the exact revision the seller
 * requires, and its content contradicts a fact the accepted configuration
 * generation **already fixed**. Every code below is decidable from the
 * obligation, the pinned report definition, and the revision itself — with no
 * reference to either party's own measurement.
 *
 * That boundary is the whole point of the status, and it is easy to get wrong
 * in the permissive direction. A disagreement about *how many impressions the
 * seller counted* is a measurement dispute, handled by `measurement_terms` and
 * `makegood_policy`; emitting `content_mismatch` for it would push a
 * commercial argument through an operational channel that the seller cannot
 * resolve and cannot ignore. Nothing here compares a delivered number against
 * a buyer-side expectation, and nothing here should be extended to.
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
  /** Obligation coverage requirement; `full` is the only one that can be short. */
  coverageRequirement?: 'full' | 'allow_partial';
  /** Half-open expected period. */
  period?: { start: string; end: string };
  /** `metrics[].name` from the pinned report definition. */
  committedMetrics?: readonly string[];
  /** Units the pinned report definition fixed, keyed by metric/control-total name. */
  metricUnits?: Readonly<Record<string, string>>;
  /** Pinned reporting-profile schema identity. */
  schemaUri?: string;
  schemaSha256?: string;
}

/** The exact revision the buyer read, as the seller published it. */
export interface ReportingConsumedRevisionV1 {
  reporting_revision_id?: string;
  media_buy_ids?: readonly string[];
  coverage?: {
    status?: string;
    covered_package_ids?: readonly string[];
  };
  period?: { start?: string; end?: string };
  control_totals?: readonly ReportingControlTotal[];
  schema_uri?: string;
  schema_sha256?: string;
}

export interface ReportingContentMismatchV1 {
  mismatchCode: ReportingMismatchCodeV1;
  /** Non-secret, bounded diagnostic naming the exact contradicted fact. */
  detail: string;
}

/**
 * First applicable contradiction between a consumed revision and the frozen
 * contract, or `undefined` when the revision honors every decidable fact.
 *
 * **Precedence.** The spec pins exactly one ordering rule: a metric that is
 * simply absent uses `metric_missing` even when the pinned schema declares it
 * required, so `metric_missing` is evaluated before `schema_nonconformant`.
 * The remaining order is this SDK's, chosen so the most structural fact wins —
 * a revision missing a whole media buy is reported as that, not as whichever
 * metric happened to go missing with it — and is stable so a buyer does not
 * see the code flap between reads of the same bytes.
 *
 * A zero row is not an omission: a media buy present in the revision with zero
 * delivery is covered, because the revision can then distinguish zero delivery
 * from an omitted buy. Only absence from `media_buy_ids` counts.
 */
export function detectReportingContentMismatch(
  facts: ReportingContractFactsV1,
  revision: ReportingConsumedRevisionV1
): ReportingContentMismatchV1 | undefined {
  const missingMediaBuy = (facts.mediaBuyIds ?? []).find(id => !(revision.media_buy_ids ?? []).includes(id));
  if (missingMediaBuy !== undefined) {
    return {
      mismatchCode: 'scope_media_buy_missing',
      detail: `media_buy_id ${bounded(missingMediaBuy)} is in the obligation denominator but absent from the revision`,
    };
  }

  // Only a `full` obligation can be short: `allow_partial` froze a smaller
  // denominator on purpose and publishes the partial label with it.
  if (facts.coverageRequirement !== 'allow_partial') {
    const missingPackage = (facts.coveredPackageIds ?? []).find(
      id => !(revision.coverage?.covered_package_ids ?? []).includes(id)
    );
    if (missingPackage !== undefined) {
      return {
        mismatchCode: 'coverage_short',
        detail: `package_id ${bounded(missingPackage)} is in the obligation's frozen coverage but absent from the revision`,
      };
    }
  }

  if (facts.period && revision.period) {
    const startsMatch = sameInstant(facts.period.start, revision.period.start);
    const endsMatch = sameInstant(facts.period.end, revision.period.end);
    if (!startsMatch || !endsMatch) {
      return {
        mismatchCode: 'period_mismatch',
        detail: `revision period ${bounded(String(revision.period.start))}..${bounded(String(revision.period.end))} is outside the obligation's half-open period`,
      };
    }
  }

  const totalsByName = new Map(
    (revision.control_totals ?? []).map(total => [total.name, total as { name: string; unit?: string }])
  );

  // Evaluated before schema_nonconformant: the spec is explicit that a merely
  // absent metric is metric_missing even when the pinned schema requires it.
  const missingMetric = (facts.committedMetrics ?? []).find(name => !totalsByName.has(name));
  if (missingMetric !== undefined) {
    return {
      mismatchCode: 'metric_missing',
      detail: `metric ${bounded(missingMetric)} is promised by the pinned report definition but absent from the revision`,
    };
  }

  for (const [name, expectedUnit] of Object.entries(facts.metricUnits ?? {})) {
    const total = totalsByName.get(name);
    if (total && total.unit !== undefined && total.unit !== expectedUnit) {
      return {
        mismatchCode: 'currency_mismatch',
        detail: `metric ${bounded(name)} reports unit ${bounded(total.unit)} where the pinned definition fixed ${bounded(expectedUnit)}`,
      };
    }
  }

  // Structural pinning last, per the precedence note above.
  if (
    (facts.schemaUri !== undefined && revision.schema_uri !== undefined && facts.schemaUri !== revision.schema_uri) ||
    (facts.schemaSha256 !== undefined &&
      revision.schema_sha256 !== undefined &&
      facts.schemaSha256.toLowerCase() !== revision.schema_sha256.toLowerCase())
  ) {
    return {
      mismatchCode: 'schema_nonconformant',
      detail: 'revision rows are pinned to a different reporting-profile schema than the accepted generation',
    };
  }

  return undefined;
}

/** Equal instants, tolerant of differing but equivalent RFC 3339 spellings. */
function sameInstant(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  const a = Date.parse(left);
  const b = Date.parse(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return left === right;
  return a === b;
}

/**
 * Bound a seller- or buyer-supplied identifier before it lands in a diagnostic
 * that may reach a log line or a wire detail.
 */
function bounded(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 64);
}
