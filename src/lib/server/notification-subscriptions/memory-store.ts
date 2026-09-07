import { canonicalJsonSha256 } from '../../utils/jcs';
import type {
  NotificationSubscriptionMatch,
  NotificationSubscriptionScope,
  NotificationSubscriptionSet,
  NotificationSubscriptionStore,
  NotificationSubscriptionStoreReplaceResult,
  StoredNotificationSubscription,
} from './types';

function scopeKey(scope: Readonly<NotificationSubscriptionScope>): string {
  return JSON.stringify([
    scope.kind,
    scope.tenantId,
    scope.principalId,
    scope.kind === 'account' ? scope.accountId : '',
  ]);
}

function cloneSet(set: Readonly<NotificationSubscriptionSet>): NotificationSubscriptionSet {
  return structuredClone(set);
}

function subscriptionsFingerprint(subscriptions: readonly StoredNotificationSubscription[]): string {
  return canonicalJsonSha256(subscriptions);
}

/** Process-local reference store for tests and single-process development. */
export function memoryNotificationSubscriptionStore(): NotificationSubscriptionStore {
  const rows = new Map<string, { set: NotificationSubscriptionSet; fingerprint: string }>();
  return {
    durability: 'process-local',
    async probe() {},
    get(scope) {
      const row = rows.get(scopeKey(scope));
      return row ? cloneSet(row.set) : null;
    },
    replace(args): NotificationSubscriptionStoreReplaceResult {
      const key = scopeKey(args.scope);
      const current = rows.get(key);
      if ((current?.set.generation ?? null) !== args.expectedGeneration) {
        return {
          outcome: 'conflict',
          ...(current && { currentGeneration: current.set.generation }),
        };
      }
      const fingerprint = subscriptionsFingerprint(args.subscriptions);
      if (current?.fingerprint === fingerprint) {
        return { outcome: 'unchanged', set: cloneSet(current.set) };
      }
      const set: NotificationSubscriptionSet = {
        scope: structuredClone(args.scope),
        generation: args.nextGeneration,
        subscriptions: args.subscriptions.map(subscription => structuredClone(subscription)),
      };
      rows.set(key, { set, fingerprint });
      return { outcome: 'applied', set: cloneSet(set) };
    },
    findCandidates(match, limit) {
      const matches: NotificationSubscriptionSet[] = [];
      for (const { set } of rows.values()) {
        if (!scopeMatches(set.scope, match)) continue;
        if (
          !set.subscriptions.some(
            subscription =>
              subscription.active &&
              subscription.proofGeneration === subscription.destinationGeneration &&
              (subscription.eventTypes.includes(match.eventType) ||
                (match.futureCallerInvalidation === true && subscription.includeFutureEventTypes))
          )
        )
          continue;
        matches.push(cloneSet(set));
        if (matches.length > limit) break;
      }
      return matches;
    },
  };
}

function scopeMatches(
  scope: Readonly<NotificationSubscriptionScope>,
  match: Readonly<NotificationSubscriptionMatch>
): boolean {
  if (scope.tenantId !== match.tenantId) return false;
  if (match.principalId !== undefined && scope.principalId !== match.principalId) return false;
  if (match.anchor === 'caller') return scope.kind === 'caller';
  if (match.accountId === undefined) return false;
  return scope.kind === 'caller' || scope.accountId === match.accountId;
}
