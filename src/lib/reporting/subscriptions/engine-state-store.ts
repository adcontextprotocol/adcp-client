/**
 * Durable reporting subscription engine store over the SDK state-store port.
 *
 * Each principal's engine state is one CAS document, so a PostgreSQL deployment uses the
 * `PostgresStateStore` it already runs for the principal row; no further migration is
 * needed. The document holds grant history, exceptions, timezone cutovers, gaps and
 * `max_accounts` slots; the subscription version history lives in the principal row and is
 * never pruned, so `prior_versions` can always be answered for retained obligations.
 */
import { createHash } from 'node:crypto';
import { InMemoryStateStore, type AdcpStateStore } from '../../server/state-store';
import type { PrincipalStoreScope } from '../../server/principal/types';
import type { ReportingSubscriptionEngineStateV1, ReportingSubscriptionEngineStoreV1 } from './engine';

export const DEFAULT_REPORTING_SUBSCRIPTION_ENGINE_COLLECTION = 'adcp_reporting_subscription_engine';
const MAX_PRINCIPAL_PAGES = 10_000;

export interface CreateReportingSubscriptionEngineStateStoreOptionsV1 {
  store: AdcpStateStore;
  collection?: string;
  /** Declare durable only when the backend survives process loss (for example `PostgresStateStore`). */
  durability?: 'process-local' | 'durable';
}

interface EngineDocument extends Record<string, unknown> {
  schemaVersion: 1;
  tenantId: string;
  principalId: string;
  state: ReportingSubscriptionEngineStateV1;
}

function documentId(scope: Readonly<PrincipalStoreScope>): string {
  return `subscription_engine_${createHash('sha256')
    .update(JSON.stringify([scope.tenantId, scope.principalId]))
    .digest('hex')}`;
}

/** {@link ReportingSubscriptionEngineStoreV1} over any `AdcpStateStore` with `getWithVersion` and `putIfMatch`. */
export function createReportingSubscriptionEngineStateStoreV1(
  options: CreateReportingSubscriptionEngineStateStoreOptionsV1
): ReportingSubscriptionEngineStoreV1 {
  if (!options?.store?.getWithVersion || !options.store.putIfMatch) {
    throw new TypeError('The reporting subscription engine store requires getWithVersion and putIfMatch');
  }
  if (options.durability === 'durable' && options.store instanceof InMemoryStateStore) {
    throw new TypeError('InMemoryStateStore cannot be declared durable');
  }
  const collection = options.collection ?? DEFAULT_REPORTING_SUBSCRIPTION_ENGINE_COLLECTION;
  const store = options.store;
  return {
    durability: options.durability ?? 'process-local',
    async get(scope) {
      const row = await store.getWithVersion!<EngineDocument>(collection, documentId(scope));
      if (!row) return null;
      const document = row.data;
      if (
        document.schemaVersion !== 1 ||
        document.tenantId !== scope.tenantId ||
        document.principalId !== scope.principalId ||
        !document.state ||
        typeof document.state !== 'object'
      ) {
        throw new Error('Reporting subscription engine document is malformed or belongs to another principal');
      }
      return { state: structuredClone(document.state), revision: String(row.version) };
    },
    async put(scope, state, expectedRevision) {
      const expected = expectedRevision === null ? null : Number(expectedRevision);
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) {
        throw new Error('Reporting subscription engine store returned an invalid revision');
      }
      const document: EngineDocument = {
        schemaVersion: 1,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        state: structuredClone(state),
      };
      const result = await store.putIfMatch!(collection, documentId(scope), document, expected);
      return result.ok ? { outcome: 'applied', revision: String(result.version) } : { outcome: 'conflict' };
    },
    async listPrincipals() {
      // A truncated list would drop consumers that owe receipts, so every incomplete walk fails closed.
      const scopes: PrincipalStoreScope[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PRINCIPAL_PAGES; page += 1) {
        const result = await store.list<EngineDocument>(collection, {
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const document of result.items) {
          if (typeof document.tenantId === 'string' && typeof document.principalId === 'string') {
            scopes.push({ tenantId: document.tenantId, principalId: document.principalId });
          }
        }
        if (result.nextCursor === undefined) return scopes;
        if (result.nextCursor === cursor) {
          throw new Error('Reporting subscription engine store returned a repeating cursor');
        }
        cursor = result.nextCursor;
      }
      throw new Error(
        `Reporting subscription engine store did not finish within ${MAX_PRINCIPAL_PAGES} pages; refusing a partial list`
      );
    },
  };
}
