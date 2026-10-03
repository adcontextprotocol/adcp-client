import { createHash, randomUUID } from 'node:crypto';
import { InMemoryStateStore, type AdcpStateStore } from '../state-store';
import {
  NotificationSubscriptionValidationError,
  type NotificationSubscriptionMatch,
  type NotificationSubscriptionScope,
  type NotificationSubscriptionSet,
  type NotificationSubscriptionStore,
  type NotificationSubscriptionStoreReplaceResult,
} from '../notification-subscriptions/types';
import { projectStoredNotificationSubscriptionReadback } from '../notification-subscriptions/runtime';
import type {
  PrincipalStateStore,
  PrincipalConfiguration,
  PrincipalStoreScope,
  PrincipalStoreReplaceResult,
  StoredPrincipalRecord,
  VersionedPrincipalRecord,
} from './types';

export const DEFAULT_PRINCIPAL_STORE_COLLECTION = 'adcp_principals';

export interface CreatePrincipalStateStoreOptions {
  store: AdcpStateStore;
  collection?: string;
  /** Set to durable only when the supplied backend survives process loss. */
  durability?: 'process-local' | 'durable';
  /** Observe malformed scanned rows that are skipped during fanout/recovery. */
  onMalformedRecord?: (error: Error) => void;
}

/** @internal Brands the notification projection with its owning principal store. */
export const PRINCIPAL_NOTIFICATION_STORE_OWNER = Symbol('adcp.principalNotificationStoreOwner');
type PrincipalOwnedNotificationStore = NotificationSubscriptionStore & {
  [PRINCIPAL_NOTIFICATION_STORE_OWNER]: PrincipalStateStore;
};

function scopeDocumentId(scope: Readonly<PrincipalStoreScope>): string {
  return `principal_${createHash('sha256')
    .update(JSON.stringify([scope.tenantId, scope.principalId]))
    .digest('hex')}`;
}

function cloneRecord(record: Readonly<StoredPrincipalRecord>): StoredPrincipalRecord {
  return structuredClone(record);
}

function assertRecordScope(record: Readonly<StoredPrincipalRecord>, scope: Readonly<PrincipalStoreScope>): void {
  assertRecordShape(record);
  if (record.tenantId !== scope.tenantId || record.scopePrincipalId !== scope.principalId) {
    throw new Error('Principal store scope mismatch');
  }
}

function assertRecordShape(record: Readonly<StoredPrincipalRecord>): void {
  if (
    record.schemaVersion !== 1 ||
    typeof record.tenantId !== 'string' ||
    typeof record.scopePrincipalId !== 'string' ||
    typeof record.principalId !== 'string' ||
    (record.principalKind !== 'buyer_agent' && record.principalKind !== 'operator') ||
    !Array.isArray(record.notificationSubscriptions) ||
    !Array.isArray(record.reportingGenerations) ||
    !Array.isArray(record.pendingNotifications)
  ) {
    throw new Error('Principal store record is malformed or uses an unsupported schema version');
  }
}

/** CAS-backed principal store over the SDK state-store abstraction. */
export function createPrincipalStateStore(options: CreatePrincipalStateStoreOptions): PrincipalStateStore {
  if (!options?.store) throw new TypeError('createPrincipalStateStore requires store');
  if (!options.store.getWithVersion || !options.store.putIfMatch) {
    throw new TypeError('Principal state requires an AdcpStateStore with getWithVersion and putIfMatch');
  }
  if (options.durability === 'durable' && options.store instanceof InMemoryStateStore) {
    throw new TypeError('InMemoryStateStore cannot be declared durable');
  }
  const collection = options.collection ?? DEFAULT_PRINCIPAL_STORE_COLLECTION;
  const getRecord = async (scope: Readonly<PrincipalStoreScope>): Promise<VersionedPrincipalRecord | null> => {
    const row = await options.store.getWithVersion!<StoredPrincipalRecord>(collection, scopeDocumentId(scope));
    if (!row) return null;
    assertRecordScope(row.data, scope);
    return { record: cloneRecord(row.data), revision: String(row.version) };
  };

  return {
    durability: options.durability ?? 'process-local',
    async get(scope) {
      return getRecord(scope);
    },
    async replace(args): Promise<PrincipalStoreReplaceResult> {
      assertRecordScope(args.record, args.scope);
      const expected = args.expectedRevision === null ? null : parseRevision(args.expectedRevision);
      const result = await options.store.putIfMatch!(
        collection,
        scopeDocumentId(args.scope),
        cloneRecord(args.record),
        expected
      );
      if (!result.ok) {
        return {
          outcome: 'conflict',
          ...(result.currentVersion === null ? {} : { currentRevision: String(result.currentVersion) }),
        };
      }
      return {
        outcome: 'applied',
        value: { record: cloneRecord(args.record), revision: String(result.version) },
      };
    },
    async findNotificationCandidates(match, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new TypeError('principal notification candidate limit must be 1 through 10000');
      }
      const sets: NotificationSubscriptionSet[] = [];
      if (match.principalId !== undefined) {
        const value = await getRecord({ tenantId: match.tenantId, principalId: match.principalId });
        const set = value ? notificationSetFromRecord(value.record) : null;
        return set && setMatches(set, match) ? [set] : [];
      }
      let cursor: string | undefined;
      do {
        const page = await options.store.list<StoredPrincipalRecord>(collection, {
          filter: { tenantId: match.tenantId },
          limit: Math.min(500, limit + 1),
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const record of page.items) {
          try {
            assertRecordShape(record);
          } catch (error) {
            options.onMalformedRecord?.(error instanceof Error ? error : new Error(String(error)));
            continue;
          }
          if (record.tenantId !== match.tenantId) continue;
          const set = notificationSetFromRecord(record);
          if (!set || !setMatches(set, match)) continue;
          sets.push(set);
          if (sets.length > limit) return sets;
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return sets;
    },
    async findPendingNotificationScopes({ limit, cursor: initialCursor }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new TypeError('principal notification recovery limit must be 1 through 10000');
      }
      const scopes: PrincipalStoreScope[] = [];
      const scanLimit = Math.min(10_000, limit * 10);
      let scanned = 0;
      let pages = 0;
      let cursor = initialCursor;
      do {
        const page = await options.store.list<StoredPrincipalRecord>(collection, {
          limit: Math.min(500, limit - scopes.length, scanLimit - scanned),
          ...(cursor === undefined ? {} : { cursor }),
        });
        pages++;
        scanned += page.items.length;
        for (const record of page.items) {
          try {
            assertRecordShape(record);
          } catch (error) {
            options.onMalformedRecord?.(error instanceof Error ? error : new Error(String(error)));
            continue;
          }
          if (!Array.isArray(record.pendingNotifications) || record.pendingNotifications.length === 0) continue;
          scopes.push({ tenantId: record.tenantId, principalId: record.scopePrincipalId });
          if (scopes.length === limit) break;
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined && scopes.length < limit && scanned < scanLimit && pages < 100);
      return {
        scopes,
        ...(cursor === undefined ? {} : { nextCursor: cursor }),
      };
    },
  };
}

function parseRevision(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Principal store returned an invalid revision');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Principal store returned an invalid revision');
  return parsed;
}

function notificationSetFromRecord(record: Readonly<StoredPrincipalRecord>): NotificationSubscriptionSet | null {
  if (!record.notificationGeneration) return null;
  return {
    scope: { kind: 'caller', tenantId: record.tenantId, principalId: record.scopePrincipalId },
    generation: record.notificationGeneration,
    subscriptions: structuredClone(record.notificationSubscriptions),
  };
}

function setMatches(
  set: Readonly<NotificationSubscriptionSet>,
  match: Readonly<NotificationSubscriptionMatch>
): boolean {
  if (set.scope.tenantId !== match.tenantId) return false;
  if (match.anchor === 'account' && match.accountId === undefined) return false;
  return set.subscriptions.some(
    subscription =>
      subscription.active &&
      subscription.proofGeneration === subscription.destinationGeneration &&
      (subscription.eventTypes.includes(match.eventType) ||
        (match.futureCallerInvalidation === true && subscription.includeFutureEventTypes)) &&
      (match.anchor !== 'account' || subscription.allAuthorizedAccounts)
  );
}

/** Notification-runtime projection over the same atomic principal row. */
export function principalNotificationSubscriptionStore(store: PrincipalStateStore): NotificationSubscriptionStore {
  const projection: PrincipalOwnedNotificationStore = {
    [PRINCIPAL_NOTIFICATION_STORE_OWNER]: store,
    durability: store.durability,
    ...(store.probe ? { probe: () => store.probe!() } : {}),
    async get(scope) {
      const principalScope = callerScope(scope);
      const value = await store.get(principalScope);
      return value ? notificationSetFromRecord(value.record) : null;
    },
    async replace(args): Promise<NotificationSubscriptionStoreReplaceResult> {
      const scope = callerScope(args.scope);
      const current = await store.get(scope);
      if (!current) throw new Error('Principal identity must be initialized before replacing notifications');
      if ((current.record.notificationGeneration ?? null) !== args.expectedGeneration) {
        return {
          outcome: 'conflict',
          ...(current.record.notificationGeneration
            ? { currentGeneration: current.record.notificationGeneration }
            : {}),
        };
      }
      const unchanged =
        current.record.notificationGeneration !== undefined &&
        JSON.stringify(current.record.notificationSubscriptions) === JSON.stringify(args.subscriptions);
      if (unchanged) {
        return { outcome: 'unchanged', set: notificationSetFromRecord(current.record)! };
      }
      const record = cloneRecord(current.record);
      record.notificationGeneration = args.nextGeneration;
      record.notificationSubscriptions = args.subscriptions.map(subscription => structuredClone(subscription));
      record.configurationVersion = `cfg_${cryptoRandomId()}`;
      const notificationConfigs = projectStoredNotificationSubscriptionReadback(record.notificationSubscriptions);
      const signingDeclared = record.configuration?.declarations?.declared.webhook_signing_algorithms;
      if (
        signingDeclared &&
        record.notificationSubscriptions.some(subscription => subscription.active) &&
        record.configuration?.declarations?.accepted.webhook_signing_algorithms === undefined
      ) {
        throw new NotificationSubscriptionValidationError(
          'Active webhook subscribers require an accepted webhook signing algorithm',
          'configuration.declarations.webhook_signing_algorithms'
        );
      }
      record.configuration = {
        ...(record.configuration ?? {}),
        notification_configs: notificationConfigs as PrincipalConfiguration['notification_configs'],
      };
      const result = await store.replace({ scope, expectedRevision: current.revision, record });
      if (result.outcome === 'conflict') {
        const latest = await store.get(scope);
        return {
          outcome: 'conflict',
          ...(latest?.record.notificationGeneration ? { currentGeneration: latest.record.notificationGeneration } : {}),
        };
      }
      return { outcome: 'applied', set: notificationSetFromRecord(result.value.record)! };
    },
    findCandidates: (match, limit) => store.findNotificationCandidates(match, limit),
  };
  return projection;
}

function callerScope(scope: Readonly<NotificationSubscriptionScope>): PrincipalStoreScope {
  if (scope.kind !== 'caller') throw new TypeError('Principal notifications require caller scope');
  return { tenantId: scope.tenantId, principalId: scope.principalId };
}

function cryptoRandomId(): string {
  return randomUUID();
}
