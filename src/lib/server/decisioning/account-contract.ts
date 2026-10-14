import type { AccountReference, BillingParty } from '../../types/tools.generated';
import { accountReferenceKey } from '../../core/account-key';
import type { AdcpLogger } from '../create-adcp-server';
import { AdcpError } from './async-outcome';
import {
  AccountNotFoundError,
  normalizeAccountResolution,
  type AccountSyncSnapshot,
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
  const ids =
    typeof id === 'string'
      ? entries.flatMap((entry, index) =>
          (record(entry.account).account_id ?? entry.account_id) === id ? [index] : []
        )
      : [];
  const echoed = syncNaturalKey(row.account === undefined ? { ...row, account_id: undefined } : row);
  if (!echoed) return ids;
  const echoes = entries.flatMap((entry, index) => {
    const ref = syncNaturalKey(entry);
    return ref &&
      accountReferenceKey({
        ...ref,
        ...Object.fromEntries(Object.entries(echoed).filter(([key]) => key in ref)),
        brand: {
          ...ref.brand,
          ...Object.fromEntries(Object.entries(echoed.brand).filter(([key]) => key in ref.brand)),
        },
      }) === accountReferenceKey(ref)
      ? [index]
      : [];
  });
  return [...new Set([...ids, ...echoes])];
}

/** Reserve unambiguous matches first; partial echoes cannot establish a distinct request's identity. */
export function alignSyncAccountRows(
  rows: SyncAccountsResultRow[],
  entries: readonly Record<string, unknown>[]
): { rows: SyncAccountsResultRow[]; certain: boolean[] } {
  if (rows.length !== entries.length) return { rows, certain: rows.map(() => false) };
  // A single result is anchored to its request even when the seller canonicalizes brand identity.
  if (rows.length === 1) return { rows, certain: [true] };
  const aligned: SyncAccountsResultRow[] = Array(rows.length);
  const certain: boolean[] = Array(rows.length).fill(false);
  const used = new Set<number>();
  const assigned = new Set<number>();
  const candidates = rows.map(row => matchingSyncAccountIndices(row as unknown as Record<string, unknown>, entries));
  const assign = (position: number, index: number, verified: boolean) => {
    aligned[index] = rows[position]!;
    certain[index] = verified;
    used.add(index);
    assigned.add(position);
  };
  // Repeatedly reserve unique matches before any positional fallback consumes them.
  let progress = true;
  while (progress) {
    progress = false;
    rows.forEach((_row, position) => {
      if (assigned.has(position)) return;
      const matches = candidates[position]!.filter(index => !used.has(index));
      if (matches.length === 1) {
        assign(position, matches[0]!, true);
        progress = true;
      }
    });
  }
  rows.forEach((_row, position) => {
    if (assigned.has(position)) return;
    const matches = candidates[position]!.filter(index => !used.has(index));
    const keys = new Set(
      candidates[position]!.map(index => {
        const ref = syncNaturalKey(entries[index]!);
        return ref ? accountReferenceKey(ref) : JSON.stringify(record(entries[index]!.account));
      })
    );
    const index = matches.includes(position)
      ? position
      : (matches[0] ?? (!used.has(position) ? position : entries.findIndex((_entry, index) => !used.has(index))));
    assign(position, index, matches.length > 0 && keys.size === 1);
  });
  return { rows: aligned, certain };
}

export async function lookupSyncAccounts(
  store: AccountStore<any>,
  entries: readonly Record<string, unknown>[],
  ctx: ResolveContext,
  logger: AdcpLogger,
  indices: readonly number[],
  failClosed = store.strictIdempotency
): Promise<(AccountSyncSnapshot | null)[]> {
  const existing: (AccountSyncSnapshot | null)[] = Array(entries.length).fill(null);
  async function resolveEntry(entry: Record<string, unknown>, index: number): Promise<void> {
    const ref = syncNaturalKey(structuredClone(entry));
    if (!ref || normalizeAccountResolution(store.resolution) === 'derived') {
      return;
    }
    try {
      const account = await store.resolve(ref, { ...ctx, provisioning: false });
      if (account) {
        const snapshot: AccountSyncSnapshot = { id: account.id, name: account.name, status: account.status };
        for (const key of [
          'brand',
          'operator',
          'billing',
          'billing_entity',
          'payment_terms',
          'sandbox',
          'mode',
        ] as const) {
          if (account[key] !== undefined) Object.assign(snapshot, { [key]: account[key] });
        }
        if (snapshot.billing_entity) {
          const { bank: _bank, ...entity } = snapshot.billing_entity;
          snapshot.billing_entity = entity;
        }
        existing[index] = structuredClone(snapshot);
      }
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
  ACCOUNT_SYNC_ROW_UNMATCHED: 'Account sync response lacks enough identity fields to verify its request entry.',
  BILLING_MISMATCH: 'An account must accept the requested billing model or reject the sync entry.',
  PAYMENT_TERMS_MISMATCH: 'An account must accept explicitly requested payment_terms or reject the sync entry.',
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

function billingOf(account: AccountSyncSnapshot | null): BillingParty | undefined {
  const billed = account?.billing?.invoicedTo;
  return billed === undefined ? undefined : typeof billed === 'string' ? billed : 'advertiser';
}

/** Check copied rows so frozen/cached adopter results remain unchanged. */
export function checkSyncAccountRow(
  store: AccountStore<any>,
  logger: AdcpLogger,
  entry: Record<string, unknown>,
  original: SyncAccountsResultRow,
  existing: AccountSyncSnapshot | null,
  index: number,
  stored: AccountSyncSnapshot | null = null,
  dryRun = false,
  expectedId = existing?.id,
  createdInThisBatch = false
): SyncAccountsResultRow {
  const row = { ...original };
  if (row.action === 'failed') return row;
  const diagnostic = (code: AccountStoreDiagnostic['code']) =>
    emitAccountDiagnostic(store, logger, { code, toolName: 'sync_accounts', index });
  const identityViolation =
    expectedId !== undefined &&
    ((row.account_id !== undefined && row.account_id !== expectedId) ||
      (!createdInThisBatch && row.action === 'created'));
  if (identityViolation) diagnostic('ACCOUNT_IDEMPOTENCY_VIOLATION');
  // Stored fields belong only to a response identifying the same account.
  if (stored && row.account_id === stored.id) {
    row.billing ??= billingOf(stored);
    if (row.billing === 'agent' || entry.payment_terms !== undefined) row.payment_terms ??= stored.payment_terms;
  }
  if (
    row.status === 'active' &&
    !dryRun &&
    (row.billing === 'agent' ||
      entry.billing === 'agent' ||
      (row.billing === undefined && entry.billing === undefined && billingOf(existing) === 'agent')) &&
    (row.billing === undefined || row.payment_terms === undefined)
  )
    diagnostic('ACCOUNT_BILLING_INCOMPLETE');
  const billingViolation =
    row.status !== 'rejected' &&
    entry.billing !== undefined &&
    row.billing !== undefined &&
    row.billing !== entry.billing;
  if (billingViolation) diagnostic('BILLING_MISMATCH');
  const termsViolation =
    row.status !== 'rejected' &&
    entry.payment_terms !== undefined &&
    row.payment_terms !== undefined &&
    row.payment_terms !== entry.payment_terms;
  if (termsViolation) diagnostic('PAYMENT_TERMS_MISMATCH');
  if (store.strictIdempotency && (identityViolation || billingViolation || termsViolation)) {
    const code = identityViolation
      ? 'SYNC_FAILED'
      : billingViolation
        ? 'BILLING_NOT_SUPPORTED'
        : 'PAYMENT_TERMS_NOT_SUPPORTED';
    const message = identityViolation
      ? MESSAGES.ACCOUNT_IDEMPOTENCY_VIOLATION
      : billingViolation
        ? MESSAGES.BILLING_MISMATCH
        : MESSAGES.PAYMENT_TERMS_MISMATCH;
    // Strict checks reject the response; they cannot undo an adopter's persisted write.
    return {
      ...row,
      action: 'failed',
      status: row.status,
      ...(row.account_id !== undefined && { account_id: row.account_id }),
      ...(row.sandbox !== undefined && { sandbox: row.sandbox }),
      errors: [
        new AdcpError(code, {
          message,
          recovery: identityViolation ? 'terminal' : 'correctable',
          field: `accounts[${index}]${identityViolation ? '' : billingViolation ? '.billing' : '.payment_terms'}`,
        }).toStructuredError(),
      ],
    };
  }
  return row;
}
