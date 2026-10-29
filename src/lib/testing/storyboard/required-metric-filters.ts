import type { AssertionSpec } from './assertions';
import type { AssertionResult } from './types';

type RecordValue = Record<string, unknown>;
type Finding = Omit<AssertionResult, 'assertion_id' | 'scope'>;

// Documented numeric-leaf subsumption from enums/available-metric.json.
// Structured viewed_seconds distributions deliberately have no container alias.
const CONTAINERS: Record<string, string> = {
  viewable_rate: 'viewability',
  viewable_impressions: 'viewability',
  measurable_impressions: 'viewability',
  viewed_seconds: 'viewability',
  quartile_25: 'quartile_data',
  quartile_50: 'quartile_data',
  quartile_75: 'quartile_data',
  quartile_100: 'quartile_data',
};

// Only unambiguous formulas in core/delivery-metrics.json and its task docs.
// Platform-specific engagement_rate and new_to_brand_rate cannot be inferred.
const DERIVED_FROM: Record<string, string[]> = {
  ctr: ['clicks', 'impressions'],
  completion_rate: ['completed_views', 'impressions'],
  roas: ['conversion_value', 'spend'],
  cost_per_acquisition: ['spend', 'conversions'],
  cost_per_click: ['spend', 'clicks'],
  cost_per_completed_view: ['spend', 'completed_views'],
  cpm: ['spend', 'impressions'],
  viewable_rate: ['viewable_impressions', 'measurable_impressions'],
};

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function metricAvailable(metric: string, declared: Set<string>): boolean {
  if (declared.has(metric)) return true;
  const container = Object.hasOwn(CONTAINERS, metric) ? CONTAINERS[metric] : undefined;
  if (container && declared.has(container)) return true;
  const derivation = Object.hasOwn(DERIVED_FROM, metric) ? DERIVED_FROM[metric] : undefined;
  return derivation?.every(dependency => metricAvailable(dependency, declared)) ?? false;
}

function vendorMetricMatches(actual: unknown, required: RecordValue): boolean {
  const entry = record(actual);
  if (!entry || (required.metric_id !== undefined && entry.metric_id !== required.metric_id)) return false;
  const vendor = record(required.vendor);
  if (!vendor) return true;
  const actualVendor = record(entry.vendor);
  if (!actualVendor) return false;
  return (
    actualVendor.domain === vendor.domain &&
    (vendor.brand_id === undefined || actualVendor.brand_id === vendor.brand_id)
  );
}

/** Optional discovery filters have binding semantics when a buyer supplies them. */
export const requiredMetricFiltersAssertion: AssertionSpec = {
  id: 'discovery.required_metric_filters',
  default: true,
  description: 'Every returned product satisfies all requested standard and vendor metric filters.',
  onStep(_ctx, step) {
    if (step.skipped || step.task !== 'get_products') return [];
    const request = record(step.request?.payload);
    const filters = record(request?.filters);
    const required = Array.isArray(filters?.required_metrics)
      ? filters.required_metrics.filter((metric): metric is string => typeof metric === 'string')
      : [];
    const requiredVendors = Array.isArray(filters?.required_vendor_metrics)
      ? filters.required_vendor_metrics.flatMap(value => {
          const entry = record(value);
          return entry && (typeof entry.metric_id === 'string' || typeof record(entry.vendor)?.domain === 'string')
            ? [entry]
            : [];
        })
      : [];
    if (required.length === 0 && requiredVendors.length === 0) return [];
    const raw = record(step.response ?? step.response_record?.payload);
    const response = record(raw?.data) ?? raw;
    if (!Array.isArray(response?.products) || response.products.length === 0) return [];
    const reportingProjectedAway = Array.isArray(request?.fields) && !request.fields.includes('reporting_capabilities');
    const findings: Finding[] = [];
    for (const [index, value] of response.products.entries()) {
      const product = record(value);
      if (!product) continue; // Response schema validation owns malformed rows.
      // A projected-away declaration cannot prove inadequate support. If the
      // seller includes it anyway, its observable contradictions still count.
      if (reportingProjectedAway && product.reporting_capabilities === undefined) {
        findings.push({
          passed: true,
          status: 'not_applicable',
          step_id: step.step_id,
          description: `products[${index}]: required metric filter compatibility is unproven because reporting_capabilities was projected away`,
        });
        continue;
      }
      const capabilities = record(product.reporting_capabilities);
      // reporting-capabilities.json always includes these two implicitly.
      const declared = new Set<string>(['impressions', 'spend']);
      if (Array.isArray(capabilities?.available_metrics)) {
        for (const metric of capabilities.available_metrics) if (typeof metric === 'string') declared.add(metric);
      }
      const missing = required.filter(metric => !metricAvailable(metric, declared));
      if (required.length > 0)
        findings.push({
          passed: missing.length === 0,
          step_id: step.step_id,
          description: `products[${index}] must satisfy every filters.required_metrics entry`,
          ...(missing.length > 0 && {
            error: `products[${index}] does not declare required metrics ${JSON.stringify(missing)}`,
          }),
        });
      const vendorMetrics = Array.isArray(capabilities?.vendor_metrics) ? capabilities.vendor_metrics : [];
      for (const [filterIndex, vendor] of requiredVendors.entries()) {
        const matched = vendorMetrics.some(actual => vendorMetricMatches(actual, vendor));
        findings.push({
          passed: matched,
          step_id: step.step_id,
          description: `products[${index}] must satisfy filters.required_vendor_metrics[${filterIndex}] on one declared vendor metric`,
          ...(!matched && {
            error: `products[${index}] has no vendor metric matching filters.required_vendor_metrics[${filterIndex}]`,
          }),
        });
      }
    }
    return findings;
  },
};
