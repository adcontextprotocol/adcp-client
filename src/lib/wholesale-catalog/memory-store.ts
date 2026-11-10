import type { CatalogScope, CatalogSnapshotStoreV1, CatalogSnapshotV1 } from './types';

/** The key a snapshot is stored under. Custom stores can use it. */
export function catalogScopeKey(scope: Readonly<CatalogScope>): string {
  return scope.cacheScope === 'public' ? 'public' : `account:${scope.accountId}`;
}

/**
 * Process-local snapshot storage for tests and development. It is not shared between instances and does not
 * survive a restart, so production passes a durable store of its own.
 */
export function memoryCatalogSnapshotStore(): CatalogSnapshotStoreV1 {
  const snapshots = new Map<string, CatalogSnapshotV1>();
  return {
    durability: 'process-local',
    async get(scope) {
      // Snapshots are never mutated after they are stored, so a reader needs no copy.
      return snapshots.get(catalogScopeKey(scope));
    },
    async put(snapshot, expectedRevision) {
      const key = catalogScopeKey(snapshot.scope);
      if (snapshots.get(key)?.revision !== expectedRevision) return false;
      snapshots.set(key, structuredClone(snapshot));
      return true;
    },
    async list() {
      return [...snapshots.values()].map(snapshot => structuredClone(snapshot.scope));
    },
  };
}
