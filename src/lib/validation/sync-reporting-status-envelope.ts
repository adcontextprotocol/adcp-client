import { ADCP_VERSION } from '../version';
import { MAX_JSON_DEPTH } from '../utils/json-depth';
import {
  REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES,
  REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES,
} from '../reporting/ledger/types';
import { validateRequest } from './schema-validator';

const MAX_STATUS_ITEMS = 100;
const MAX_JSON_NODES = 10_000;

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
              keyword: 'x-adcp-schema-unavailable',
              schemaPath: '',
            },
          ],
        }
      : outcome;
  };
  const shapeIssue = boundedJsonShapeIssue(payload);
  if (shapeIssue) {
    return {
      valid: false,
      variant: 'request',
      issues: [
        {
          ...shapeIssue,
          schemaPath: '',
        },
      ],
    };
  }
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

interface BoundedJsonShapeIssue {
  pointer: string;
  message: string;
  keyword: string;
}

function boundedJsonShapeIssue(root: unknown): BoundedJsonShapeIssue | undefined {
  let nodes = 0;
  let pendingValues = 1;
  let bytes = 0;
  const stack: Array<{ value: unknown; depth: number; pointer: string; exit?: boolean }> = [
    { value: root, depth: 0, pointer: '/' },
  ];
  const active = new WeakSet<object>();
  while (stack.length > 0) {
    const { value, depth, pointer, exit } = stack.pop()!;
    if (!exit) {
      pendingValues -= 1;
      if (++nodes > MAX_JSON_NODES) {
        return shapeIssue(
          pointer,
          'sync_reporting_status exceeds the 10,000-node request bound',
          'x-adcp-max-json-nodes'
        );
      }
    }
    if (typeof value === 'string') {
      bytes += boundedJsonStringBytes(value, REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES - bytes);
      if (bytes > REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES) {
        return shapeIssue(pointer, 'sync_reporting_status exceeds the 8 MiB request bound', 'x-adcp-max-json-bytes');
      }
      continue;
    }
    if (value === null || typeof value !== 'object') {
      bytes += 24;
      if (bytes > REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES) {
        return shapeIssue(pointer, 'sync_reporting_status exceeds the 8 MiB request bound', 'x-adcp-max-json-bytes');
      }
      continue;
    }
    if (exit) {
      active.delete(value);
      continue;
    }
    if (active.has(value)) {
      return shapeIssue(pointer, 'sync_reporting_status must contain acyclic JSON', 'x-adcp-acyclic-json');
    }
    active.add(value);
    if (depth > MAX_JSON_DEPTH) {
      return shapeIssue(pointer, 'sync_reporting_status exceeds the maximum JSON depth', 'x-adcp-max-json-depth');
    }
    stack.push({ value, depth, pointer, exit: true });
    const children: Array<{ value: unknown; pointer: string }> = [];
    if (Array.isArray(value)) {
      if (nodes + pendingValues + value.length > MAX_JSON_NODES) {
        return shapeIssue(
          pointer,
          'sync_reporting_status exceeds the 10,000-node request bound',
          'x-adcp-max-json-nodes'
        );
      }
      if (bytes + 2 + value.length > REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES) {
        return shapeIssue(pointer, 'sync_reporting_status exceeds the 8 MiB request bound', 'x-adcp-max-json-bytes');
      }
      for (let index = 0; index < value.length; index += 1) {
        children.push({ value: value[index], pointer: childPointer(pointer, String(index)) });
      }
    } else {
      const keys = Object.keys(value);
      if (nodes + pendingValues + keys.length > MAX_JSON_NODES) {
        return shapeIssue(
          pointer,
          'sync_reporting_status exceeds the 10,000-node request bound',
          'x-adcp-max-json-nodes'
        );
      }
      for (const key of keys) {
        bytes += boundedJsonStringBytes(key, REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES - bytes) + 1;
        const nextPointer = childPointer(pointer, key);
        if (bytes > REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES) {
          return shapeIssue(
            nextPointer,
            'sync_reporting_status exceeds the 8 MiB request bound',
            'x-adcp-max-json-bytes'
          );
        }
        children.push({ value: (value as Record<string, unknown>)[key], pointer: nextPointer });
      }
    }
    bytes += 2 + children.length;
    if (bytes > REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES) {
      return shapeIssue(pointer, 'sync_reporting_status exceeds the 8 MiB request bound', 'x-adcp-max-json-bytes');
    }
    if (nodes + pendingValues + children.length > MAX_JSON_NODES) {
      return shapeIssue(
        pointer,
        'sync_reporting_status exceeds the 10,000-node request bound',
        'x-adcp-max-json-nodes'
      );
    }
    pendingValues += children.length;
    for (const child of children) stack.push({ ...child, depth: depth + 1 });
  }
  return undefined;
}

function childPointer(parent: string, segment: string): string {
  const encoded = segment.replace(/~/g, '~0').replace(/\//g, '~1');
  const pointer = `${parent === '/' ? '' : parent}/${encoded}`;
  return Buffer.byteLength(pointer, 'utf8') <= REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES ? pointer : '/';
}

function shapeIssue(pointer: string, message: string, keyword: string): BoundedJsonShapeIssue {
  return { pointer, message, keyword };
}

function boundedJsonStringBytes(value: string, remaining: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length && bytes <= remaining; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < value.length ? value.charCodeAt(index + 1) : undefined;
      if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
