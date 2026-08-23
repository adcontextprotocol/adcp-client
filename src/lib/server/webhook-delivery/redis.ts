import type { RedisBackendClient, RedisLikeClient } from '../idempotency';
import type {
  WebhookDeliveryKey,
  WebhookDeliveryProposal,
  WebhookDeliveryRecord,
  WebhookDeliveryStore,
} from '../webhook-emitter';
import {
  assertDeliveryKey,
  assertLeaseControls,
  assertProposal,
  assertRetentionMs,
  assertRetryAfterMs,
  assertWebhookDisposition,
  deliveryStorageDigest,
  parseDeliveryRecord,
} from './common';
import type {
  WebhookDeliveryRecoveryBackend,
  WebhookRecoveryCheckpointResult,
  WebhookRecoveryRecord,
} from './recovery';

const DEFAULT_PREFIX = 'adcp:webhook-delivery:v1:';
const DEFAULT_OUTBOX_PREFIX = 'adcp:webhook-outbox:v1:';

export interface RedisWebhookDeliveryStoreOptions {
  /** Deployment-unique prefix. Defaults to `adcp:webhook-delivery:v1:`. */
  keyPrefix?: string;
  /** Explicit acknowledgement when the Redis database is deployment-isolated. */
  acknowledgeIsolatedDatabase?: boolean;
}

export interface RedisWebhookDeliveryRecoveryOptions {
  /** Deployment-unique prefix. Defaults to `adcp:webhook-outbox:v1:`. */
  keyPrefix?: string;
  acknowledgeIsolatedDatabase?: boolean;
}

const CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if raw then
  local current = cjson.decode(raw)
  if current.publisherScope ~= ARGV[4] or current.tenantScope ~= ARGV[5] or current.deliveryId ~= ARGV[6] then
    return redis.error_reply('delivery identity digest collision')
  end
  if current.status == 'bound' and now_ms > tonumber(current.retainUntilMs) then
    local retired = cjson.encode({status = 'retired', publisherScope = ARGV[4], tenantScope = ARGV[5], deliveryId = ARGV[6]})
    redis.call('SET', KEYS[1], retired)
    return retired
  end
  return raw
end
local stored = cjson.encode({
  status = 'bound',
  idempotencyKey = ARGV[1],
  payloadFingerprint = ARGV[2],
  publisherScope = ARGV[4],
  tenantScope = ARGV[5],
  deliveryId = ARGV[6],
  firstAttemptAtMs = now_ms,
  retainUntilMs = now_ms + tonumber(ARGV[3])
})
redis.call('SET', KEYS[1], stored)
return stored
`;

/** Redis implementation of the immutable publisher delivery binding. */
export function redisWebhookDeliveryStore(
  client: RedisBackendClient,
  options: RedisWebhookDeliveryStoreOptions = {}
): WebhookDeliveryStore & { probe(): Promise<void> } {
  const c = client as RedisLikeClient;
  for (const method of ['eval', 'ping'] as const) {
    if (typeof c?.[method] !== 'function') {
      throw new TypeError(`redisWebhookDeliveryStore: client must implement ${method}()`);
    }
  }
  if (options.keyPrefix !== undefined && typeof options.keyPrefix !== 'string') {
    throw new TypeError('redisWebhookDeliveryStore: keyPrefix must be a string');
  }
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  const unsafePrefix = prefix.trim().length === 0 || prefix === DEFAULT_PREFIX;
  const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (!development && unsafePrefix && !options.acknowledgeIsolatedDatabase) {
    throw new Error(
      'redisWebhookDeliveryStore: production requires a deployment-unique keyPrefix or acknowledgeIsolatedDatabase: true'
    );
  }

  const runtimeCall = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (cause) {
      throw new Error(`redisWebhookDeliveryStore.${operation}: database operation failed`, { cause });
    }
  };

  return {
    durability: 'durable',
    async probe(): Promise<void> {
      try {
        await c.ping();
      } catch (cause) {
        throw new Error('webhook delivery store probe failed: Redis is unreachable or misconfigured', { cause });
      }
    },
    async claim(
      key: Readonly<WebhookDeliveryKey>,
      proposed: Readonly<WebhookDeliveryProposal>,
      retentionMs: number
    ): Promise<WebhookDeliveryRecord> {
      assertDeliveryKey(key);
      assertProposal(proposed);
      assertRetentionMs(retentionMs);
      const result = await runtimeCall('claim', () =>
        c.eval(CLAIM_SCRIPT, {
          keys: [`${prefix}${deliveryStorageDigest(key)}`],
          arguments: [
            proposed.idempotencyKey,
            proposed.payloadFingerprint,
            String(retentionMs),
            key.publisherScope,
            key.tenantScope,
            key.deliveryId,
          ],
        })
      );
      if (typeof result !== 'string') throw new Error('redisWebhookDeliveryStore.claim: corrupt Redis response');
      let parsed: unknown;
      try {
        parsed = JSON.parse(result);
      } catch (cause) {
        throw new Error('redisWebhookDeliveryStore.claim: corrupt delivery record', { cause });
      }
      return parseDeliveryRecord(parsed, 'redisWebhookDeliveryStore');
    },
  };
}

const OUTBOX_CHECKPOINT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if raw then
  local current = cjson.decode(raw)
  if current.snapshotFingerprint ~= ARGV[1] then return cjson.encode({result = 'conflict'}) end
  if current.state == 'settled' then return cjson.encode({result = 'duplicate', settled = true}) end
  if not current.leaseExpiresAtMs or tonumber(current.leaseExpiresAtMs) < now_ms then
    current.leaseOwner = ARGV[4]
    current.leaseVersion = tonumber(current.leaseVersion or 0) + 1
    current.leaseExpiresAtMs = now_ms + tonumber(ARGV[5])
    current.attemptCount = tonumber(current.attemptCount or 0) + 1
    redis.call('SET', KEYS[1], cjson.encode(current))
    redis.call('ZADD', KEYS[2], current.leaseExpiresAtMs, ARGV[3])
    return cjson.encode({result = 'duplicate', lease = current})
  end
  return cjson.encode({result = 'duplicate'})
end
local record = cjson.decode(ARGV[2])
record.state = 'pending'
record.attemptCount = 1
record.nextAttemptAtMs = now_ms
record.leaseOwner = ARGV[4]
record.leaseVersion = 1
record.leaseExpiresAtMs = now_ms + tonumber(ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(record))
redis.call('ZADD', KEYS[2], record.leaseExpiresAtMs, ARGV[3])
return cjson.encode({result = 'inserted', lease = record})
`;

const OUTBOX_SETTLE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if record.state == 'pending' and record.leaseOwner and record.leaseExpiresAtMs
   and tonumber(record.leaseExpiresAtMs) >= now_ms then return 0 end
record.state = 'settled'
record.disposition = ARGV[1]
record.snapshotJson = nil
record.leaseOwner = nil
record.leaseExpiresAtMs = nil
redis.call('SET', KEYS[1], cjson.encode(record))
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;

const OUTBOX_CLAIM_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local candidates = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now_ms, 'LIMIT', 0, tonumber(ARGV[4]) * 4)
local claimed = {}
for _, digest in ipairs(candidates) do
  if #claimed >= tonumber(ARGV[4]) then break end
  local record_key = ARGV[1] .. digest
  local raw = redis.call('GET', record_key)
  if not raw then
    redis.call('ZREM', KEYS[1], digest)
  else
    local record = cjson.decode(raw)
    if record.state ~= 'pending' then
      redis.call('ZREM', KEYS[1], digest)
    elseif not record.leaseExpiresAtMs or tonumber(record.leaseExpiresAtMs) < now_ms then
      record.leaseOwner = ARGV[2]
      record.leaseVersion = tonumber(record.leaseVersion or 0) + 1
      record.leaseExpiresAtMs = now_ms + tonumber(ARGV[3])
      record.attemptCount = tonumber(record.attemptCount or 0) + 1
      redis.call('SET', record_key, cjson.encode(record))
      redis.call('ZADD', KEYS[1], record.leaseExpiresAtMs, digest)
      table.insert(claimed, cjson.encode(record))
    end
  end
end
return claimed
`;

const OUTBOX_RENEW_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local record = cjson.decode(raw)
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if record.state ~= 'pending' or record.leaseOwner ~= ARGV[1]
   or tonumber(record.leaseVersion) ~= tonumber(ARGV[2])
   or not record.leaseExpiresAtMs or tonumber(record.leaseExpiresAtMs) < now_ms then return false end
record.leaseExpiresAtMs = now_ms + tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(record))
redis.call('ZADD', KEYS[2], record.leaseExpiresAtMs, ARGV[4])
return tostring(record.leaseExpiresAtMs)
`;

const OUTBOX_RELEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if record.state ~= 'pending' or record.leaseOwner ~= ARGV[1]
   or tonumber(record.leaseVersion) ~= tonumber(ARGV[2])
   or not record.leaseExpiresAtMs or tonumber(record.leaseExpiresAtMs) < now_ms then return 0 end
record.leaseOwner = nil
record.leaseExpiresAtMs = nil
record.nextAttemptAtMs = now_ms + tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(record))
redis.call('ZADD', KEYS[2], record.nextAttemptAtMs, ARGV[4])
return 1
`;

const OUTBOX_SETTLE_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if record.state ~= 'pending' or record.leaseOwner ~= ARGV[1]
   or tonumber(record.leaseVersion) ~= tonumber(ARGV[2])
   or not record.leaseExpiresAtMs or tonumber(record.leaseExpiresAtMs) < now_ms then return 0 end
record.state = 'settled'
record.disposition = ARGV[3]
record.snapshotJson = nil
record.leaseOwner = nil
record.leaseExpiresAtMs = nil
redis.call('SET', KEYS[1], cjson.encode(record))
redis.call('ZREM', KEYS[2], ARGV[4])
return 1
`;

/** Redis durable outbox with backend-clock leases and stale-owner fencing. */
export function redisWebhookDeliveryRecoveryBackend(
  client: RedisBackendClient,
  options: RedisWebhookDeliveryRecoveryOptions = {}
): WebhookDeliveryRecoveryBackend {
  const c = client as RedisLikeClient;
  for (const method of ['eval', 'ping'] as const) {
    if (typeof c?.[method] !== 'function') {
      throw new TypeError(`redisWebhookDeliveryRecoveryBackend: client must implement ${method}()`);
    }
  }
  if (options.keyPrefix !== undefined && typeof options.keyPrefix !== 'string') {
    throw new TypeError('redisWebhookDeliveryRecoveryBackend: keyPrefix must be a string');
  }
  const prefix = options.keyPrefix ?? DEFAULT_OUTBOX_PREFIX;
  const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (
    !development &&
    (prefix.trim().length === 0 || prefix === DEFAULT_OUTBOX_PREFIX) &&
    !options.acknowledgeIsolatedDatabase
  ) {
    throw new Error(
      'redisWebhookDeliveryRecoveryBackend: production requires a deployment-unique keyPrefix or acknowledgeIsolatedDatabase: true'
    );
  }
  // A constant Redis Cluster hash tag keeps the pending index and every
  // dynamically accessed record in one slot for atomic Lua execution.
  const clusterNamespace = `${prefix}{adcp-webhook-outbox-v1}:`;
  const recordPrefix = `${clusterNamespace}record:`;
  const pendingIndex = `${clusterNamespace}pending`;
  const runtimeCall = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (cause) {
      throw new Error(`redisWebhookDeliveryRecoveryBackend.${operation}: database operation failed`, { cause });
    }
  };
  const storage = (key: Readonly<WebhookDeliveryKey>) => {
    const digest = deliveryStorageDigest(key);
    return { digest, redisKey: `${recordPrefix}${digest}` };
  };

  return {
    durability: 'durable',
    async probe(): Promise<void> {
      try {
        await c.ping();
      } catch (cause) {
        throw new Error('webhook recovery probe failed: Redis is unreachable or misconfigured', { cause });
      }
    },
    async checkpoint(key, snapshot, snapshotFingerprint, storageFingerprint, initialLease) {
      assertDeliveryKey(key);
      assertLeaseControls(initialLease.ownerToken, initialLease.leaseMs);
      const { digest, redisKey } = storage(key);
      const serialized = JSON.stringify({
        key,
        snapshotJson: JSON.stringify(snapshot),
        snapshotFingerprint,
        storageFingerprint,
      });
      const result = await runtimeCall('checkpoint', () =>
        c.eval(OUTBOX_CHECKPOINT_SCRIPT, {
          keys: [redisKey, pendingIndex],
          arguments: [snapshotFingerprint, serialized, digest, initialLease.ownerToken, String(initialLease.leaseMs)],
        })
      );
      if (typeof result !== 'string') {
        throw new Error('redisWebhookDeliveryRecoveryBackend.checkpoint: corrupt Redis response');
      }
      let parsed: { result?: WebhookRecoveryCheckpointResult; lease?: unknown; settled?: boolean };
      try {
        parsed = JSON.parse(result);
      } catch (cause) {
        throw new Error('redisWebhookDeliveryRecoveryBackend.checkpoint: corrupt Redis response', { cause });
      }
      if (parsed.result !== 'inserted' && parsed.result !== 'duplicate' && parsed.result !== 'conflict') {
        throw new Error('redisWebhookDeliveryRecoveryBackend.checkpoint: corrupt Redis response');
      }
      return {
        result: parsed.result,
        ...(parsed.lease !== undefined && { lease: parseRecoveryRecord(JSON.stringify(parsed.lease), 'checkpoint') }),
        ...(parsed.settled === true && { settled: true }),
      };
    },
    async settle(key, disposition): Promise<void> {
      assertDeliveryKey(key);
      assertWebhookDisposition(disposition);
      const { digest, redisKey } = storage(key);
      await runtimeCall('settle', () =>
        c.eval(OUTBOX_SETTLE_SCRIPT, {
          keys: [redisKey, pendingIndex],
          arguments: [disposition, digest],
        })
      );
    },
    async claimPending({ ownerToken, leaseMs, limit }): Promise<WebhookRecoveryRecord[]> {
      assertLeaseControls(ownerToken, leaseMs, limit);
      const result = await runtimeCall('claimPending', () =>
        c.eval(OUTBOX_CLAIM_SCRIPT, {
          keys: [pendingIndex],
          arguments: [recordPrefix, ownerToken, String(leaseMs), String(limit)],
        })
      );
      if (!Array.isArray(result)) throw new Error('redisWebhookDeliveryRecoveryBackend.claimPending: corrupt response');
      return result.map(raw => parseRecoveryRecord(raw, 'claimPending'));
    },
    async renew(lease, leaseMs): Promise<number | null> {
      assertLeaseControls(lease.leaseOwner, leaseMs);
      const { digest, redisKey } = storage(lease.key);
      const result = await runtimeCall('renew', () =>
        c.eval(OUTBOX_RENEW_SCRIPT, {
          keys: [redisKey, pendingIndex],
          arguments: [lease.leaseOwner, String(lease.leaseVersion), String(leaseMs), digest],
        })
      );
      return result === null || result === false ? null : Number(result);
    },
    async release(lease, retryAfterMs): Promise<boolean> {
      assertLeaseControls(lease.leaseOwner, 1);
      assertRetryAfterMs(retryAfterMs);
      const { digest, redisKey } = storage(lease.key);
      const result = await runtimeCall('release', () =>
        c.eval(OUTBOX_RELEASE_SCRIPT, {
          keys: [redisKey, pendingIndex],
          arguments: [lease.leaseOwner, String(lease.leaseVersion), String(retryAfterMs), digest],
        })
      );
      return Number(result) === 1;
    },
    async settleLease(lease, disposition): Promise<boolean> {
      assertLeaseControls(lease.leaseOwner, 1);
      assertWebhookDisposition(disposition);
      const { digest, redisKey } = storage(lease.key);
      const result = await runtimeCall('settleLease', () =>
        c.eval(OUTBOX_SETTLE_LEASE_SCRIPT, {
          keys: [redisKey, pendingIndex],
          arguments: [lease.leaseOwner, String(lease.leaseVersion), disposition, digest],
        })
      );
      return Number(result) === 1;
    },
  };
}

function parseRecoveryRecord(raw: unknown, operation: string): WebhookRecoveryRecord {
  if (typeof raw !== 'string') throw new Error(`redisWebhookDeliveryRecoveryBackend.${operation}: corrupt record`);
  let record: WebhookRecoveryRecord;
  try {
    const parsed = JSON.parse(raw) as WebhookRecoveryRecord & { snapshotJson?: string };
    record = {
      ...parsed,
      snapshot:
        typeof parsed.snapshotJson === 'string'
          ? (JSON.parse(parsed.snapshotJson) as WebhookRecoveryRecord['snapshot'])
          : parsed.snapshot,
    };
  } catch (cause) {
    throw new Error(`redisWebhookDeliveryRecoveryBackend.${operation}: corrupt record`, { cause });
  }
  assertDeliveryKey(record.key);
  if (
    !record.snapshot ||
    typeof record.snapshotFingerprint !== 'string' ||
    typeof record.storageFingerprint !== 'string' ||
    !Number.isSafeInteger(record.attemptCount) ||
    !Number.isSafeInteger(record.nextAttemptAtMs) ||
    typeof record.leaseOwner !== 'string' ||
    !Number.isSafeInteger(record.leaseVersion) ||
    !Number.isSafeInteger(record.leaseExpiresAtMs)
  ) {
    throw new Error(`redisWebhookDeliveryRecoveryBackend.${operation}: corrupt record`);
  }
  return record;
}
