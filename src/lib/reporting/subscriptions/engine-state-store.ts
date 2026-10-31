/**
 * Durable reporting subscription engine store over the SDK state-store port.
 *
 * The engine shards its state into one CAS document per principal (`max_accounts` slots) and
 * one per (principal, account) (grant history, exceptions, timezone cutovers, gaps and the
 * frozen owed periods), so a principal with many accounts never rewrites one ever-growing
 * row. A PostgreSQL deployment uses the `PostgresStateStore` it already runs for the
 * principal row; no further migration is needed. The subscription version history lives in
 * the principal row and is never pruned, so `prior_versions` can always be answered for
 * retained obligations.
 */
import { ReportingSubscriptionEngineError } from '../../errors';
import { PlatformConfigError } from '../../server/decisioning/runtime/validate-platform';
import { createHash } from 'node:crypto';
import { InMemoryStateStore, type AdcpStateStore } from '../../server/state-store';
import type { PrincipalRef } from '../../server/principal/types';
import type { ReportingSubscriptionEngineStoreV1 } from './engine';

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export const DEFAULT_REPORTING_SUBSCRIPTION_ENGINE_COLLECTION = 'adcp_reporting_subscription_engine';
const MAX_PAGES = 10_000;
const PAGE_SIZE = 500;

/** @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md */
export interface CreateReportingSubscriptionEngineStateStoreOptionsV1 {
  store: AdcpStateStore;
  collection?: string;
  /** Declare durable only when the backend survives process loss (for example `PostgresStateStore`). */
  durability?: 'process-local' | 'durable';
}

interface EngineDocument extends Record<string, unknown> {
  schemaVersion: 2;
  tenantId: string;
  principalId: string;
  key: string;
  value: Record<string, unknown>;
}

function documentId(scope: Readonly<PrincipalRef>, key: string): string {
  return `subscription_engine_${createHash('sha256')
    .update(JSON.stringify([scope.tenantId, scope.principalId, key]))
    .digest('hex')}`;
}

/**
 * {@link ReportingSubscriptionEngineStoreV1} over any `AdcpStateStore` with `getWithVersion` and `putIfMatch`.
 *
 * @experimental Low-level reporting-subscription building block, published from `@adcp/sdk/reporting/advanced`: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function createReportingSubscriptionEngineStateStoreV1(
  options: CreateReportingSubscriptionEngineStateStoreOptionsV1
): ReportingSubscriptionEngineStoreV1 {
  if (!options?.store?.getWithVersion || !options.store.putIfMatch) {
    throw new PlatformConfigError(
      'The reporting subscription engine store requires getWithVersion and putIfMatch. Use a state store that implements both, such as PostgresStateStore.',
      { configField: 'store' }
    );
  }
  if (options.durability === 'durable' && options.store instanceof InMemoryStateStore) {
    throw new PlatformConfigError(
      'InMemoryStateStore cannot be declared durable. Use durable storage, such as PostgresStateStore, or drop durability: "durable".',
      { code: 'REPORTING_STORAGE_NOT_DURABLE', configField: 'durability' }
    );
  }
  const collection = options.collection ?? DEFAULT_REPORTING_SUBSCRIPTION_ENGINE_COLLECTION;
  const store = options.store;

  /** Every document matching `filter`. A truncated walk would drop owed receipts, so it fails closed. */
  async function listAll(filter: Record<string, unknown>): Promise<EngineDocument[]> {
    const documents: EngineDocument[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await store.list<EngineDocument>(collection, {
        filter,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const document of result.items) {
        // Backends that ignore `filter` still never leak another tenant's or principal's rows.
        if (Object.entries(filter).every(([field, value]) => document[field] === value)) documents.push(document);
      }
      if (result.nextCursor === undefined) return documents;
      if (result.nextCursor === cursor) {
        throw new ReportingSubscriptionEngineError(
          'SUBSCRIPTION_STATE_CORRUPT',
          'Reporting subscription engine store returned a repeating cursor. Fix the state store list implementation.'
        );
      }
      cursor = result.nextCursor;
    }
    throw new ReportingSubscriptionEngineError(
      'SUBSCRIPTION_STATE_CORRUPT',
      `Reporting subscription engine store did not finish within ${MAX_PAGES} pages; refusing a partial list. Check the state store list implementation.`
    );
  }

  return {
    durability: options.durability ?? 'process-local',
    async get(scope, key) {
      const row = await store.getWithVersion!<EngineDocument>(collection, documentId(scope, key));
      if (!row) return null;
      const document = row.data;
      if (
        document.schemaVersion !== 2 ||
        document.tenantId !== scope.tenantId ||
        document.principalId !== scope.principalId ||
        document.key !== key ||
        !document.value ||
        typeof document.value !== 'object'
      ) {
        throw new ReportingSubscriptionEngineError(
          'SUBSCRIPTION_STATE_CORRUPT',
          'Reporting subscription engine document is malformed or belongs to another principal. Inspect the engine collection for tampering or a shared collection name.'
        );
      }
      return { value: structuredClone(document.value), revision: String(row.version) };
    },
    async put(scope, key, value, expectedRevision) {
      const expected = expectedRevision === null ? null : Number(expectedRevision);
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) {
        throw new ReportingSubscriptionEngineError(
          'SUBSCRIPTION_STATE_CORRUPT',
          'Reporting subscription engine store returned an invalid revision. The state store must return positive integer versions.'
        );
      }
      const document: EngineDocument = {
        schemaVersion: 2,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        key,
        value: structuredClone(value),
      };
      const result = await store.putIfMatch!(collection, documentId(scope, key), document, expected);
      return result.ok ? { outcome: 'applied', revision: String(result.version) } : { outcome: 'conflict' };
    },
    async listKeys(scope) {
      const documents = await listAll({ tenantId: scope.tenantId, principalId: scope.principalId });
      return documents.map(document => document.key);
    },
    async listPrincipals(tenantId) {
      const seen = new Map<string, PrincipalRef>();
      for (const document of await listAll({ tenantId })) {
        if (typeof document.principalId === 'string') {
          seen.set(document.principalId, { tenantId, principalId: document.principalId });
        }
      }
      return [...seen.values()];
    },
  };
}
