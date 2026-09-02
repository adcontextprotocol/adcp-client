import { randomBytes } from 'node:crypto';
import { ConfigurationError } from '../errors';
import type { RedisBackendClient, RedisLikeClient } from '../server/idempotency';
import { maybeWarnOnSharedRedisPrefix } from '../utils/redis-default-prefix-warn';
import {
  parseWebhookRegistration,
  sameWebhookRegistration,
  webhookRegistrationFingerprint,
  webhookRegistrationStorageDigest,
  validateWebhookRegistrationKey,
  WebhookRegistrationIntegrityError,
  type WebhookRegistration,
  type WebhookRegistrationStore,
} from './webhook-registration';

const DEFAULT_KEY_PREFIX = 'adcp:webhook-registration:v1:';
const MAX_MARK_OR_DELETE_ATTEMPTS = 4;

export interface RedisWebhookRegistrationStoreOptions {
  /** Deployment-unique prefix. Defaults to `adcp:webhook-registration:v1:`. */
  keyPrefix?: string;
  /** Suppress the development warning for the default prefix on Redis db 0. */
  suppressDefaultPrefixWarning?: boolean;
  /** Explicit acknowledgement when the Redis database is deployment-isolated. */
  acknowledgeIsolatedDatabase?: boolean;
}

interface SerializedRegistrationEnvelope {
  version: 1;
  agentId: string;
  operationId: string;
  fingerprint: string;
  /** Exact JSON bytes; Lua must never decode/re-encode epoch-millisecond integers. */
  registration: string;
  expiresAt: string;
  requiresDurableSettlement: 'unset' | 'false' | 'true';
}

interface ScriptOutcome {
  status: string;
  record?: string;
}

const GET_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({status = 'missing'}) end

local decoded_ok, stored = pcall(cjson.decode, raw)
if not decoded_ok or type(stored) ~= 'table' or type(stored.registration) ~= 'string' then
  return cjson.encode({status = 'corrupt'})
end
if stored.version ~= 1 or stored.agentId ~= ARGV[1] or stored.operationId ~= ARGV[2]
   or type(stored.expiresAt) ~= 'string'
   or (stored.requiresDurableSettlement ~= 'unset' and stored.requiresDurableSettlement ~= 'false'
       and stored.requiresDurableSettlement ~= 'true') then
  return cjson.encode({status = 'collision'})
end

local expires_at = tonumber(stored.expiresAt)
if not expires_at then return cjson.encode({status = 'corrupt'}) end
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if expires_at <= now_ms then
  redis.call('DEL', KEYS[1])
  return cjson.encode({status = 'missing'})
end
if redis.call('PTTL', KEYS[1]) < 0 then return cjson.encode({status = 'corrupt'}) end
return cjson.encode({status = 'found', record = raw})
`;

const PUT_IF_ABSENT_SCRIPT = `
local proposed_expires_at = tonumber(ARGV[4])
if not proposed_expires_at then return cjson.encode({status = 'invalid_expiry'}) end
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if proposed_expires_at <= now_ms then return cjson.encode({status = 'expired'}) end

local raw = redis.call('GET', KEYS[1])
if raw then
  local decoded_ok, stored = pcall(cjson.decode, raw)
  if not decoded_ok or type(stored) ~= 'table' or type(stored.registration) ~= 'string' then
    return cjson.encode({status = 'corrupt'})
  end
  if stored.version ~= 1 or stored.agentId ~= ARGV[1] or stored.operationId ~= ARGV[2]
     or type(stored.expiresAt) ~= 'string'
     or (stored.requiresDurableSettlement ~= 'unset' and stored.requiresDurableSettlement ~= 'false'
         and stored.requiresDurableSettlement ~= 'true') then
    return cjson.encode({status = 'collision'})
  end
  local current_expires_at = tonumber(stored.expiresAt)
  if not current_expires_at then return cjson.encode({status = 'corrupt'}) end
  if current_expires_at > now_ms then
    if redis.call('PTTL', KEYS[1]) < 0 then return cjson.encode({status = 'corrupt'}) end
    if stored.fingerprint == ARGV[3] then
      return cjson.encode({status = 'existing', record = raw})
    end
    return cjson.encode({status = 'conflict'})
  end
end

redis.call('SET', KEYS[1], ARGV[5], 'PXAT', ARGV[4])
return cjson.encode({status = 'inserted', record = ARGV[5]})
`;

const MARK_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({status = 'missing'}) end
if raw ~= ARGV[3] then return cjson.encode({status = 'retry'}) end

local decoded_ok, stored = pcall(cjson.decode, raw)
if not decoded_ok or type(stored) ~= 'table' or type(stored.registration) ~= 'string' then
  return cjson.encode({status = 'corrupt'})
end
if stored.version ~= 1 or stored.agentId ~= ARGV[1] or stored.operationId ~= ARGV[2]
   or type(stored.expiresAt) ~= 'string'
   or (stored.requiresDurableSettlement ~= 'unset' and stored.requiresDurableSettlement ~= 'false'
       and stored.requiresDurableSettlement ~= 'true') then
  return cjson.encode({status = 'collision'})
end

local expires_at = tonumber(stored.expiresAt)
if not expires_at then return cjson.encode({status = 'corrupt'}) end
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if expires_at <= now_ms then
  redis.call('DEL', KEYS[1])
  return cjson.encode({status = 'missing'})
end
if redis.call('PTTL', KEYS[1]) < 0 then return cjson.encode({status = 'corrupt'}) end
if stored.requiresDurableSettlement == 'true' then
  return cjson.encode({status = 'marked', record = raw})
end

stored.requiresDurableSettlement = 'true'
local updated = cjson.encode(stored)
redis.call('SET', KEYS[1], updated, 'KEEPTTL')
return cjson.encode({status = 'marked', record = updated})
`;

const DELETE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({status = 'missing'}) end
if raw ~= ARGV[3] then return cjson.encode({status = 'retry'}) end

local decoded_ok, stored = pcall(cjson.decode, raw)
if not decoded_ok or type(stored) ~= 'table' or type(stored.registration) ~= 'string' then
  return cjson.encode({status = 'corrupt'})
end
if stored.version ~= 1 or stored.agentId ~= ARGV[1] or stored.operationId ~= ARGV[2]
   or type(stored.expiresAt) ~= 'string'
   or (stored.requiresDurableSettlement ~= 'unset' and stored.requiresDurableSettlement ~= 'false'
       and stored.requiresDurableSettlement ~= 'true') then
  return cjson.encode({status = 'collision'})
end
redis.call('DEL', KEYS[1])
return cjson.encode({status = 'deleted'})
`;

const PROBE_SCRIPT = `
local redis_time = redis.call('TIME')
local expires_at = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000) + 5000
redis.call('SET', KEYS[1], 'probe-before-marker', 'PXAT', expires_at)
redis.call('SET', KEYS[1], 'probe-after-marker', 'KEEPTTL')
local ttl = redis.call('PTTL', KEYS[1])
redis.call('DEL', KEYS[1])
if ttl <= 0 then return 0 end
return 1
`;

/** Redis-backed trusted webhook registration provenance for multi-replica clients. */
export function redisWebhookRegistrationStore(
  client: RedisBackendClient,
  options: RedisWebhookRegistrationStoreOptions = {}
): WebhookRegistrationStore & { probe(): Promise<void> } {
  const c = client as RedisLikeClient;
  for (const method of ['eval', 'ping'] as const) {
    if (typeof c?.[method] !== 'function') {
      throw new TypeError(`redisWebhookRegistrationStore: client must implement ${method}()`);
    }
  }
  if (options.keyPrefix !== undefined && typeof options.keyPrefix !== 'string') {
    throw new TypeError('redisWebhookRegistrationStore: keyPrefix must be a string');
  }

  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const unsafePrefix = keyPrefix.trim().length === 0 || keyPrefix === DEFAULT_KEY_PREFIX;
  const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (!development && unsafePrefix && !options.acknowledgeIsolatedDatabase) {
    throw new Error(
      'redisWebhookRegistrationStore: production requires a deployment-unique keyPrefix or acknowledgeIsolatedDatabase: true'
    );
  }
  maybeWarnOnSharedRedisPrefix({
    client,
    callerKeyPrefix: options.keyPrefix,
    defaultKeyPrefix: DEFAULT_KEY_PREFIX,
    suppress: options.suppressDefaultPrefixWarning || options.acknowledgeIsolatedDatabase,
    backendName: 'redisWebhookRegistrationStore',
  });

  const redisKey = (agentId: string, operationId: string): string => {
    validateWebhookRegistrationKey(agentId, operationId);
    return `${keyPrefix}${webhookRegistrationStorageDigest(agentId, operationId)}`;
  };

  const runtimeCall = async (
    operation: string,
    script: string,
    keys: string[],
    args: string[]
  ): Promise<ScriptOutcome> => {
    let raw: unknown;
    try {
      raw = await c.eval(script, { keys, arguments: args });
    } catch (cause) {
      throw new Error(`redisWebhookRegistrationStore.${operation}: database operation failed`, { cause });
    }
    if (typeof raw !== 'string') throw corruptStoreError(operation);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corruptStoreError(operation);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corruptStoreError(operation);
    const outcome = parsed as Record<string, unknown>;
    if (typeof outcome.status !== 'string') throw corruptStoreError(operation);
    if (outcome.record !== undefined && typeof outcome.record !== 'string') throw corruptStoreError(operation);
    return outcome as unknown as ScriptOutcome;
  };

  const parseStoredEnvelope = (
    serialized: string,
    expectedKey: Readonly<{ agentId: string; operationId: string }>,
    operation: string
  ): Readonly<WebhookRegistration> => {
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw corruptStoreError(operation);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw corruptStoreError(operation);
    const envelope = value as Partial<SerializedRegistrationEnvelope>;
    if (
      envelope.version !== 1 ||
      envelope.agentId !== expectedKey.agentId ||
      envelope.operationId !== expectedKey.operationId
    ) {
      throw collisionError(operation);
    }
    if (
      typeof envelope.fingerprint !== 'string' ||
      typeof envelope.registration !== 'string' ||
      typeof envelope.expiresAt !== 'string' ||
      (envelope.requiresDurableSettlement !== 'unset' &&
        envelope.requiresDurableSettlement !== 'false' &&
        envelope.requiresDurableSettlement !== 'true')
    ) {
      throw corruptStoreError(operation);
    }
    let storedRegistration: unknown;
    try {
      storedRegistration = JSON.parse(envelope.registration);
    } catch {
      throw corruptStoreError(operation);
    }
    let registration: Readonly<WebhookRegistration>;
    try {
      const parsed = parseWebhookRegistration(storedRegistration, expectedKey);
      if (envelope.expiresAt !== String(parsed.expiresAt) || parsed.requiresDurableSettlement !== undefined) {
        throw new TypeError('Stored registration envelope metadata does not match its record.');
      }
      registration = parseWebhookRegistration({
        ...parsed,
        ...(envelope.requiresDurableSettlement !== 'unset' && {
          requiresDurableSettlement: envelope.requiresDurableSettlement === 'true',
        }),
      });
    } catch {
      throw corruptStoreError(operation);
    }
    if (webhookRegistrationFingerprint(registration) !== envelope.fingerprint) throw corruptStoreError(operation);
    return registration;
  };

  const readRecord = async (
    agentId: string,
    operationId: string,
    operation: string
  ): Promise<{ registration: Readonly<WebhookRegistration>; serialized: string } | undefined> => {
    const key = redisKey(agentId, operationId);
    const outcome = await runtimeCall(operation, GET_SCRIPT, [key], [agentId, operationId]);
    if (outcome.status === 'missing') return undefined;
    if (outcome.status === 'collision') throw collisionError(operation);
    if (outcome.status !== 'found' || outcome.record === undefined) throw corruptStoreError(operation);
    return {
      registration: parseStoredEnvelope(outcome.record, { agentId, operationId }, operation),
      serialized: outcome.record,
    };
  };

  return {
    async probe(): Promise<void> {
      try {
        await c.ping();
        const probeKey = `${keyPrefix}probe:${randomBytes(12).toString('hex')}`;
        const result = await c.eval(PROBE_SCRIPT, { keys: [probeKey], arguments: [] });
        if (Number(result) !== 1) throw new Error('Redis returned an unexpected Lua probe result.');
      } catch (cause) {
        throw new Error('webhook registration store probe failed: Redis is unreachable or lacks required Lua access', {
          cause,
        });
      }
    },

    async get(agentId: string, operationId: string): Promise<Readonly<WebhookRegistration> | undefined> {
      return (await readRecord(agentId, operationId, 'get'))?.registration;
    },

    async putIfAbsent(registration: WebhookRegistration): Promise<void> {
      const proposed = parseWebhookRegistration(registration);
      const expectedKey = { agentId: proposed.agentId, operationId: proposed.operationId } as const;
      const key = redisKey(expectedKey.agentId, expectedKey.operationId);
      const fingerprint = webhookRegistrationFingerprint(proposed);
      const { requiresDurableSettlement, ...registrationWithoutMarker } = proposed;
      const registrationJson = JSON.stringify(registrationWithoutMarker);
      const serialized = JSON.stringify({
        version: 1,
        agentId: expectedKey.agentId,
        operationId: expectedKey.operationId,
        fingerprint,
        registration: registrationJson,
        expiresAt: String(proposed.expiresAt),
        requiresDurableSettlement:
          requiresDurableSettlement === undefined ? 'unset' : requiresDurableSettlement ? 'true' : 'false',
      } satisfies SerializedRegistrationEnvelope);
      const outcome = await runtimeCall(
        'putIfAbsent',
        PUT_IF_ABSENT_SCRIPT,
        [key],
        [expectedKey.agentId, expectedKey.operationId, fingerprint, String(proposed.expiresAt), serialized]
      );
      if (outcome.status === 'conflict') {
        throw new ConfigurationError(
          'Webhook operation is already registered with different trusted provenance.',
          'operationId'
        );
      }
      if (outcome.status === 'expired') {
        throw new ConfigurationError('Cannot persist an expired webhook registration.', 'expiresAt');
      }
      if (outcome.status === 'collision') throw collisionError('putIfAbsent');
      if ((outcome.status !== 'inserted' && outcome.status !== 'existing') || outcome.record === undefined) {
        throw corruptStoreError('putIfAbsent');
      }
      const persisted = parseStoredEnvelope(outcome.record, expectedKey, 'putIfAbsent');
      if (!sameWebhookRegistration(persisted, proposed)) throw collisionError('putIfAbsent');
    },

    async markRequiresDurableSettlement(agentId: string, operationId: string): Promise<void> {
      const key = redisKey(agentId, operationId);
      for (let attempt = 0; attempt < MAX_MARK_OR_DELETE_ATTEMPTS; attempt++) {
        const current = await readRecord(agentId, operationId, 'markRequiresDurableSettlement');
        if (!current) {
          throw new Error('Cannot mark a missing or expired webhook registration for durable settlement.');
        }
        if (current.registration.requiresDurableSettlement === true) return;
        const outcome = await runtimeCall(
          'markRequiresDurableSettlement',
          MARK_SCRIPT,
          [key],
          [agentId, operationId, current.serialized]
        );
        if (outcome.status === 'retry') continue;
        if (outcome.status === 'missing') {
          throw new Error('Cannot mark a missing or expired webhook registration for durable settlement.');
        }
        if (outcome.status === 'collision') throw collisionError('markRequiresDurableSettlement');
        if (outcome.status !== 'marked' || outcome.record === undefined) {
          throw corruptStoreError('markRequiresDurableSettlement');
        }
        const marked = parseStoredEnvelope(outcome.record, { agentId, operationId }, 'markRequiresDurableSettlement');
        if (marked.requiresDurableSettlement !== true || !sameWebhookRegistration(marked, current.registration)) {
          throw corruptStoreError('markRequiresDurableSettlement');
        }
        return;
      }
      throw new Error('Webhook registration changed repeatedly during durable-settlement marking.');
    },

    async delete(agentId: string, operationId: string): Promise<void> {
      const key = redisKey(agentId, operationId);
      for (let attempt = 0; attempt < MAX_MARK_OR_DELETE_ATTEMPTS; attempt++) {
        const current = await readRecord(agentId, operationId, 'delete');
        if (!current) return;
        const outcome = await runtimeCall('delete', DELETE_SCRIPT, [key], [agentId, operationId, current.serialized]);
        if (outcome.status === 'retry') continue;
        if (outcome.status === 'missing' || outcome.status === 'deleted') return;
        if (outcome.status === 'collision') throw collisionError('delete');
        throw corruptStoreError('delete');
      }
      throw new Error('Webhook registration changed repeatedly during deletion.');
    },
  };
}

function corruptStoreError(operation: string): Error {
  return new WebhookRegistrationIntegrityError(
    `redisWebhookRegistrationStore.${operation}: corrupt registration state`
  );
}

function collisionError(operation: string): Error {
  return new WebhookRegistrationIntegrityError(
    `redisWebhookRegistrationStore.${operation}: registration identity collision`
  );
}
