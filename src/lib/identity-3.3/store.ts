import { createHash } from 'crypto';
import type { AdcpStateStore } from '../server/state-store';
import { canonicalAgentOrigin } from '../signing/agent-resolver/canonicalize';
import { eTldPlusOne } from '../signing/agent-resolver/etld';
import { IdentityAuthorizationError } from './trust';
import {
  mergeRevocationDetail,
  type MonotonicOriginRevocationStore,
  type OriginRevocationSnapshot,
} from './revocation';
import type { OriginBinding, OriginIdentityStore, IdentityApplication } from './lifecycle';
import type { RevocationDetail } from './types';
interface OperatorLedger extends Record<string, unknown> {
  schemaVersion: 1;
  tenantId: string;
  operator: string;
  bindings: Record<string, OriginBinding>;
  authoritativeTrustSeen?: true;
}
interface OriginRevocations extends Record<string, unknown> {
  schemaVersion: 1;
  tenantId: string;
  origin: string;
  revoked: Record<string, RevocationDetail>;
}
/** CAS-backed stores work with the SDK's PostgresStateStore and custom shared backends. */
export function createIdentity33StateStores(options: {
  store: AdcpStateStore;
  tenantId: string;
  collection?: string;
  /** Separate capacity for bound and unbound origins. Raising limits preserves every existing fact. */
  revocationLimits?: {
    keys?: number;
    origins?: number;
    operatorKeys?: number;
    operatorOrigins?: number;
    originKeys?: number;
  };
}) {
  const { store, tenantId } = options,
    collection = options.collection ?? 'identity33';
  if (!tenantId || tenantId.length > 255 || !store.getWithVersion || !store.putIfMatch)
    throw new TypeError('Identity stores require trusted tenantId and atomic getWithVersion/putIfMatch');
  const revocationLimits = {
    keys: 100000,
    origins: 10000,
    operatorKeys: 16384,
    operatorOrigins: 256,
    originKeys: 16384,
    ...options.revocationLimits,
  };
  if (Object.values(revocationLimits).some(value => !Number.isSafeInteger(value) || value < 1))
    throw new TypeError('Revocation limits must be positive safe integers');
  const id = (kind: string, key: string) =>
    createHash('sha256')
      .update(JSON.stringify([tenantId, kind, key]))
      .digest('hex');
  async function update<T extends Record<string, unknown>>(
    kind: string,
    key: string,
    change: (prior: T | null) => T | Promise<T>
  ): Promise<T> {
    const keyId = id(kind, key);
    for (let attempt = 0; attempt < 10; attempt++) {
      const prior = await store.getWithVersion!<T>(collection, keyId);
      if (prior && prior.data.tenantId !== tenantId) throw new IdentityAuthorizationError();
      const next = await change(prior?.data ?? null);
      if ((await store.putIfMatch!(collection, keyId, next, prior?.version ?? null)).ok) return next;
    }
    throw new IdentityAuthorizationError();
  }
  function operatorOf(origin: string): string | undefined {
    try {
      return eTldPlusOne(origin);
    } catch {
      return undefined;
    }
  }
  async function readLedger(operator: string): Promise<OperatorLedger | null> {
    const row = await store.get<OperatorLedger>(collection, id('operator', operator));
    if (
      row &&
      (row.schemaVersion !== 1 ||
        row.tenantId !== tenantId ||
        row.operator !== operator ||
        !row.bindings ||
        typeof row.bindings !== 'object')
    )
      throw new IdentityAuthorizationError();
    return row;
  }
  async function writeBinding(binding: OriginBinding, quota?: number): Promise<OriginBinding> {
    if (
      canonicalAgentOrigin(binding.origin) !== binding.origin ||
      operatorOf(binding.origin) !== binding.operator ||
      !binding.principalId ||
      !binding.audit?.approvedBy ||
      !binding.audit.reason ||
      !Number.isFinite(Date.parse(binding.audit.approvedAt))
    )
      throw new IdentityAuthorizationError();
    const ledger = await update<OperatorLedger>('operator', binding.operator, prior => {
      if (prior && (prior.schemaVersion !== 1 || prior.operator !== binding.operator || !prior.bindings))
        throw new IdentityAuthorizationError();
      const value: OperatorLedger = prior ?? { schemaVersion: 1, tenantId, operator: binding.operator, bindings: {} };
      const existing = value.bindings[binding.origin];
      if (existing) {
        if (quota !== undefined || JSON.stringify(existing) !== JSON.stringify(binding))
          throw new IdentityAuthorizationError();
        return value;
      }
      if (
        quota !== undefined &&
        (!binding.openAccess ||
          !Number.isInteger(quota) ||
          quota < 1 ||
          Object.values(value.bindings).filter(b => b.openAccess).length >= quota)
      )
        throw new IdentityAuthorizationError();
      return { ...value, bindings: { ...value.bindings, [binding.origin]: structuredClone(binding) } };
    });
    return structuredClone(ledger.bindings[binding.origin]!);
  }
  const identity: OriginIdentityStore = {
    async getBinding(origin) {
      origin = canonicalAgentOrigin(origin);
      const operator = operatorOf(origin);
      if (!operator) return undefined;
      const binding = (await readLedger(operator))?.bindings[origin];
      return binding && structuredClone(binding);
    },
    async bind(binding) {
      await writeBinding(binding);
    },
    bindOpen: (binding, quota) => writeBinding(binding, quota),
    async getApplication(origin) {
      const row = await store.get<Record<string, unknown>>(collection, id('application', canonicalAgentOrigin(origin)));
      if (!row) return undefined;
      if (
        row.tenantId !== tenantId ||
        row.schemaVersion !== 1 ||
        row.origin !== canonicalAgentOrigin(origin) ||
        !row.application
      )
        throw new IdentityAuthorizationError();
      return structuredClone(row.application as IdentityApplication);
    },
    async compareAndSetApplication(origin, expectedRevision, application) {
      origin = canonicalAgentOrigin(origin);
      const keyId = id('application', origin);
      const prior = await store.getWithVersion!(collection, keyId);
      if (prior && (prior.data.tenantId !== tenantId || prior.data.origin !== origin))
        throw new IdentityAuthorizationError();
      const current = prior?.data.application as IdentityApplication | undefined;
      if (current?.revision !== expectedRevision || application.revision !== (expectedRevision ?? 0) + 1) return false;
      return (
        await store.putIfMatch!(
          collection,
          keyId,
          { schemaVersion: 1, tenantId, origin, application: structuredClone(application) },
          prior?.version ?? null
        )
      ).ok;
    },
  };
  const authorityHistory = {
    async has(operator: string) {
      return (await readLedger(eTldPlusOne(operator)))?.authoritativeTrustSeen === true;
    },
    async mark(operator: string) {
      operator = eTldPlusOne(operator);
      await update<OperatorLedger>('operator', operator, prior => ({
        ...(prior ?? { schemaVersion: 1, tenantId, operator, bindings: {} }),
        authoritativeTrustSeen: true,
      }));
    },
  };
  interface RevocationBudget extends Record<string, unknown> {
    schemaVersion: 1;
    tenantId: string;
    origins: Record<string, { operator: string; keys: number; bound?: boolean }>;
    keys: number;
    boundKeys?: number;
  }
  async function reserveRevocationBudget(origin: string, keys: number): Promise<void> {
    const operator = eTldPlusOne(origin);
    const binding = await identity.getBinding(origin);
    const hasBinding = !!binding && !binding.openAccess;
    await update<RevocationBudget>('revocation-budget', 'tenant', prior => {
      const budget = prior ?? { schemaVersion: 1, tenantId, origins: {}, keys: 0 };
      if (
        budget.schemaVersion !== 1 ||
        !budget.origins ||
        !Number.isSafeInteger(budget.keys) ||
        (budget.boundKeys !== undefined && !Number.isSafeInteger(budget.boundKeys))
      )
        throw new IdentityAuthorizationError();
      const previous = budget.origins[origin],
        desired = Math.max(previous?.keys ?? 0, keys),
        delta = desired - (previous?.keys ?? 0),
        bound = previous?.bound === true || hasBinding,
        boundKeys = (budget.boundKeys ?? 0) + (bound ? desired - (previous?.bound ? previous.keys : 0) : 0),
        totalKeys = budget.keys + delta;
      const entries = Object.values(budget.origins),
        pool = entries.filter(entry => (entry.bound === true) === bound),
        owned = pool.filter(entry => entry.operator === operator),
        newPoolMember = !previous || (previous.bound === true) !== bound;
      if (
        (newPoolMember &&
          (pool.length >= revocationLimits.origins || owned.length >= revocationLimits.operatorOrigins)) ||
        (bound ? boundKeys : totalKeys - boundKeys) > revocationLimits.keys ||
        owned.reduce((sum, entry) => sum + entry.keys, 0) + (newPoolMember ? desired : delta) >
          revocationLimits.operatorKeys
      )
        throw new IdentityAuthorizationError();
      return {
        ...budget,
        keys: totalKeys,
        boundKeys,
        origins: { ...budget.origins, [origin]: { operator, keys: desired, bound } },
      };
    });
  }
  const revocations: MonotonicOriginRevocationStore = {
    async get(origin, keyid) {
      origin = canonicalAgentOrigin(origin);
      const row = await store.get<OriginRevocations>(collection, id('revocations', origin));
      if (row && (row.schemaVersion !== 1 || row.tenantId !== tenantId || row.origin !== origin || !row.revoked))
        throw new IdentityAuthorizationError();
      const detail = row && Object.hasOwn(row.revoked, keyid) ? row.revoked[keyid] : undefined;
      return detail && { ...detail };
    },
    async merge(origin, snapshot: OriginRevocationSnapshot) {
      origin = canonicalAgentOrigin(origin);
      if (!snapshot.revoked_kids.length) return; // Empty first-contact lists allocate no permanent row.
      await update<OriginRevocations>('revocations', origin, async prior => {
        if (prior && (prior.schemaVersion !== 1 || prior.origin !== origin || !prior.revoked))
          throw new IdentityAuthorizationError();
        const revoked = { ...(prior?.revoked ?? {}) };
        const additions = new Set(snapshot.revoked_kids.filter(kid => !Object.hasOwn(revoked, kid)));
        if (Object.keys(revoked).length + additions.size > revocationLimits.originKeys)
          throw new IdentityAuthorizationError();
        for (const kid of snapshot.revoked_kids) {
          const previous = Object.hasOwn(revoked, kid) ? revoked[kid] : undefined;
          Object.defineProperty(revoked, kid, {
            value: mergeRevocationDetail(previous, snapshot.revocation_details?.[kid] ?? {}),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        await reserveRevocationBudget(origin, Object.keys(revoked).length);
        return { schemaVersion: 1, tenantId, origin, revoked };
      });
    },
  };
  return { identity, authorityHistory, revocations };
}
