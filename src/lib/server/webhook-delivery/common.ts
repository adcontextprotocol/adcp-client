import { createHash } from 'node:crypto';
import type { WebhookDeliveryKey, WebhookDeliveryRecord } from '../webhook-emitter';

// PostgreSQL btree composite primary keys have a finite index-tuple budget.
// Bound UTF-8 bytes (not JS code units) so every accepted key is portable to
// both the direct-text PostgreSQL schema and the digest-keyed Redis schema.
const MAX_SCOPE_BYTES = 512;
const MAX_DELIVERY_ID_BYTES = 512;

/** A durable delivery can no longer be retried and should be terminalized. */
export class WebhookDeliveryTerminalError extends Error {
  readonly code = 'EADCP_WEBHOOK_DELIVERY_TERMINAL';

  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliveryTerminalError';
  }
}

export function isWebhookDeliveryTerminalError(error: unknown): error is WebhookDeliveryTerminalError {
  return (
    error instanceof WebhookDeliveryTerminalError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'EADCP_WEBHOOK_DELIVERY_TERMINAL')
  );
}

export function assertDeliveryKey(key: Readonly<WebhookDeliveryKey>): void {
  assertPart('publisherScope', key.publisherScope, MAX_SCOPE_BYTES);
  assertPart('tenantScope', key.tenantScope, MAX_SCOPE_BYTES);
  assertPart('deliveryId', key.deliveryId, MAX_DELIVERY_ID_BYTES);
}

export function assertRetentionMs(retentionMs: number): void {
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
    throw new TypeError('retentionMs must be a positive safe integer');
  }
}

export function assertLeaseControls(ownerToken: string, leaseMs: number, limit?: number): void {
  if (typeof ownerToken !== 'string' || ownerToken.length < 8 || ownerToken.length > 255) {
    throw new TypeError('ownerToken must be an 8-255 character string');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) {
    throw new TypeError('leaseMs must be an integer from 1 through 3600000');
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) {
    throw new TypeError('limit must be an integer from 1 through 1000');
  }
}

export function assertRetryAfterMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 604_800_000) {
    throw new TypeError('retryAfterMs must be an integer from 0 through 604800000');
  }
}

export function assertWebhookDisposition(value: unknown): asserts value is 'delivered' | 'terminal' {
  if (value !== 'delivered' && value !== 'terminal') {
    throw new TypeError('disposition must be "delivered" or "terminal"');
  }
}

export function assertProposal(proposed: { idempotencyKey: string; payloadFingerprint: string }): void {
  if (!/^[A-Za-z0-9_.:-]{16,255}$/.test(proposed.idempotencyKey)) {
    throw new TypeError('idempotencyKey must match /^[A-Za-z0-9_.:-]{16,255}$/');
  }
  if (!/^[a-f0-9]{64}$/.test(proposed.payloadFingerprint)) {
    throw new TypeError('payloadFingerprint must be a lowercase SHA-256 hex digest');
  }
}

export function deliveryStorageDigest(key: Readonly<WebhookDeliveryKey>): string {
  assertDeliveryKey(key);
  return createHash('sha256')
    .update(JSON.stringify([key.publisherScope, key.tenantScope, key.deliveryId]))
    .digest('hex');
}

export function parseDeliveryRecord(value: unknown, source: string): WebhookDeliveryRecord {
  if (typeof value !== 'object' || value === null) throw new Error(`${source}: corrupt delivery record`);
  const record = value as Record<string, unknown>;
  if (record.status === 'retired') return { status: 'retired' };
  if (
    record.status !== 'bound' ||
    typeof record.idempotencyKey !== 'string' ||
    typeof record.payloadFingerprint !== 'string' ||
    !Number.isSafeInteger(record.firstAttemptAtMs) ||
    !Number.isSafeInteger(record.retainUntilMs)
  ) {
    throw new Error(`${source}: corrupt delivery record`);
  }
  return {
    status: 'bound',
    idempotencyKey: record.idempotencyKey,
    payloadFingerprint: record.payloadFingerprint,
    firstAttemptAtMs: record.firstAttemptAtMs as number,
    retainUntilMs: record.retainUntilMs as number,
  };
}

function assertPart(label: string, value: unknown, maxBytes: number): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    value.includes('\0') ||
    hasUnpairedSurrogate(value)
  ) {
    throw new TypeError(
      `${label} must be a non-empty UTF-8 string of at most ${maxBytes} bytes without NUL bytes or unpaired surrogates`
    );
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export const WEBHOOK_DELIVERY_VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function quoteWebhookTable(name: string, maxLength = 42): string {
  if (!WEBHOOK_DELIVERY_VALID_IDENTIFIER.test(name) || name.length > maxLength) {
    throw new Error(
      `Invalid SQL identifier "${name}": must match ${WEBHOOK_DELIVERY_VALID_IDENTIFIER} and be at most ${maxLength} characters`
    );
  }
  return `"${name}"`;
}
