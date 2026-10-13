import type { AccountReference, BillingParty } from '../../types/tools.generated';
import { accountReferenceKey } from '../../core/account-key';
import type { AdcpLogger } from '../create-adcp-server';
import { AdcpError } from './async-outcome';
import {
  AccountNotFoundError,
  normalizeAccountResolution,
  type Account,
  type AccountStore,
  type AccountStoreDiagnostic,
  type ResolveContext,
  type SyncAccountsResultRow,
} from './account';

/** Extract just the natural-key reference; never pass commercial fields to resolve. */
export function syncNaturalKey(
  entry: Record<string, unknown>
): Exclude<AccountReference, { account_id: string }> | undefined {
  const ref = (entry.account ?? entry) as Record<string, unknown>;
  if (
    ref.account_id !== undefined ||
    typeof ref.brand !== 'object' ||
    ref.brand === null ||
    Array.isArray(ref.brand) ||
    typeof (ref.brand as Record<string, unknown>).domain !== 'string' ||
    typeof ref.operator !== 'string'
  )
    return;
  const { brand, operator, operator_unit, currency, timezone, sandbox } = ref;
  return {
    brand,
    operator,
    ...(operator_unit !== undefined && { operator_unit }),
    ...(currency !== undefined && { currency }),
    ...(timezone !== undefined && { timezone }),
    ...(sandbox !== undefined && { sandbox }),
  } as Exclude<AccountReference, { account_id: string }>;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Match only fields the response echoes; preserve omitted request subdivisions. */
export function matchingSyncAccountIndices(
  row: Record<string, unknown>,
  entries: readonly Record<string, unknown>[]
): number[] {
  const id = record(row.account).account_id ?? row.account_id;
  if (typeof id === 'string') {
    const ids = entries.flatMap((entry, index) =>
      (record(entry.account).account_id ?? entry.account_id) === id ? [index] : []
    );
    if (ids.length) return ids;
  }
  const echoed = syncNaturalKey(row.account === undefined ? { ...row, account_id: undefined } : row);
  if (!echoed) return [];
  return entries.flatMap((entry, index) => {
    const ref = syncNaturalKey(entry);
    return ref &&
      accountReferenceKey({ ...ref, ...echoed, brand: { ...ref.brand, ...echoed.brand } }) === accountReferenceKey(ref)
      ? [index]
      : [];
  });
}

/** Platform callbacks may reorder rows; align them before policy checks and refused-row reinsertion. */
export function alignSyncAccountRows(
  rows: SyncAccountsResultRow[],
  entries: readonly Record<string, unknown>[],
  existing: readonly (Account | null)[]
): SyncAccountsResultRow[] {
  if (rows.length !== entries.length) return rows;
  const aligned: SyncAccountsResultRow[] = Array(rows.length);
  const used = new Set<number>();
  rows.forEach((row, position) => {
    const candidates = matchingSyncAccountIndices(row as unknown as Record<string, unknown>, entries).filter(
      index => !used.has(index)
    );
    const known = candidates.filter(index => row.account_id !== undefined && existing[index]?.id === row.account_id);
    const index =
      known.length === 1
        ? known[0]!
        : candidates.length === 1
          ? candidates[0]!
          : candidates.includes(position)
            ? position
            : (candidates[0] ??
              (!used.has(position) ? position : entries.findIndex((_entry, index) => !used.has(index))));
    aligned[index] = row;
    used.add(index);
  });
  return aligned;
}

export async function lookupSyncAccounts(
  store: AccountStore<any>,
  entries: readonly Record<string, unknown>[],
  ctx: ResolveContext,
  logger: AdcpLogger,
  indices: readonly number[],
  failClosed = store.strictIdempotency
): Promise<(Account | null)[]> {
  const existing: (Account | null)[] = Array(entries.length).fill(null);
  async function resolveEntry(entry: Record<string, unknown>, index: number): Promise<void> {
    const ref = syncNaturalKey(structuredClone(entry));
    if (!ref || normalizeAccountResolution(store.resolution) === 'derived') {
      return;
    }
    try {
      const account = await store.resolve(ref, { ...ctx, provisioning: false });
      existing[index] = account ? structuredClone(account) : null;
    } catch (err) {
      const missing =
        err instanceof AccountNotFoundError || (err instanceof AdcpError && err.code === 'ACCOUNT_NOT_FOUND');
      if (!missing) {
        if (failClosed) throw err;
        emitAccountDiagnostic(store, logger, {
          code: 'ACCOUNT_LOOKUP_FAILED',
          toolName: 'sync_accounts',
          index: indices[index]!,
        });
      }
    }
  }
  // Bound upstream concurrency while retaining the request's row alignment.
  let nextIndex = 0;
  let aborted = false;
  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, async () => {
      while (!aborted && nextIndex < entries.length) {
        const index = nextIndex++;
        try {
          await resolveEntry(entries[index]!, index);
        } catch (error) {
          aborted = true;
          throw error;
        }
      }
    })
  );
  return existing;
}

const MESSAGES: Record<AccountStoreDiagnostic['code'], string> = {
  ACCOUNT_IDEMPOTENCY_VIOLATION:
    'Account upsert must preserve the existing account_id and report updated or unchanged.',
  PAYMENT_TERMS_MISMATCH: 'An active account must accept the requested payment_terms or reject the sync entry.',
  ACCOUNT_BILLING_INCOMPLETE: 'An agent-billed account response must include billing and payment_terms.',
  ACCOUNT_LOOKUP_FAILED:
    'Account lookup could not provide an existing snapshot; use a lookup-only natural-key resolver.',
};

export function emitAccountDiagnostic(
  store: AccountStore<any>,
  logger: AdcpLogger,
  diagnostic: AccountStoreDiagnostic
): void {
  // Never include account IDs, requests, credentials, or callback exception text.
  try {
    if (process.env.NODE_ENV !== 'production') logger.warn(MESSAGES[diagnostic.code], { ...diagnostic });
  } catch {
    /* Telemetry cannot change dispatch. */
  }
  try {
    const pending = store.onDiagnostic?.(diagnostic);
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch {
    /* Same contract for sync and async hooks. */
  }
}

function billingOf(account: Account | null): BillingParty | undefined {
  const billed = account?.billing?.invoicedTo;
  return billed === undefined ? undefined : typeof billed === 'string' ? billed : 'advertiser';
}

/** Check copied rows so frozen/cached adopter results remain unchanged. */
export function checkSyncAccountRow(
  store: AccountStore<any>,
  logger: AdcpLogger,
  entry: Record<string, unknown>,
  original: SyncAccountsResultRow,
  existing: Account | null,
  index: number,
  stored: Account | null = null,
  dryRun = false,
  expectedId = existing?.id
): SyncAccountsResultRow {
  const row = { ...original };
  if (row.action === 'failed') return row;
  const diagnostic = (code: AccountStoreDiagnostic['code']) =>
    emitAccountDiagnostic(store, logger, { code, toolName: 'sync_accounts', index });
  const identityViolation = expectedId !== undefined && (row.account_id !== expectedId || row.action === 'created');
  if (identityViolation) diagnostic('ACCOUNT_IDEMPOTENCY_VIOLATION');
  // Stored fields belong only to a response identifying the same account.
  if (stored && row.account_id === stored.id) {
    row.billing ??= billingOf(stored);
    if (row.billing === 'agent' || entry.payment_terms !== undefined) row.payment_terms ??= stored.payment_terms;
  }
  if (
    row.status === 'active' &&
    !dryRun &&
    (row.billing === 'agent' || entry.billing === 'agent' || billingOf(existing) === 'agent') &&
    (row.billing === undefined || row.payment_terms === undefined)
  )
    diagnostic('ACCOUNT_BILLING_INCOMPLETE');
  const termsViolation =
    row.status === 'active' &&
    entry.payment_terms !== undefined &&
    row.payment_terms !== undefined &&
    row.payment_terms !== entry.payment_terms &&
    (!dryRun || row.payment_terms !== undefined);
  if (termsViolation) diagnostic('PAYMENT_TERMS_MISMATCH');
  if (store.strictIdempotency && (identityViolation || termsViolation)) {
    const code = identityViolation ? 'SYNC_FAILED' : 'PAYMENT_TERMS_NOT_SUPPORTED';
    const message = identityViolation ? MESSAGES.ACCOUNT_IDEMPOTENCY_VIOLATION : MESSAGES.PAYMENT_TERMS_MISMATCH;
    // Strict checks reject the response; they cannot undo an adopter's persisted write.
    return {
      brand: row.brand,
      operator: row.operator,
      action: 'failed',
      status: row.status,
      ...(row.account_id !== undefined && { account_id: row.account_id }),
      ...(row.sandbox !== undefined && { sandbox: row.sandbox }),
      errors: [
        new AdcpError(code, {
          message,
          recovery: identityViolation ? 'terminal' : 'correctable',
          field: `accounts[${index}]${identityViolation ? '' : '.payment_terms'}`,
        }).toStructuredError(),
      ],
    };
  }
  return row;
}
