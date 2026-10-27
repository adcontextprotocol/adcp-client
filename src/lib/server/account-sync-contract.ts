import { accountReferenceKey } from '../core/account-key';
import type { AccountReference } from '../types';
import type { AdcpLogger } from './create-adcp-server';
import { AccountNotFoundError, toWireAccount } from './decisioning/account';
import type {
  Account,
  AccountStore,
  AccountSyncDiagnostic,
  ResolveContext,
  SyncAccountsResultRow,
} from './decisioning/account';
import { AdcpError } from './decisioning/async-outcome';

type Entry = Record<string, unknown>;
const NATURAL_KEY_FIELDS = ['brand', 'operator', 'operator_unit', 'currency', 'timezone', 'sandbox'] as const;

/** Copy request input only when a callback reads it; keep auth capabilities live. */
export function isolateAccountCallbackInput(ctx: ResolveContext): ResolveContext {
  const descriptors = Object.getOwnPropertyDescriptors(ctx);
  delete descriptors.input;
  const copy = Object.defineProperties({}, descriptors) as ResolveContext;
  if ('input' in ctx) {
    let captured = false;
    let input: ResolveContext['input'];
    Object.defineProperty(copy, 'input', {
      enumerable: true,
      configurable: true,
      get() {
        if (!captured) {
          const source = ctx.input;
          input = source === undefined ? undefined : structuredClone(source);
          captured = true;
        }
        return input;
      },
      set(value: ResolveContext['input']) {
        input = value;
        captured = true;
      },
    });
  }
  return copy;
}

/** Preserve the full natural key without forwarding account settings to resolvers. */
function naturalRef(entry: Entry): AccountReference | undefined {
  const ref = (entry.account ?? entry) as AccountReference;
  if (!ref || 'account_id' in ref || !('brand' in ref) || !ref.brand || typeof ref.operator !== 'string')
    return undefined;
  return Object.fromEntries(
    NATURAL_KEY_FIELDS.filter(field => ref[field] !== undefined).map(field => [field, ref[field]])
  ) as AccountReference;
}

async function lookup(
  accounts: AccountStore,
  ref: AccountReference,
  ctx: ResolveContext,
  onUnsupported?: () => void
): Promise<Account | null> {
  try {
    // A guard lookup must never provision an account itself.
    const account = await accounts.resolve(
      structuredClone(ref),
      isolateAccountCallbackInput({ ...ctx, provisioning: false })
    );
    if (account && 'account_id' in ref && account.id !== ref.account_id) return null;
    if (account && 'brand' in ref) {
      const identity = account as unknown as Partial<Extract<AccountReference, { brand: unknown }>>;
      const values = identity as Record<string, unknown>;
      const known = Object.fromEntries(
        ['operator_unit', 'currency', 'timezone', 'sandbox']
          .filter(field => values[field] !== undefined)
          .map(field => [field, values[field]])
      );
      const projected = {
        ...ref,
        ...known,
        brand: { ...ref.brand, ...identity.brand },
        operator: identity.operator ?? ref.operator,
      } as AccountReference;
      // Missing metadata remains compatible, but known mismatches must not
      // feed an unrelated account into the guard or into ctx.existing.
      if (accountReferenceKey(projected) !== accountReferenceKey(ref)) return null;
    }
    return account ? { ...account, billing: account.billing && { ...account.billing } } : null;
  } catch (error) {
    if (error instanceof AccountNotFoundError || (error instanceof AdcpError && error.code === 'ACCOUNT_NOT_FOUND'))
      return null;
    if (error instanceof AdcpError && ['INVALID_REQUEST', 'UNSUPPORTED_FEATURE'].includes(error.code)) {
      onUnsupported?.();
      return null;
    }
    throw error; // An outage is not evidence that an account doesn't exist.
  }
}

export async function existingSyncAccounts(
  accounts: AccountStore,
  entries: Entry[],
  ctx: ResolveContext,
  logger?: AdcpLogger
): Promise<(Account | null)[]> {
  const existing: (Account | null)[] = [];
  for (const [index, entry] of entries.entries()) {
    const ref = accounts.resolution === 'derived' ? undefined : naturalRef(entry);
    const account = ref
      ? await lookup(accounts, ref, ctx, () => {
          if (logger)
            diagnose(accounts, logger, { code: 'ACCOUNT_SYNC_LOOKUP_UNSUPPORTED', toolName: 'sync_accounts', index });
        })
      : null;
    // A ref-ignoring singleton resolver is valid for some discovery tools,
    // but is not evidence that this natural key has already been synced.
    existing.push(
      typeof account?.brand?.domain === 'string' &&
        account.brand.domain.length > 0 &&
        typeof account.operator === 'string'
        ? account
        : null
    );
  }
  return existing;
}

function diagnose(accounts: AccountStore, logger: AdcpLogger, diagnostic: AccountSyncDiagnostic): void {
  if (process.env.NODE_ENV !== 'production') safeWarn(logger, 'Account store contract violation', { ...diagnostic });
  // Observability must not change the result of a committed write.
  try {
    const pending: unknown = accounts.onDiagnostic?.(diagnostic);
    if (pending) void Promise.resolve(pending).catch(() => safeWarn(logger, 'Account diagnostic callback failed'));
  } catch {
    safeWarn(logger, 'Account diagnostic callback failed');
  }
}

function safeWarn(logger: AdcpLogger, message: string, data?: Record<string, unknown>): void {
  try {
    logger.warn(message, data);
  } catch {
    /* Logging must not change a committed result. */
  }
}

export function diagnoseAccountBilling(
  accounts: AccountStore,
  logger: AdcpLogger,
  account: { billing?: string; payment_terms?: string },
  toolName: AccountSyncDiagnostic['toolName'],
  index: number
): void {
  if (account.billing === 'agent' && account.payment_terms === undefined) {
    diagnose(accounts, logger, { code: 'ACCOUNT_BILLING_FIELDS_MISSING', toolName, index });
  }
}

export async function projectAccountList(
  accounts: AccountStore,
  items: Account[],
  ctx: ResolveContext,
  logger: AdcpLogger
): Promise<ReturnType<typeof toWireAccount>[]> {
  const rows: ReturnType<typeof toWireAccount>[] = [];
  for (const [index, account] of items.entries()) {
    const row = toWireAccount(account);
    if (row.billing === undefined || row.payment_terms === undefined) {
      const ref =
        accounts.resolution === 'implicit' ? naturalRef(account as unknown as Entry) : { account_id: account.id };
      if (ref) {
        try {
          const stored = await lookup(accounts, ref, ctx);
          if (stored?.id === account.id) {
            const wire = toWireAccount(stored);
            row.billing ??= wire.billing;
            row.payment_terms ??= wire.payment_terms;
          }
        } catch {
          safeWarn(logger, 'Could not enrich listed account billing fields');
        }
      }
    }
    diagnoseAccountBilling(accounts, logger, row, 'list_accounts', index);
    rows.push(row);
  }
  return rows;
}

export async function checkSyncAccountRows(
  accounts: AccountStore,
  entries: Entry[],
  existing: (Account | null)[],
  rows: SyncAccountsResultRow[],
  indices: number[],
  ctx: ResolveContext,
  logger: AdcpLogger
): Promise<SyncAccountsResultRow[]> {
  const seen = new Map<string, string>();
  const checked: SyncAccountsResultRow[] = [];
  for (const [offset, inputRow] of rows.entries()) {
    const entry = entries[offset]!;
    const index = indices[offset]!;
    const ref = naturalRef(entry);
    const key = ref && accountReferenceKey(ref);
    const priorId = existing[offset]?.id ?? (key ? seen.get(key) : undefined);
    let row = { ...inputRow };
    if (row.action === 'failed') {
      checked.push(row);
      continue;
    }

    const idViolation = priorId !== undefined && (row.account_id !== priorId || row.action === 'created');
    if (idViolation)
      diagnose(accounts, logger, { code: 'ACCOUNT_SYNC_IDEMPOTENCY_VIOLATION', toolName: 'sync_accounts', index });

    // Only enrich from a record with the returned ID; never borrow another
    // account's terms. Prefer current persisted state over the pre-write snapshot.
    const requestedRef = (entry.account ?? entry) as AccountReference;
    const enrichmentRef =
      ref ??
      ('account_id' in requestedRef && accounts.resolution !== 'implicit'
        ? { account_id: requestedRef.account_id }
        : undefined);
    let stored: Account | null = null;
    if (enrichmentRef && (row.billing === undefined || row.payment_terms === undefined)) {
      try {
        stored = await lookup(accounts, enrichmentRef, ctx);
      } catch {
        safeWarn(logger, 'Could not enrich account sync billing fields');
      }
    }
    const source =
      stored?.id === row.account_id ? stored : existing[offset]?.id === row.account_id ? existing[offset] : null;
    if (source) {
      const wire = toWireAccount(source);
      row.billing ??= wire.billing;
      row.payment_terms ??= wire.payment_terms;
    }
    const missing =
      (entry.billing === 'agent' || row.billing === 'agent') &&
      (row.billing === undefined || row.payment_terms === undefined);
    if (missing)
      diagnose(accounts, logger, { code: 'ACCOUNT_BILLING_FIELDS_MISSING', toolName: 'sync_accounts', index });
    const termsViolation =
      entry.payment_terms !== undefined && row.status === 'active' && row.payment_terms !== entry.payment_terms;
    const billingViolation =
      entry.billing === 'agent' && row.status === 'active' && row.billing !== undefined && row.billing !== 'agent';
    if (billingViolation)
      diagnose(accounts, logger, { code: 'ACCOUNT_SYNC_BILLING_MISMATCH', toolName: 'sync_accounts', index });
    if (termsViolation)
      diagnose(accounts, logger, { code: 'ACCOUNT_SYNC_PAYMENT_TERMS_MISMATCH', toolName: 'sync_accounts', index });

    // These are committed store results even if strict response validation
    // rejects them. Later entries must still detect duplicate identities.
    if (key && row.account_id) seen.set(key, priorId ?? row.account_id);
    if (accounts.strictIdempotency && (idViolation || termsViolation || billingViolation)) {
      const error = new AdcpError(
        termsViolation
          ? 'PAYMENT_TERMS_NOT_SUPPORTED'
          : billingViolation
            ? 'BILLING_NOT_SUPPORTED'
            : 'SERVICE_UNAVAILABLE',
        {
          message: termsViolation
            ? 'The seller did not accept the requested payment terms.'
            : billingViolation
              ? 'The seller did not accept agent billing.'
              : 'The account store did not preserve the existing account identity.',
          recovery: termsViolation || billingViolation ? 'correctable' : 'transient',
          field: `accounts[${index}]${termsViolation ? '.payment_terms' : billingViolation ? '.billing' : ''}`,
        }
      ).toStructuredError();
      const anchor =
        row.account !== undefined ? { account: row.account } : { brand: row.brand, operator: row.operator };
      row = {
        ...anchor,
        ...(priorId === row.account_id && priorId && { account_id: priorId }),
        action: 'failed',
        status: existing[offset]?.status ?? row.status,
        errors: [error],
      };
    }
    checked.push(row);
  }
  return checked;
}
