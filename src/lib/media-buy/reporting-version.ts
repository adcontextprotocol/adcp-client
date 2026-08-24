const BETA6_REPORTING_DIMENSIONS = new Set(['catalog_item', 'creative', 'keyword', 'format']);
const BETA6_SORT_METRICS = new Set([
  'commissionable_value',
  'plays',
  'cost_per_completed_view',
  'cpm',
  'downloads',
  'units_sold',
  'new_to_brand_units',
  'viewable_rate',
  'viewable_impressions',
  'measurable_impressions',
  'viewed_seconds',
  'quartile_25',
  'quartile_50',
  'quartile_75',
  'quartile_100',
]);

const BETA6_AVAILABLE_METRICS = new Set([
  'measurable_impressions',
  'quartile_25',
  'quartile_50',
  'quartile_75',
  'quartile_100',
  'time_based_views',
  'viewable_impressions',
  'viewable_rate',
  'viewed_seconds',
]);

const BETA6_REPORTING_TASKS = new Set([
  'get_products',
  'create_media_buy',
  'update_media_buy',
  'provide_performance_feedback',
  'list_products',
  'request_proposals',
  'refine_proposals',
  'buy_products',
  'accept_proposal',
  'control_media_buy',
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface Beta6DeliveryRequestIssue {
  field: string;
  detail: string;
}

/** Return the first request feature introduced by the beta.6 reporting contract. */
export function beta6DeliveryRequestIssue(params: unknown): Beta6DeliveryRequestIssue | undefined {
  const input = record(params);
  if (input.requested_metrics !== undefined) {
    return { field: 'requested_metrics', detail: 'requested delivery metrics' };
  }
  const dimensions = record(input.reporting_dimensions);
  for (const [dimension, value] of Object.entries(dimensions)) {
    if (BETA6_REPORTING_DIMENSIONS.has(dimension)) {
      return {
        field: `reporting_dimensions.${dimension}`,
        detail: `the ${dimension} delivery breakdown`,
      };
    }
    const settings = record(value);
    if (settings.sort_direction !== undefined) {
      return {
        field: `reporting_dimensions.${dimension}.sort_direction`,
        detail: 'delivery sort direction',
      };
    }
    if (settings.sort_by !== undefined && BETA6_SORT_METRICS.has(String(settings.sort_by))) {
      return {
        field: `reporting_dimensions.${dimension}.sort_by`,
        detail: `delivery sort metric ${String(settings.sort_by)}`,
      };
    }
  }
  return undefined;
}

function beta6MetricIssue(value: unknown, path = ''): Beta6DeliveryRequestIssue | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = beta6MetricIssue(value[index], `${path}[${index}]`);
      if (issue) return issue;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;

  const current = value as Record<string, unknown>;
  if (current.scope === 'standard' && BETA6_AVAILABLE_METRICS.has(String(current.metric_id))) {
    return {
      field: path ? `${path}.metric_id` : 'metric_id',
      detail: `the beta.6 metric ${String(current.metric_id)}`,
    };
  }
  if (current.scope === 'vendor' && current.qualifier !== undefined) {
    return {
      field: path ? `${path}.qualifier` : 'qualifier',
      detail: 'the beta.6 vendor metric qualifier',
    };
  }

  for (const [key, child] of Object.entries(current)) {
    const field = path ? `${path}.${key}` : key;
    if ((key === 'required_metrics' || key === 'requested_metrics') && Array.isArray(child)) {
      const metric = child.find(candidate => typeof candidate === 'string' && BETA6_AVAILABLE_METRICS.has(candidate));
      if (metric !== undefined) {
        return { field, detail: `the beta.6 metric ${String(metric)}` };
      }
    }
    if (key === 'committed_metrics' && Array.isArray(child)) {
      const index = child.findIndex(candidate => {
        const metric = record(candidate);
        return metric.scope === 'standard' && BETA6_AVAILABLE_METRICS.has(String(metric.metric_id));
      });
      if (index >= 0) {
        const metric = record(child[index]);
        return {
          field: `${field}[${index}].metric_id`,
          detail: `the beta.6 metric ${String(metric.metric_id)}`,
        };
      }
    }
    const issue = beta6MetricIssue(child, field);
    if (issue) return issue;
  }
  return undefined;
}

/** Return the first beta.6-only reporting feature used by a media-buy request. */
export function beta6ReportingRequestIssue(taskName: string, params: unknown): Beta6DeliveryRequestIssue | undefined {
  if (taskName === 'get_media_buy_delivery') return beta6DeliveryRequestIssue(params);
  return BETA6_REPORTING_TASKS.has(taskName) ? beta6MetricIssue(params) : undefined;
}
