import { ADCP_VERSION } from '../version';
import { validateRequest } from './schema-validator';

const MAX_STATUS_ITEMS = 100;

/**
 * Validate the published sync_reporting_status envelope while deliberately
 * replacing each status with a known-valid value. The handler validates the
 * original items independently so one malformed sibling cannot reject the
 * rest of a partial-success batch.
 */
export function validateSyncReportingStatusEnvelope(
  payload: unknown,
  version: Parameters<typeof validateRequest>[2] = ADCP_VERSION
): ReturnType<typeof validateRequest> {
  const validateEnvelope = (value: unknown): ReturnType<typeof validateRequest> => {
    const outcome = validateRequest('sync_reporting_status', value, version);
    return outcome.variant === 'skipped'
      ? {
          valid: false,
          variant: 'request',
          issues: [
            {
              pointer: '/',
              message: `sync_reporting_status is unavailable for AdCP ${version}`,
              keyword: 'schema_unavailable',
              schemaPath: '',
            },
          ],
        }
      : outcome;
  };
  if (!isPlainObject(payload) || !Array.isArray(payload.statuses)) {
    return validateEnvelope(payload);
  }

  // Preserve 0..100 exactly and cap larger arrays at 101, which is sufficient
  // for the published maxItems check without copying an attacker-sized array.
  const itemCount = Math.min(payload.statuses.length, MAX_STATUS_ITEMS + 1);
  const statuses = Array.from({ length: itemCount }, (_, index) => ({
    reporting_status_id: `reporting-status-envelope-${index + 1}`,
    delivery_config_id: 'reporting-envelope-config',
    delivery_config_version: 1,
    report_definition_id: 'reporting-envelope-definition',
    period: {
      start: '2000-01-01T00:00:00Z',
      end: '2000-01-02T00:00:00Z',
      source_timezone: 'UTC',
    },
    consumer_status: 'obligation_missing',
    status_as_of: '2000-01-02T00:00:00Z',
  }));

  return validateEnvelope({ ...payload, statuses });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
