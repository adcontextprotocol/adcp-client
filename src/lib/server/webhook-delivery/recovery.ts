import { randomUUID } from 'node:crypto';
import { canonicalJsonSha256 } from '../../utils/jcs';
import type {
  WebhookAuthentication,
  WebhookDeliveryKey,
  WebhookDeliveryRecovery,
  WebhookDeliveryRecoveryClaim,
  WebhookRecoveredDelivery,
  WebhookDeliverySnapshot,
} from '../webhook-emitter';
import {
  assertDeliveryKey,
  assertLeaseControls,
  assertRetryAfterMs,
  assertWebhookDisposition,
  isWebhookDeliveryTerminalError,
} from './common';

export interface ProtectedWebhookAuthentication {
  /** Encrypted value or opaque secret-manager reference. Must be JSON-safe. */
  protectedValue: unknown;
  /** Stable, non-secret equality token for conflict detection. */
  fingerprint: string;
}

/** Adapter boundary: applications own KMS keys and secret lifecycle. */
export interface WebhookAuthenticationAdapter {
  protect(
    authentication: Exclude<WebhookAuthentication, null>,
    context: Readonly<WebhookAuthenticationContext>
  ): Promise<ProtectedWebhookAuthentication> | ProtectedWebhookAuthentication;
  resolve(
    protectedValue: unknown,
    context: Readonly<WebhookAuthenticationContext>
  ): Promise<WebhookAuthentication> | WebhookAuthentication;
}

/** Retryable failure while calling an application's KMS/secret adapter. */
export class WebhookAuthenticationProtectionError extends Error {
  override readonly name = 'WebhookAuthenticationProtectionError';
}

/** Retryable failure while resolving protected authentication for delivery. */
export class WebhookAuthenticationResolutionError extends Error {
  override readonly name = 'WebhookAuthenticationResolutionError';
}

export interface WebhookAuthenticationContext {
  key: WebhookDeliveryKey;
  url: string;
  /**
   * Domain-separates task payload validation tokens. Undefined is the
   * original transport-authentication context and is intentionally preserved
   * so pending encrypted snapshots remain decryptable across SDK upgrades.
   */
  purpose?: 'payload_token';
  snapshotContextFingerprint: string;
}

export interface StoredWebhookDeliverySnapshot {
  url: string;
  payload: Record<string, unknown>;
  authentication: { kind: 'none' } | { kind: 'protected'; protectedValue: unknown; fingerprint: string };
  /**
   * A top-level task-webhook `token`, protected independently from transport
   * authentication. The cleartext is restored only after a recovery lease is
   * claimed and is never written to the outbox JSON payload.
   */
  payloadToken?: { kind: 'protected'; protectedValue: unknown; fingerprint: string };
  retries: WebhookDeliverySnapshot['retries'];
}

/** Storage-ready snapshot used by transactional outbox coordinators. */
export interface PreparedWebhookDeliverySnapshot {
  snapshot: StoredWebhookDeliverySnapshot;
  snapshotFingerprint: string;
  storageFingerprint: string;
}

export interface PrepareWebhookDeliveryOptions {
  /**
   * Protect and remove the top-level `payload.token` before persistence.
   * This is opt-in because generic webhook payloads may legitimately use a
   * non-secret field with that name.
   */
  protectPayloadToken?: boolean;
}

export interface WebhookRecoveryRecord {
  key: WebhookDeliveryKey;
  snapshot: StoredWebhookDeliverySnapshot;
  snapshotFingerprint: string;
  storageFingerprint: string;
  attemptCount: number;
  nextAttemptAtMs: number;
  leaseOwner: string;
  leaseVersion: number;
  leaseExpiresAtMs: number;
}

export interface WebhookRecoveryLease extends WebhookRecoveredDelivery {
  attemptCount: number;
  nextAttemptAtMs: number;
  leaseOwner: string;
  leaseVersion: number;
  leaseExpiresAtMs: number;
}

export type WebhookRecoveryCheckpointResult = 'inserted' | 'duplicate' | 'conflict';
export interface WebhookRecoveryCheckpointOutcome {
  result: WebhookRecoveryCheckpointResult;
  lease?: WebhookRecoveryRecord;
  settled?: boolean;
}

/** Atomic persistence primitives implemented by PostgreSQL and Redis. */
export interface WebhookDeliveryRecoveryBackend {
  readonly durability: 'durable' | 'process-local';
  probe(): Promise<void>;
  checkpoint(
    key: Readonly<WebhookDeliveryKey>,
    snapshot: Readonly<StoredWebhookDeliverySnapshot>,
    snapshotFingerprint: string,
    storageFingerprint: string,
    initialLease: { ownerToken: string; leaseMs: number }
  ): Promise<WebhookRecoveryCheckpointOutcome>;
  settle(key: Readonly<WebhookDeliveryKey>, disposition: 'delivered' | 'terminal'): Promise<void>;
  claimPending(options: { ownerToken: string; leaseMs: number; limit: number }): Promise<WebhookRecoveryRecord[]>;
  renew(
    lease: Pick<WebhookRecoveryRecord, 'key' | 'leaseOwner' | 'leaseVersion'>,
    leaseMs: number
  ): Promise<number | null>;
  release(
    lease: Pick<WebhookRecoveryRecord, 'key' | 'leaseOwner' | 'leaseVersion'>,
    retryAfterMs: number
  ): Promise<boolean>;
  settleLease(
    lease: Pick<WebhookRecoveryRecord, 'key' | 'leaseOwner' | 'leaseVersion'>,
    disposition: 'delivered' | 'terminal'
  ): Promise<boolean>;
}

export interface DurableWebhookDeliveryRecovery extends WebhookDeliveryRecovery {
  probe(): Promise<void>;
  /**
   * Protect and fingerprint a snapshot without writing it. This is reserved
   * for coordinators that insert the returned value in the same database
   * transaction as their domain mutation.
   */
  prepare(
    key: Readonly<WebhookDeliveryKey>,
    snapshot: Readonly<WebhookDeliverySnapshot>,
    options?: Readonly<PrepareWebhookDeliveryOptions>
  ): Promise<PreparedWebhookDeliverySnapshot>;
  claimPending(options: { ownerToken?: string; leaseMs?: number; limit?: number }): Promise<WebhookRecoveryLease[]>;
  renew(lease: WebhookRecoveryLease, leaseMs?: number): Promise<boolean>;
  release(lease: WebhookRecoveryLease, retryAfterMs?: number): Promise<boolean>;
  settleLease(lease: WebhookRecoveryLease, disposition: 'delivered' | 'terminal'): Promise<boolean>;
}

export interface CreateWebhookDeliveryRecoveryOptions {
  backend: WebhookDeliveryRecoveryBackend;
  /** Required when a snapshot carries bearer or HMAC credentials. */
  authenticationAdapter?: WebhookAuthenticationAdapter;
  defaultLeaseMs?: number;
  /** Maximum serialized durable snapshot size. Defaults to 2 MiB. */
  maxSnapshotBytes?: number;
}

/** Process-local recovery backend for contract tests and development only. */
export function memoryWebhookDeliveryRecoveryBackend(
  options: { now?: () => number } = {}
): WebhookDeliveryRecoveryBackend {
  type State = WebhookRecoveryRecord & { state: 'pending' | 'settled'; disposition?: 'delivered' | 'terminal' };
  const records = new Map<string, State>();
  const now = options.now ?? Date.now;
  const id = (key: Readonly<WebhookDeliveryKey>) =>
    JSON.stringify([key.publisherScope, key.tenantScope, key.deliveryId]);
  return {
    durability: 'process-local',
    async probe() {},
    async checkpoint(key, snapshot, snapshotFingerprint, storageFingerprint, initialLease) {
      assertDeliveryKey(key);
      assertLeaseControls(initialLease.ownerToken, initialLease.leaseMs);
      const existing = records.get(id(key));
      if (existing) {
        if (existing.snapshotFingerprint !== snapshotFingerprint) return { result: 'conflict' };
        if (existing.state === 'settled') return { result: 'duplicate', settled: true };
        if (existing.leaseExpiresAtMs >= now()) return { result: 'duplicate' };
        existing.leaseOwner = initialLease.ownerToken;
        existing.leaseVersion++;
        existing.leaseExpiresAtMs = now() + initialLease.leaseMs;
        existing.attemptCount++;
        return { result: 'duplicate', lease: structuredClone(existing) };
      }
      const stored: State = {
        key: { ...key },
        snapshot: structuredClone(snapshot),
        snapshotFingerprint,
        storageFingerprint,
        state: 'pending',
        attemptCount: 1,
        nextAttemptAtMs: now(),
        leaseOwner: initialLease.ownerToken,
        leaseVersion: 1,
        leaseExpiresAtMs: now() + initialLease.leaseMs,
      };
      records.set(id(key), stored);
      return { result: 'inserted', lease: structuredClone(stored) };
    },
    async settle(key, disposition) {
      assertWebhookDisposition(disposition);
      const record = records.get(id(key));
      if (record) {
        record.state = 'settled';
        record.disposition = disposition;
        record.leaseOwner = '';
        record.leaseExpiresAtMs = 0;
      }
    },
    async claimPending({ ownerToken, leaseMs, limit }) {
      assertLeaseControls(ownerToken, leaseMs, limit);
      const claimed: WebhookRecoveryRecord[] = [];
      for (const record of records.values()) {
        if (claimed.length >= limit) break;
        if (record.state !== 'pending' || record.nextAttemptAtMs > now() || record.leaseExpiresAtMs >= now()) continue;
        record.leaseOwner = ownerToken;
        record.leaseVersion++;
        record.leaseExpiresAtMs = now() + leaseMs;
        record.attemptCount++;
        claimed.push(structuredClone(record));
      }
      return claimed;
    },
    async renew(lease, leaseMs) {
      assertLeaseControls(lease.leaseOwner, leaseMs);
      const record = records.get(id(lease.key));
      if (!record || !owns(record, lease, now())) return null;
      record.leaseExpiresAtMs = now() + leaseMs;
      return record.leaseExpiresAtMs;
    },
    async release(lease, retryAfterMs) {
      assertLeaseControls(lease.leaseOwner, 1);
      assertRetryAfterMs(retryAfterMs);
      const record = records.get(id(lease.key));
      if (!record || !owns(record, lease, now())) return false;
      record.leaseOwner = '';
      record.leaseExpiresAtMs = 0;
      record.nextAttemptAtMs = now() + retryAfterMs;
      return true;
    },
    async settleLease(lease, disposition) {
      assertLeaseControls(lease.leaseOwner, 1);
      assertWebhookDisposition(disposition);
      const record = records.get(id(lease.key));
      if (!record || !owns(record, lease, now())) return false;
      record.state = 'settled';
      record.disposition = disposition;
      record.leaseOwner = '';
      record.leaseExpiresAtMs = 0;
      return true;
    },
  };
}

function owns(
  record: (WebhookRecoveryRecord & { state: 'pending' | 'settled' }) | undefined,
  lease: Pick<WebhookRecoveryRecord, 'leaseOwner' | 'leaseVersion'>,
  notExpiredAt?: number
): boolean {
  return Boolean(
    record &&
    record.state === 'pending' &&
    record.leaseOwner === lease.leaseOwner &&
    record.leaseVersion === lease.leaseVersion &&
    (notExpiredAt === undefined || record.leaseExpiresAtMs >= notExpiredAt)
  );
}

export function createWebhookDeliveryRecovery(
  options: CreateWebhookDeliveryRecoveryOptions
): DurableWebhookDeliveryRecovery {
  const defaultLeaseMs = options.defaultLeaseMs ?? 30_000;
  assertLeaseMs(defaultLeaseMs);
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > 16 * 1024 * 1024) {
    throw new TypeError('maxSnapshotBytes must be an integer from 1 through 16777216');
  }
  if (options.backend.durability !== 'durable') {
    throw new TypeError('createWebhookDeliveryRecovery requires a durable backend');
  }

  return {
    durability: 'durable',
    probe: () => options.backend.probe(),
    async prepare(key, snapshot, prepareOptions): Promise<PreparedWebhookDeliverySnapshot> {
      assertDeliveryKey(key);
      const stored = await protectSnapshot(
        snapshot,
        key,
        options.authenticationAdapter,
        prepareOptions?.protectPayloadToken === true
      );
      assertStoredSnapshotSize(stored, maxSnapshotBytes);
      return {
        snapshot: stored,
        snapshotFingerprint: snapshotFingerprint(stored),
        storageFingerprint: canonicalJsonSha256(stored),
      };
    },
    async checkpoint(key, snapshot): Promise<void | WebhookDeliveryRecoveryClaim> {
      assertDeliveryKey(key);
      const stored = await protectSnapshot(snapshot, key, options.authenticationAdapter, false);
      assertStoredSnapshotSize(stored, maxSnapshotBytes);
      const fingerprint = snapshotFingerprint(stored);
      const storageFingerprint = canonicalJsonSha256(stored);
      const ownerToken = randomUUID();
      const outcome = await options.backend.checkpoint(key, stored, fingerprint, storageFingerprint, {
        ownerToken,
        leaseMs: defaultLeaseMs,
      });
      if (outcome.result === 'conflict') {
        throw new Error('Webhook recovery snapshot conflicts with an existing delivery identity.');
      }
      if (!outcome.lease) {
        if (outcome.settled) return;
        throw new Error('Webhook recovery delivery is already leased by another worker.');
      }
      return liveClaim(options.backend, outcome.lease, defaultLeaseMs);
    },
    settle: (key, disposition) => {
      assertWebhookDisposition(disposition);
      return options.backend.settle(key, disposition);
    },
    async claimPending(claimOptions): Promise<WebhookRecoveryLease[]> {
      const ownerToken = claimOptions.ownerToken ?? randomUUID();
      if (typeof ownerToken !== 'string' || ownerToken.length < 8 || ownerToken.length > 255) {
        throw new TypeError('ownerToken must be an 8-255 character string');
      }
      const leaseMs = claimOptions.leaseMs ?? defaultLeaseMs;
      const limit = claimOptions.limit ?? 50;
      assertLeaseMs(leaseMs);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new TypeError('limit must be an integer from 1 through 1000');
      }
      const records = await options.backend.claimPending({ ownerToken, leaseMs, limit });
      return Promise.all(
        records.map(async record => {
          assertRecordIntegrity(record);
          const snapshot = await resolveSnapshot(record.snapshot, record.key, options.authenticationAdapter);
          return recoveredLease(options.backend, record, snapshot, leaseMs);
        })
      );
    },
    async renew(lease, leaseMs = defaultLeaseMs): Promise<boolean> {
      assertLeaseMs(leaseMs);
      const expiresAt = await options.backend.renew(lease, leaseMs);
      if (expiresAt === null) return false;
      lease.leaseExpiresAtMs = expiresAt;
      return true;
    },
    release: (lease, retryAfterMs = 0) => {
      if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 604_800_000) {
        throw new TypeError('retryAfterMs must be an integer from 0 through 604800000');
      }
      return options.backend.release(lease, retryAfterMs);
    },
    settleLease: (lease, disposition) => {
      assertWebhookDisposition(disposition);
      return options.backend.settleLease(lease, disposition);
    },
  };
}

export interface PollWebhookDeliveryRecoveryOptions {
  recovery: DurableWebhookDeliveryRecovery;
  ownerToken?: string;
  leaseMs?: number;
  limit?: number;
  /** Delay after a thrown retryable error. Defaults to 1000ms to prevent hot loops. */
  errorRetryAfterMs?: number;
  /** Operational error hook. Hook failures are isolated from lease ownership. */
  onError?: (error: unknown, lease: WebhookRecoveryLease) => void;
  /**
   * Return a relative retry delay. Terminal delivery errors are fenced-settled automatically.
   * The callback MUST enforce an abortable timeout appropriate for its transport. The poller
   * cannot safely time out a still-running side effect and release its lease for another worker.
   */
  deliver(
    lease: WebhookRecoveryLease
  ): Promise<{ disposition: 'delivered' | 'terminal' } | { disposition: 'retry'; retryAfterMs: number }>;
}

/** Run one bounded recovery poll. Scheduling and operational policy remain application-owned. */
export async function pollWebhookDeliveryRecovery(options: PollWebhookDeliveryRecoveryOptions): Promise<{
  claimed: number;
  settled: number;
  released: number;
}> {
  const limit = options.limit ?? 50;
  const leaseMs = options.leaseMs ?? 30_000;
  const ownerToken = options.ownerToken ?? randomUUID();
  const errorRetryAfterMs = options.errorRetryAfterMs ?? 1_000;
  if (!Number.isSafeInteger(errorRetryAfterMs) || errorRetryAfterMs < 1 || errorRetryAfterMs > 604_800_000) {
    throw new TypeError('errorRetryAfterMs must be an integer from 1 through 604800000');
  }
  let settled = 0;
  let released = 0;
  let claimed = 0;
  const seen = new Set<string>();
  const reportError = (error: unknown, lease: WebhookRecoveryLease) => {
    try {
      options.onError?.(error, lease);
    } catch {
      // Observability integrations must not change durable lease semantics.
    }
  };
  const reportLeaseLoss = (lease: WebhookRecoveryLease) => {
    reportError(new Error('Webhook recovery lease ownership was lost during renewal'), lease);
  };
  for (let index = 0; index < limit; index++) {
    const [lease] = await options.recovery.claimPending({ ownerToken, leaseMs, limit: 1 });
    if (!lease) break;
    claimed++;
    const identity = JSON.stringify([lease.key.publisherScope, lease.key.tenantScope, lease.key.deliveryId]);
    if (seen.has(identity)) {
      if (await options.recovery.release(lease, errorRetryAfterMs)) released++;
      break;
    }
    seen.add(identity);
    try {
      if (!(await options.recovery.renew(lease, leaseMs))) {
        reportLeaseLoss(lease);
        continue;
      }
    } catch (error) {
      reportError(error, lease);
      continue;
    }
    let active = true;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeat = setInterval(
      () => {
        if (!active || heartbeatInFlight) return;
        heartbeatInFlight = options.recovery
          .renew(lease, leaseMs)
          .then(ok => {
            if (!ok) {
              active = false;
              reportLeaseLoss(lease);
            }
          })
          .catch(error => {
            active = false;
            reportError(error, lease);
          })
          .finally(() => {
            heartbeatInFlight = undefined;
          });
      },
      Math.max(250, Math.floor(leaseMs / 3))
    );
    heartbeat.unref?.();
    let outcome: { disposition: 'delivered' | 'terminal' } | { disposition: 'retry'; retryAfterMs: number } | undefined;
    let deliveryError: unknown;
    let deliveryFailed = false;
    try {
      outcome = await options.deliver(lease);
      assertPollOutcome(outcome);
    } catch (error) {
      deliveryFailed = true;
      deliveryError = error;
      reportError(error, lease);
    } finally {
      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
    }
    if (!active) continue;
    try {
      if (!(await options.recovery.renew(lease, leaseMs))) {
        reportLeaseLoss(lease);
        continue;
      }
    } catch (error) {
      reportError(error, lease);
      continue;
    }
    if (deliveryFailed) {
      if (isWebhookDeliveryTerminalError(deliveryError)) {
        if (await options.recovery.settleLease(lease, 'terminal')) settled++;
      } else if (await options.recovery.release(lease, errorRetryAfterMs)) {
        released++;
      }
    } else if (outcome?.disposition === 'retry') {
      assertRetryAfterMs(outcome.retryAfterMs);
      if (await options.recovery.release(lease, Math.max(1, outcome.retryAfterMs))) released++;
    } else if (outcome && (await options.recovery.settleLease(lease, outcome.disposition))) {
      settled++;
    }
  }
  return { claimed, settled, released };
}

function assertPollOutcome(
  outcome: unknown
): asserts outcome is { disposition: 'delivered' | 'terminal' } | { disposition: 'retry'; retryAfterMs: number } {
  if (typeof outcome !== 'object' || outcome === null) {
    throw new TypeError('Webhook recovery deliver() must return a disposition outcome');
  }
  const candidate = outcome as { disposition?: unknown; retryAfterMs?: unknown };
  if (candidate.disposition === 'retry') {
    assertRetryAfterMs(candidate.retryAfterMs as number);
    return;
  }
  if (candidate.disposition !== 'delivered' && candidate.disposition !== 'terminal') {
    throw new TypeError('Webhook recovery deliver() returned an invalid disposition');
  }
}

async function protectSnapshot(
  snapshot: Readonly<WebhookDeliverySnapshot>,
  key: Readonly<WebhookDeliveryKey>,
  adapter: WebhookAuthenticationAdapter | undefined,
  protectPayloadToken: boolean
): Promise<StoredWebhookDeliverySnapshot> {
  const payload = structuredClone(snapshot.payload);
  const cleartextPayloadToken = protectPayloadToken && typeof payload.token === 'string' ? payload.token : undefined;
  if (cleartextPayloadToken !== undefined) delete payload.token;
  const base = {
    url: snapshot.url,
    payload,
    retries: { ...snapshot.retries },
  };
  // Canonicalization validates every stored field as plain JSON.
  canonicalJsonSha256(base);
  if ((snapshot.authentication !== null || cleartextPayloadToken !== undefined) && !adapter) {
    throw new TypeError(
      'Durable webhook recovery requires authenticationAdapter when bearer/HMAC authentication or a payload token is present'
    );
  }
  const stored: StoredWebhookDeliverySnapshot = {
    ...base,
    authentication: { kind: 'none' },
  };
  if (snapshot.authentication !== null) {
    const protectedAuth = await protectAuthentication(
      adapter!,
      structuredClone(snapshot.authentication),
      authenticationContext(key, base)
    );
    stored.authentication = { kind: 'protected', ...protectedAuth };
  }
  if (cleartextPayloadToken !== undefined) {
    const protectedToken = await protectAuthentication(
      adapter!,
      { type: 'bearer', token: cleartextPayloadToken },
      authenticationContext(key, base, 'payload_token')
    );
    stored.payloadToken = { kind: 'protected', ...protectedToken };
  }
  return stored;
}

async function resolveSnapshot(
  snapshot: StoredWebhookDeliverySnapshot,
  key: Readonly<WebhookDeliveryKey>,
  adapter?: WebhookAuthenticationAdapter
): Promise<WebhookDeliverySnapshot> {
  try {
    let authentication: WebhookAuthentication = null;
    if (snapshot.authentication.kind === 'protected') {
      if (!adapter) throw new Error('Cannot recover protected webhook authentication without authenticationAdapter');
      authentication = await adapter.resolve(
        structuredClone(snapshot.authentication.protectedValue),
        authenticationContext(key, snapshot)
      );
      if (authentication === null)
        throw new Error('WebhookAuthenticationAdapter.resolve() returned null for protected state');
    }
    const payload = structuredClone(snapshot.payload);
    if (snapshot.payloadToken) {
      if (!adapter) throw new Error('Cannot recover protected webhook payload token without authenticationAdapter');
      const resolved = await adapter.resolve(
        structuredClone(snapshot.payloadToken.protectedValue),
        authenticationContext(key, snapshot, 'payload_token')
      );
      if (resolved?.type !== 'bearer' || typeof resolved.token !== 'string') {
        throw new Error('WebhookAuthenticationAdapter.resolve() returned an invalid protected payload token');
      }
      payload.token = resolved.token;
    }
    return {
      url: snapshot.url,
      payload,
      authentication,
      retries: { ...snapshot.retries },
    };
  } catch (cause) {
    if (cause instanceof WebhookAuthenticationResolutionError) throw cause;
    throw new WebhookAuthenticationResolutionError('Webhook authentication resolution failed', { cause });
  }
}

function authenticationContext(
  key: Readonly<WebhookDeliveryKey>,
  snapshot: Pick<StoredWebhookDeliverySnapshot, 'url' | 'payload' | 'retries'>,
  purpose?: 'payload_token'
): WebhookAuthenticationContext {
  const base = {
    key: { ...key },
    url: snapshot.url,
  };
  if (purpose === undefined) {
    return {
      ...base,
      // This is the exact pre-payload-token context hash. Do not change it:
      // applications may bind KMS AAD to this value for pending snapshots.
      snapshotContextFingerprint: canonicalJsonSha256({
        key,
        url: snapshot.url,
        payload: snapshot.payload,
        retries: snapshot.retries,
      }),
    };
  }
  return {
    ...base,
    purpose,
    snapshotContextFingerprint: canonicalJsonSha256({
      purpose,
      key,
      url: snapshot.url,
      payload: snapshot.payload,
      retries: snapshot.retries,
    }),
  };
}

function assertRecordIntegrity(record: WebhookRecoveryRecord): void {
  if (canonicalJsonSha256(record.snapshot) !== record.storageFingerprint) {
    throw new Error('Webhook recovery snapshot integrity check failed.');
  }
  if (snapshotFingerprint(record.snapshot) !== record.snapshotFingerprint) {
    throw new Error('Webhook recovery logical fingerprint check failed.');
  }
}

function liveClaim(
  backend: WebhookDeliveryRecoveryBackend,
  record: WebhookRecoveryRecord,
  leaseMs: number
): WebhookDeliveryRecoveryClaim {
  return {
    get leaseExpiresAtMs() {
      return record.leaseExpiresAtMs;
    },
    heartbeatIntervalMs: Math.max(250, Math.min(10_000, Math.floor(leaseMs / 3))),
    set leaseExpiresAtMs(value: number) {
      record.leaseExpiresAtMs = value;
    },
    async renew() {
      const expiresAt = await backend.renew(record, leaseMs);
      if (expiresAt === null) return false;
      record.leaseExpiresAtMs = expiresAt;
      return true;
    },
    release: (retryAfterMs = 0) => backend.release(record, retryAfterMs),
    settle: disposition => backend.settleLease(record, disposition),
  };
}

function recoveredLease(
  backend: WebhookDeliveryRecoveryBackend,
  record: WebhookRecoveryRecord,
  snapshot: WebhookDeliverySnapshot,
  leaseMs: number
): WebhookRecoveryLease {
  const claim = liveClaim(backend, record, leaseMs);
  return {
    ...record,
    snapshot,
    get leaseExpiresAtMs() {
      return record.leaseExpiresAtMs;
    },
    set leaseExpiresAtMs(value: number) {
      record.leaseExpiresAtMs = value;
    },
    renew: claim.renew,
    release: claim.release,
    settle: claim.settle,
  };
}

function snapshotFingerprint(snapshot: StoredWebhookDeliverySnapshot): string {
  return canonicalJsonSha256({
    url: snapshot.url,
    payload: snapshot.payload,
    retries: snapshot.retries,
    authentication:
      snapshot.authentication.kind === 'none'
        ? { kind: 'none' }
        : { kind: 'protected', fingerprint: snapshot.authentication.fingerprint },
    ...(snapshot.payloadToken && { payloadToken: { fingerprint: snapshot.payloadToken.fingerprint } }),
  });
}

async function protectAuthentication(
  adapter: WebhookAuthenticationAdapter,
  authentication: Exclude<WebhookAuthentication, null>,
  context: WebhookAuthenticationContext
): Promise<{ protectedValue: unknown; fingerprint: string }> {
  let protectedAuth: ProtectedWebhookAuthentication;
  try {
    protectedAuth = await adapter.protect(authentication, context);
  } catch (cause) {
    throw new WebhookAuthenticationProtectionError('Webhook authentication protection failed', { cause });
  }
  if (!protectedAuth || typeof protectedAuth.fingerprint !== 'string' || protectedAuth.fingerprint.length < 16) {
    throw new TypeError(
      'WebhookAuthenticationAdapter.protect() must return a stable fingerprint of at least 16 characters'
    );
  }
  canonicalJsonSha256(protectedAuth.protectedValue);
  const cleartext = authentication.type === 'bearer' ? authentication.token : authentication.secret;
  if (cleartext.length < 16) {
    throw new TypeError('Durable webhook credentials must contain at least 16 characters');
  }
  if (
    protectedValueContainsSecret(protectedAuth.protectedValue, cleartext) ||
    protectedAuth.fingerprint.includes(cleartext)
  ) {
    throw new TypeError('WebhookAuthenticationAdapter.protect() returned durable state containing cleartext');
  }
  return {
    protectedValue: structuredClone(protectedAuth.protectedValue),
    fingerprint: protectedAuth.fingerprint,
  };
}

function protectedValueContainsSecret(value: unknown, cleartext: string): boolean {
  if (typeof value === 'string') return value.includes(cleartext);
  if (Array.isArray(value)) return value.some(item => protectedValueContainsSecret(item, cleartext));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, item]) => key.includes(cleartext) || protectedValueContainsSecret(item, cleartext)
    );
  }
  return false;
}

function assertStoredSnapshotSize(snapshot: StoredWebhookDeliverySnapshot, maxSnapshotBytes: number): void {
  const storedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (storedBytes > maxSnapshotBytes) {
    throw new TypeError(`Webhook recovery snapshot exceeds maxSnapshotBytes (${maxSnapshotBytes})`);
  }
}

function assertLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 3_600_000) {
    throw new TypeError('leaseMs must be an integer from 1000 through 3600000');
  }
}
