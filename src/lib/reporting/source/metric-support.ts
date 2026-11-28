/**
 * Which offering metrics a reporting configuration may request, and which of them
 * may publish an inapplicable (`unsupported`) cell without demoting coverage.
 *
 * Internal: deliberately not re-exported from `./index`.
 */

type DeclaredMetricSupport = Readonly<{
  name: string;
  support: 'exact' | 'partial' | 'unavailable';
  reason?: string | undefined;
}>;

/**
 * Metrics a configuration or slice request may name: every `exact` metric and every
 * conditional metric. An `unavailable` metric is never requestable.
 */
export function requestableReportingMetricNamesV1(metrics: readonly DeclaredMetricSupport[]): Set<string> {
  const conditional = conditionalReportingMetricNamesV1(metrics);
  return new Set(
    metrics.filter(metric => metric.support === 'exact' || conditional.has(metric.name)).map(metric => metric.name)
  );
}

/**
 * Conditional metrics: those the offering declares `partial` with a stable reason. Some
 * constituents cannot measure such a metric, and each slice says which through its
 * per-cell availability. A `partial` declaration without a reason is not requestable.
 *
 * Their `unsupported` cells are inapplicable rather than missing. Beside available cells
 * such a cell does not demote its constituent, so the slice can still satisfy full coverage.
 *
 * An `exact` metric promises it applies to every constituent, so its `unsupported`
 * cell is never inapplicable: it keeps demoting coverage as it always has.
 */
export function conditionalReportingMetricNamesV1(metrics: readonly DeclaredMetricSupport[]): Set<string> {
  return new Set(
    metrics.filter(metric => metric.support === 'partial' && Boolean(metric.reason)).map(metric => metric.name)
  );
}
