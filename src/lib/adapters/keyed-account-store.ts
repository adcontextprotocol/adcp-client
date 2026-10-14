import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountReferenceKey } from '../core/account-key';
import type { AccountReference } from '../types';
import type { SyncAccountsRequest } from '../types/tools.generated';
import { AdcpError } from '../server/decisioning/async-outcome';
import {
  toWireAccount,
  type Account,
  type AccountStore,
  type ResolveContext,
  type SyncAccountsResultRow,
} from '../server/decisioning/account';
import { syncNaturalKey } from '../server/decisioning/account-contract';

export interface KeyedAccountRecord<TCtxMeta = Record<string, unknown>> {
  key: string;
  account: Account<TCtxMeta>;
}

/** Normalized natural key plus supported commercial fields from the sync entry. */
export type KeyedAccountSyncEntry = Exclude<AccountReference, { account_id: string }> &
  Partial<
    Pick<
      Extract<SyncAccountsRequest['accounts'][number], { brand: unknown }>,
      'billing' | 'payment_terms' | 'billing_entity'
    >
  >;

/** Durable storage without expiry. Transactions MUST serialize a scope across all replicas. */
export interface KeyedAccountBackend<TCtxMeta = Record<string, unknown>> {
  read(scope: string): Promise<KeyedAccountRecord<TCtxMeta>[]>;
  /** Commit records only on success; rollback on rejection. Suitable for DB/KV native transactions. */
  transaction<T>(
    scope: string,
    update: (records: KeyedAccountRecord<TCtxMeta>[]) => Promise<{
      records: KeyedAccountRecord<TCtxMeta>[];
      value: T;
      /** False for a read-only preview; backend must not persist records. */
      commit?: boolean;
    }>
  ): Promise<T>;
}

export interface KeyedAccountStoreOptions<TCtxMeta = Record<string, unknown>> {
  backend: KeyedAccountBackend<TCtxMeta>;
  /** Required namespace per logical seller, including when sharing a backend. */
  namespace: string;
  /** Maximum records per principal. Default 1000. Enforced within the transaction. */
  maxAccountsPerPrincipal?: number;
  /** Maximum serialized bytes per principal. Default 8 MiB. */
  maxBytesPerPrincipal?: number;
  /** Maximum entries per sync batch. Default 100. */
  maxSyncEntries?: number;
  /** Maximum serialized bytes per record. Default 64 KiB. */
  maxAccountBytes?: number;
  /** Stable, authenticated tenant identity. Never derive from buyer request fields or raw tokens. */
  principalKey: (ctx: ResolveContext) => string | undefined;
  /** Receive the framework's secret-free contract diagnostics. */
  onDiagnostic?: AccountStore<TCtxMeta>['onDiagnostic'];
  /** Construct a real account with the supplied deterministic id. No external writes; runs inside a transaction. */
  createAccount: (
    ref: KeyedAccountSyncEntry,
    id: string,
    ctx: ResolveContext
  ) => Account<TCtxMeta> | Promise<Account<TCtxMeta>>;
  /** Optional settings update. Preserve id and natural key; reject unsupported terms with AdcpError. */
  updateAccount?: (
    account: Account<TCtxMeta>,
    entry: KeyedAccountSyncEntry,
    ctx: ResolveContext
  ) => Account<TCtxMeta> | Promise<Account<TCtxMeta>>;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Principal-scoped, additive natural-key account store; no TTL and no implicit commercial acceptance. */
export function createKeyedAccountStore<TCtxMeta = Record<string, unknown>>(
  options: KeyedAccountStoreOptions<TCtxMeta>
): AccountStore<TCtxMeta> {
  if (typeof options.namespace !== 'string' || !options.namespace.trim() || options.namespace.length > 256)
    throw new Error('A seller namespace of 1–256 characters is required.');
  if (typeof options.principalKey !== 'function')
    throw new Error('A stable authenticated principalKey callback is required.');
  const maxAccounts = options.maxAccountsPerPrincipal ?? 1000;
  const maxBytes = options.maxBytesPerPrincipal ?? 8 * 1024 * 1024;
  const maxSyncEntries = options.maxSyncEntries ?? 100;
  const maxAccountBytes = options.maxAccountBytes ?? 64 * 1024;
  if (
    !Number.isSafeInteger(maxAccounts) ||
    maxAccounts < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxSyncEntries) ||
    maxSyncEntries < 1 ||
    !Number.isSafeInteger(maxAccountBytes) ||
    maxAccountBytes < 1
  ) {
    throw new Error('Keyed account storage limits must be positive safe integers.');
  }
  const scopeFor = (ctx?: ResolveContext): string | undefined => {
    if (!ctx) return;
    const principal = options.principalKey(ctx);
    if (!principal) return;
    return digest([options.namespace, principal]);
  };
  let readEpoch = 0;
  const reads = new WeakMap<
    object,
    { epoch: number; scope: string; records: Promise<KeyedAccountRecord<TCtxMeta>[]> }
  >();
  function readForLookup(scope: string, ctx?: ResolveContext): Promise<KeyedAccountRecord<TCtxMeta>[]> {
    if (
      ctx?.toolName === 'sync_accounts' &&
      Array.isArray(ctx.input?.accounts) &&
      ctx.input.accounts.length > maxSyncEntries
    ) {
      throw new AdcpError('INVALID_REQUEST', {
        message: `Split sync_accounts into batches of at most ${maxSyncEntries} entries.`,
      });
    }
    if (ctx?.toolName !== 'sync_accounts' || ctx.provisioning !== false || !ctx.input)
      return options.backend.read(scope);
    const cached = reads.get(ctx.input);
    if (cached && cached.epoch === readEpoch && cached.scope === scope) return cached.records;
    const records = options.backend.read(scope);
    reads.set(ctx.input, { epoch: readEpoch, scope, records });
    return records;
  }
  return {
    resolution: 'implicit',
    strictIdempotency: true,
    onDiagnostic: options.onDiagnostic,
    async resolve(ref, ctx) {
      const scope = scopeFor(ctx);
      if (!scope) return null;
      const records = await readForLookup(scope, ctx);
      if (!ref) return records.length === 1 ? structuredClone(records[0]!.account) : null;
      if ('account_id' in ref) return null;
      const account = records.find(record => record.key === accountReferenceKey(ref))?.account;
      return account ? structuredClone(account) : null;
    },
    async upsert(entries, ctx = {}) {
      const dryRun = ctx.input?.dry_run === true;
      entries = structuredClone(entries);
      const scope = scopeFor(ctx);
      if (entries.length > maxSyncEntries)
        throw new AdcpError('INVALID_REQUEST', {
          message: `Split sync_accounts into batches of at most ${maxSyncEntries} entries.`,
        });
      if (!scope)
        throw new AdcpError('AUTH_REQUIRED', { message: 'Account sync requires an authenticated principal.' });
      if (ctx.input?.delete_missing === true)
        throw new AdcpError('UNSUPPORTED_FEATURE', {
          message: 'The keyed account store does not support delete_missing.',
        });
      const update: Parameters<KeyedAccountBackend<TCtxMeta>['transaction']>[1] = async records => {
        const sizes = records.map(record => Buffer.byteLength(JSON.stringify(record)));
        let byteCount = 2 + Math.max(0, records.length - 1) + sizes.reduce((sum, size) => sum + size, 0);
        const rows: SyncAccountsResultRow[] = [];
        for (const [entryIndex, entry] of entries.entries()) {
          const ref = syncNaturalKey(entry as unknown as Record<string, unknown>);
          if (!ref || 'account_id' in ref)
            throw new AdcpError('UNSUPPORTED_PROVISIONING', {
              message: 'The keyed account store accepts brand + operator natural keys only.',
              field: `accounts[${entryIndex}].account`,
            });
          const domain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
          const countries = ref.brand.countries;
          if (
            !domain.test(ref.brand.domain) ||
            !domain.test(ref.operator) ||
            (countries !== undefined &&
              (!Array.isArray(countries) ||
                countries.length === 0 ||
                countries.some(country => typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) ||
                new Set(countries).size !== countries.length))
          )
            throw new AdcpError('INVALID_REQUEST', {
              message: 'Account keys require lowercase domains and unique uppercase ISO country codes.',
            });
          const key = accountReferenceKey(ref);
          const index = records.findIndex(record => record.key === key);
          const existing = index >= 0 ? records[index]!.account : undefined;
          const id = existing?.id ?? `acct_${digest([scope, key])}`;
          const input = entry as unknown as Record<string, unknown>;
          // Only request-schema commercial fields reach callbacks, each on an independent retry-safe copy.
          const normalizedEntry = structuredClone({
            ...ref,
            ...(input.billing !== undefined && { billing: input.billing }),
            ...(input.payment_terms !== undefined && { payment_terms: input.payment_terms }),
            ...(input.billing_entity !== undefined && { billing_entity: input.billing_entity }),
          }) as KeyedAccountSyncEntry;
          const requestedBilling = normalizedEntry.billing;
          const requestedTerms = normalizedEntry.payment_terms;
          try {
            if (
              [
                'preferred_reporting_protocol',
                'reporting_delivery_configs',
                'notification_configs',
                'destination_billing_entity',
              ].some(field => field in entry)
            )
              throw new AdcpError('UNSUPPORTED_FEATURE', {
                message: 'The keyed account store does not support notification or reporting delivery settings.',
              });
            if ('operator_identity' in entry || 'revision' in entry)
              throw new AdcpError('UNSUPPORTED_FEATURE', {
                message: 'The keyed account store does not support identity reconciliation or revision guards.',
              });
            if ('account' in entry && !existing)
              throw new AdcpError('ACCOUNT_NOT_FOUND', {
                message: 'Settings updates require an existing account.',
              });
            if (
              existing &&
              !options.updateAccount &&
              normalizedEntry.billing_entity !== undefined &&
              !isDeepStrictEqual(normalizedEntry.billing_entity, existing.billing_entity)
            )
              throw new AdcpError('UNSUPPORTED_FEATURE', {
                message: 'Updating billing_entity requires an updateAccount callback.',
              });
            const constructed = existing
              ? options.updateAccount
                ? await options.updateAccount(structuredClone(existing), normalizedEntry, ctx)
                : existing
              : await options.createAccount(normalizedEntry, id, ctx);
            if (constructed.authInfo !== undefined)
              throw new AdcpError('SYNC_FAILED', {
                message: 'Account callback must omit authInfo.',
              });
            const account = JSON.parse(JSON.stringify(constructed)) as Account<TCtxMeta>;
            if (
              account.id !== id ||
              account.authInfo !== undefined ||
              !account.brand ||
              !account.operator ||
              accountReferenceKey(account as unknown as AccountReference) !== key
            ) {
              throw new AdcpError('SYNC_FAILED', {
                message: 'Account callback must preserve the supplied identity and omit authInfo.',
              });
            }
            const wire = toWireAccount(account);
            if (requestedBilling !== undefined && wire.billing !== requestedBilling)
              throw new AdcpError('BILLING_NOT_SUPPORTED', {
                message: 'The seller must accept the requested billing model or reject the account.',
              });
            if (
              (account.status === 'active' || account.payment_terms !== undefined) &&
              requestedTerms !== undefined &&
              wire.payment_terms !== requestedTerms
            )
              throw new AdcpError('PAYMENT_TERMS_NOT_SUPPORTED', {
                message: 'The seller must accept the requested payment_terms or reject the account.',
              });
            if (
              account.status === 'active' &&
              (wire.billing === 'agent' || requestedBilling === 'agent') &&
              (wire.billing === undefined || wire.payment_terms === undefined)
            )
              throw new AdcpError('SYNC_FAILED', {
                message: 'Agent-billed account records must include billing and payment_terms.',
              });
            // Persist the same JSON representation across memory, SQL and KV substrates.
            const persisted = account;
            const candidate = [...records];
            const record = { key, account: persisted };
            const size = Buffer.byteLength(JSON.stringify(record));
            const nextBytes =
              byteCount + size - (index >= 0 ? sizes[index]! : 0) + (index < 0 && records.length > 0 ? 1 : 0);
            if (index >= 0) candidate[index] = record;
            else candidate.push(record);
            if (candidate.length > maxAccounts || nextBytes > maxBytes || size > maxAccountBytes) {
              throw new AdcpError('INVALID_REQUEST', { message: 'Account storage limit reached; contact the seller.' });
            }
            const action = !existing ? 'created' : isDeepStrictEqual(existing, persisted) ? 'unchanged' : 'updated';
            records = candidate;
            byteCount = nextBytes;
            if (index >= 0) sizes[index] = size;
            else sizes.push(size);
            rows.push({ ...wire, brand: ref.brand, operator: ref.operator, action });
          } catch (err) {
            if (!(err instanceof AdcpError)) throw err;
            rows.push({
              brand: ref.brand,
              operator: ref.operator,
              action: 'failed',
              status: existing?.status ?? 'rejected',
              ...(existing && { account_id: existing.id }),
              ...(ref.sandbox !== undefined && { sandbox: ref.sandbox }),
              ...(existing && { billing: toWireAccount(existing).billing, payment_terms: existing.payment_terms }),
              errors: [err.toStructuredError()],
            });
          }
        }
        return { records, value: rows, commit: !dryRun };
      };
      const result = dryRun
        ? (await update(await options.backend.read(scope))).value
        : await options.backend.transaction(scope, update);
      readEpoch++;
      return result as SyncAccountsResultRow[];
    },
    async list(filter, ctx) {
      const scope = scopeFor(ctx);
      if (!scope)
        throw new AdcpError('AUTH_REQUIRED', { message: 'Account listing requires an authenticated principal.' });
      let items = (await options.backend.read(scope)).map(record => record.account);
      if (filter.account !== undefined) {
        const ref = filter.account;
        items = items.filter(account =>
          'account_id' in ref
            ? account.id === ref.account_id
            : accountReferenceKey(account as unknown as AccountReference) === accountReferenceKey(ref)
        );
      }
      if (filter.status !== undefined) items = items.filter(account => account.status === filter.status);
      if (filter.sandbox !== undefined) items = items.filter(account => (account.sandbox === true) === filter.sandbox);
      const fingerprint = digest([scope, filter.account, filter.status, filter.sandbox]);
      let offset = 0;
      if (filter.pagination?.cursor !== undefined) {
        try {
          const cursor = JSON.parse(Buffer.from(filter.pagination.cursor, 'base64url').toString());
          if (cursor.scope !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
            throw new Error();
          offset = cursor.offset;
        } catch {
          throw new AdcpError('INVALID_REQUEST', { message: 'Invalid account pagination cursor.' });
        }
      }
      const limit = filter.pagination?.max_results ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new AdcpError('INVALID_REQUEST', {
          message: 'pagination.max_results must be between 1 and 100.',
        });
      const nextOffset = offset + limit;
      return {
        items: items.slice(offset, nextOffset),
        totalCount: items.length,
        ...(nextOffset < items.length && {
          nextCursor: Buffer.from(JSON.stringify({ scope: fingerprint, offset: nextOffset })).toString('base64url'),
        }),
      };
    },
  };
}

/** Single-process backend, without expiry. Share one instance across stores to share serialization. */
export function keyedAccountMemoryBackend<TCtxMeta = Record<string, unknown>>(): KeyedAccountBackend<TCtxMeta> {
  const data = new Map<string, KeyedAccountRecord<TCtxMeta>[]>();
  const writes = new Map<string, Promise<unknown>>();
  return {
    async read(scope) {
      return structuredClone(data.get(scope) ?? []);
    },
    async transaction(scope, update) {
      const pending = (writes.get(scope) ?? Promise.resolve()).then(async () => {
        const result = await update(structuredClone(data.get(scope) ?? []));
        if (result.commit !== false) data.set(scope, structuredClone(result.records));
        return result.value;
      });
      const tail = pending.catch(() => {});
      writes.set(scope, tail);
      try {
        return await pending;
      } finally {
        if (writes.get(scope) === tail) writes.delete(scope);
      }
    },
  };
}
