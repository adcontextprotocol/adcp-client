import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accountReferenceKey } from '../core/account-key';
import { defaultImplicitKeyFn } from './implicit-account-store';
import { AdcpError } from '../server/decisioning/async-outcome';
import { toWireAccount } from '../server/decisioning/account';
import { isSandboxOrMockAccount } from '../server/account-mode';
import { isolateAccountCallbackInput } from '../server/account-sync-contract';
import type { Account, AccountStore, ResolveContext, SyncAccountsResultRow } from '../server/decisioning/account';
import type { AccountReference, ListAccountsRequest, SyncAccountsRequest } from '../types';
import type { KeyedAccountBackend, KeyedAccountRecord } from './keyed-account-backend';

export interface KeyedAccountStoreOptions<TCtxMeta = Record<string, unknown>> {
  backend: KeyedAccountBackend<TCtxMeta>;
  /** Trusted namespace for this seller/deployment; required even with a shared backend. */
  namespace: string;
  resolution?: 'explicit' | 'implicit';
  /** Maximum records per authenticated principal. Default 1000. */
  maxAccounts?: number;
  /** Stable, non-secret authorization partition. Must be deterministic; may run several times per request. Defaults to the authenticated credential identity. */
  principalKey?: (ctx?: ResolveContext) => string | undefined | Promise<string | undefined>;
  /**
   * Accept/reject commercial terms and return the real account record.
   * MUST use accountId as its ID. May run again after a concurrent CAS;
   * upstream side effects must be idempotent on accountId. Never persist
   * credentials in ctx_metadata (authInfo is stripped automatically).
   * When dryRun is true, preview only: no upstream writes or other side effects.
   */
  buildAccount: (
    ref: SyncAccountsRequest['accounts'][number],
    context: {
      accountId: string;
      existing: Account<TCtxMeta> | null;
      dryRun: boolean;
      ctx?: ResolveContext;
    }
  ) => Account<TCtxMeta> | Promise<Account<TCtxMeta>>;
}

function entryRef(entry: AccountReference): AccountReference {
  return (entry as unknown as { account?: AccountReference }).account ?? entry;
}
function recordFor<T>(records: KeyedAccountRecord<T>[], ref: AccountReference): KeyedAccountRecord<T> | undefined {
  return 'account_id' in ref
    ? records.find(row => row.account.id === ref.account_id)
    : records.find(row => row.key === accountReferenceKey(ref));
}
function resultRow<T>(account: Account<T>, action: SyncAccountsResultRow['action']): SyncAccountsResultRow {
  // The generated Account type still permits this request-only staging field;
  // sync result types explicitly prohibit it even when spreading a wire account.
  const { destination_billing_entity: _destination, ...wire } = toWireAccount(account);
  return { ...wire, brand: account.brand!, operator: account.operator!, action };
}

/** Durable natural-key identity, additive syncs, principal isolation, no TTL. */
export function createKeyedAccountStore<TCtxMeta = Record<string, unknown>>(
  options: KeyedAccountStoreOptions<TCtxMeta>
): AccountStore<TCtxMeta> {
  if (!options.namespace) throw new TypeError('A keyed account store requires a namespace');
  const maxAccounts = options.maxAccounts ?? 1000;
  if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1)
    throw new TypeError('maxAccounts must be a positive integer');
  const principalKey =
    options.principalKey ?? (ctx => (ctx?.authInfo ? defaultImplicitKeyFn(ctx.authInfo) : undefined));
  const scopeFor = async (ctx?: ResolveContext): Promise<string> => {
    const principal = await principalKey(options.principalKey && ctx ? isolateAccountCallbackInput(ctx) : ctx);
    if (typeof principal !== 'string' || !principal.trim())
      throw new AdcpError('AUTH_MISSING', {
        message: 'An authenticated account principal is required.',
        recovery: 'terminal',
      });
    return JSON.stringify([options.namespace, principal]);
  };
  return {
    resolution: options.resolution ?? 'explicit',
    strictIdempotency: true,
    async resolve(ref, ctx) {
      const records = (await options.backend.load(await scopeFor(ctx)))?.records ?? [];
      return ref ? (recordFor(records, ref)?.account ?? null) : records.length === 1 ? records[0]!.account : null;
    },
    async upsert(entries, ctx) {
      const dryRun = ctx?.input?.dry_run === true;
      const deleteMissing = ctx?.input?.delete_missing === true;
      const input = ctx?.input === undefined ? undefined : structuredClone(ctx.input);
      entries = structuredClone(entries);
      const scope = await scopeFor(ctx);
      if (deleteMissing)
        throw new AdcpError('UNSUPPORTED_FEATURE', {
          message: 'The keyed account store uses additive syncs; close accounts explicitly.',
          recovery: 'terminal',
        });
      // A bounded CAS retry prevents lost updates across processes. All
      // entries, including repeats within a batch, see the previous entry.
      for (let attempt = 0; attempt < 10; attempt++) {
        const snapshot = await options.backend.load(scope);
        const records = structuredClone(snapshot?.records ?? []);
        const rows: SyncAccountsResultRow[] = [];
        // Unknown ID-keyed entries have no authorized brand/operator to
        // echo in this interface's failed rows. Refuse before any callbacks.
        for (const entry of entries) {
          const ref = entryRef(entry);
          if ('account_id' in ref && !recordFor(records, ref))
            throw new AdcpError('ACCOUNT_NOT_FOUND', { message: 'Account not found', recovery: 'terminal' });
        }
        for (const entry of entries) {
          const ref = entryRef(entry);
          const hit = recordFor(records, ref);
          const source = (hit?.ref ?? ref) as Extract<AccountReference, { brand: unknown }>;
          // Persist only the identity, never the request's webhook credentials.
          const natural = {
            brand: source.brand,
            operator: source.operator,
            ...(source.operator_unit !== undefined && { operator_unit: source.operator_unit }),
            ...(source.currency !== undefined && { currency: source.currency }),
            ...(source.timezone !== undefined && { timezone: source.timezone }),
            ...(source.sandbox !== undefined && { sandbox: source.sandbox }),
          };
          const key = accountReferenceKey(natural);
          const accountId =
            hit?.account.id ??
            `acct_${createHash('sha256')
              .update(JSON.stringify([scope, key]))
              .digest('hex')}`;
          try {
            if (!hit && records.length >= maxAccounts)
              throw new AdcpError('INVALID_REQUEST', {
                message: 'The account limit for this principal has been reached.',
                recovery: 'correctable',
              });
            if ('account' in entry && !hit)
              throw new AdcpError('UNSUPPORTED_PROVISIONING', {
                message: 'Settings updates require an existing account.',
                recovery: 'correctable',
              });
            if ('operator_identity' in entry)
              throw new AdcpError('UNSUPPORTED_FEATURE', {
                message: 'The keyed account store does not implement identity reconciliation.',
                recovery: 'terminal',
              });
            const built = await options.buildAccount(
              structuredClone(entry) as unknown as SyncAccountsRequest['accounts'][number],
              {
                accountId,
                existing: hit ? structuredClone(hit.account) : null,
                dryRun,
                ctx: ctx && isolateAccountCallbackInput({ ...ctx, ...(input !== undefined && { input }) }),
              }
            );
            if (built.id !== accountId) throw new Error('buildAccount must preserve the supplied accountId');
            const { authInfo: _authInfo, ...persisted } = built;
            const account: Account<TCtxMeta> = JSON.parse(
              JSON.stringify({
                ...persisted,
                brand: natural.brand,
                operator: natural.operator,
              })
            );
            if (natural.sandbox === true && !isSandboxOrMockAccount(account))
              throw new AdcpError('UNSUPPORTED_FEATURE', {
                message: 'The seller did not authorize a sandbox account.',
                recovery: 'terminal',
              });
            const request = entry as unknown as { payment_terms?: string; billing?: string };
            if (request.billing === 'agent' && account.billing?.invoicedTo !== 'agent') {
              throw new AdcpError('BILLING_NOT_SUPPORTED', {
                message: 'The seller did not accept agent billing.',
                recovery: 'correctable',
              });
            }
            if (
              account.status === 'active' &&
              request.payment_terms !== undefined &&
              account.payment_terms !== request.payment_terms
            ) {
              throw new AdcpError('PAYMENT_TERMS_NOT_SUPPORTED', {
                message: 'The seller did not accept the requested payment terms.',
                recovery: 'correctable',
              });
            }
            if (account.billing?.invoicedTo === 'agent' && account.payment_terms === undefined) {
              throw new AdcpError('PAYMENT_TERMS_NOT_SUPPORTED', {
                message: 'Agent-billed accounts require explicit payment terms.',
                recovery: 'correctable',
              });
            }
            const action = !hit ? 'created' : isDeepStrictEqual(hit.account, account) ? 'unchanged' : 'updated';
            rows.push(resultRow(account, action));
            const record = { key, ref: natural, account };
            if (hit) records[records.indexOf(hit)] = record;
            else records.push(record);
          } catch (error) {
            if (!(error instanceof AdcpError)) throw error;
            rows.push({
              brand: natural.brand,
              operator: natural.operator,
              ...(hit && { account_id: hit.account.id }),
              action: 'failed',
              status: hit?.account.status ?? 'rejected',
              errors: [error.toStructuredError()],
            });
          }
        }
        if (dryRun || isDeepStrictEqual(snapshot?.records ?? [], records)) return rows;
        if (await options.backend.compareAndSwap(scope, snapshot?.version ?? null, records)) return rows;
      }
      throw new AdcpError('CONFLICT', {
        message: 'Concurrent account sync; retry the request.',
        recovery: 'correctable',
      });
    },
    async list(request: ListAccountsRequest, ctx) {
      const scope = await scopeFor(ctx);
      const snapshot = await options.backend.load(scope);
      let records = snapshot?.records ?? [];
      if (request.account) records = records.filter(record => recordFor([record], request.account!) !== undefined);
      if (request.status) records = records.filter(record => record.account.status === request.status);
      if (request.sandbox !== undefined)
        records = records.filter(record => isSandboxOrMockAccount(record.account) === request.sandbox);
      const cursor = request.pagination?.cursor;
      let offset = 0;
      if (cursor !== undefined) {
        try {
          const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          const binding = createHash('sha256')
            .update(JSON.stringify([scope, snapshot?.version, request.account, request.status, request.sandbox]))
            .digest('hex');
          if (parsed.binding !== binding || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0)
            throw new Error();
          offset = parsed.offset;
        } catch {
          throw new AdcpError('INVALID_REQUEST', {
            message: 'Invalid or stale account cursor.',
            recovery: 'correctable',
          });
        }
      }
      const limit = request.pagination?.max_results ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new AdcpError('INVALID_REQUEST', {
          message: 'max_results must be a positive integer.',
          recovery: 'correctable',
        });
      const items = records.slice(offset, offset + limit).map(record => record.account);
      const next = offset + items.length;
      const binding = createHash('sha256')
        .update(JSON.stringify([scope, snapshot?.version, request.account, request.status, request.sandbox]))
        .digest('hex');
      return {
        items,
        totalCount: records.length,
        ...(next < records.length && {
          nextCursor: Buffer.from(JSON.stringify({ binding, offset: next })).toString('base64url'),
        }),
      };
    },
  };
}
