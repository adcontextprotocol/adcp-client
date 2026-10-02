import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { AccountReference, BusinessEntity, PaymentTerms, SyncAccountsResponse } from '../types/tools.generated';
import type { TaskOptions, TaskResult } from './ConversationTypes';
import { accountReferenceKey } from './account-key';
import { sameCountrySet } from './account-resolution';
import { adcpErrorToTypedError, AccountNotFoundError, AccountSetupRequiredError } from '../errors';
import { isAbortOrTimeoutError, MAX_TIMER_DELAY_MS, throwIfAborted, withAbortSignal } from '../protocols/abort';
import { withTaskDeadline } from './task-deadline';

export type AccountPolicy = 'auto' | 'strict' | 'off';
export interface EnsureAccountOptions {
  billing?: 'operator' | 'agent' | 'advertiser';
  paymentTerms?: PaymentTerms;
  billingEntity?: BusinessEntity;
}
export interface ProvisionedAccount {
  account: AccountReference;
  account_id?: string;
  status: string;
  pendingTaskId?: string;
  /** Hashes of explicitly selected setup options; billing identities themselves are never persisted. */
  setupTerms?: Partial<Record<keyof EnsureAccountOptions, string>>;
  /** Stored reference aliases for authoritative repair after restart. */
  aliases?: AccountReference[];
}
/** Partitioned by seller and caller scope. Implementations must provide read-your-writes. */
export interface BuyerAccountStorage {
  get(key: string): Promise<ProvisionedAccount | undefined>;
  set(key: string, account: ProvisionedAccount): Promise<void>;
}
export interface BuyerAccountRegistryOptions {
  maxEntries?: number;
  normalizeOptions?: (options: EnsureAccountOptions, taskOptions?: TaskOptions) => Promise<EnsureAccountOptions>;
}
type NaturalRef = Extract<AccountReference, { brand: unknown }>;
type AccountRow = Partial<NaturalRef> & { account_id?: string; status?: string; action?: string };
interface PendingProvisioning {
  promise: Promise<ProvisionedAccount>;
  options: EnsureAccountOptions;
  result?: TaskResult<unknown>;
}
function setupTerms(options: EnsureAccountOptions): ProvisionedAccount['setupTerms'] {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)])
          )
        : value;
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [
      key,
      createHash('sha256')
        .update(JSON.stringify(stable(value)))
        .digest('hex'),
    ])
  );
}

export class BuyerAccountRegistry {
  private entries = new Map<string, ProvisionedAccount>();
  private pending = new Map<string, PendingProvisioning>();
  private writes: Promise<void> = Promise.resolve();
  private repairs = new Map<string, object>();
  private readonly maxEntries: number;
  private readonly normalizeOptions?: BuyerAccountRegistryOptions['normalizeOptions'];
  constructor(
    private scope: () => string,
    private provision: (
      key: AccountReference,
      options: EnsureAccountOptions,
      taskOptions?: TaskOptions
    ) => Promise<TaskResult<SyncAccountsResponse>>,
    private storage?: BuyerAccountStorage,
    private repair?: (accountId: string, taskOptions?: TaskOptions) => Promise<readonly unknown[]>,
    options: BuyerAccountRegistryOptions = {}
  ) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.normalizeOptions = options.normalizeOptions;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 2)
      throw new Error('Account registry maxEntries must be an integer >= 2.');
  }
  private key(account: AccountReference, scope = this.scope()): string {
    return `${scope}:${accountReferenceKey(account)}`;
  }
  private remember(key: string, entry: ProvisionedAccount): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      if (!this.storage)
        throw new AccountSetupRequiredError(
          'Account registry capacity reached; configure durable storage or increase maxEntries.'
        );
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, structuredClone(entry));
  }
  async get(account: AccountReference): Promise<ProvisionedAccount | undefined> {
    const key = this.key(account);
    let entry = this.entries.get(key);
    if (!entry) {
      const persisted = await this.storage?.get(key);
      entry = this.entries.get(key) ?? persisted; // A setup may have settled while storage was reading.
    }
    if (key !== this.key(account) || (entry && accountReferenceKey(entry.account) !== accountReferenceKey(account)))
      return undefined;
    if (entry) this.remember(key, entry);
    return entry ? structuredClone(entry) : undefined;
  }
  async ensure(
    account: AccountReference,
    options: EnsureAccountOptions = {},
    taskOptions?: TaskOptions,
    onTaskResult?: (result: TaskResult<unknown>) => void
  ): Promise<ProvisionedAccount> {
    throwIfAborted(taskOptions?.signal);
    if (
      taskOptions?.timeout !== undefined &&
      (!Number.isFinite(taskOptions.timeout) || taskOptions.timeout < 0 || taskOptions.timeout > MAX_TIMER_DELAY_MS)
    )
      throw new RangeError(`timeout must be a finite non-negative number <= ${MAX_TIMER_DELAY_MS}`);
    account = structuredClone(account);
    if (this.normalizeOptions) options = await this.normalizeOptions(structuredClone(options), taskOptions);
    options = structuredClone(Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)));
    const scope = this.scope();
    const key = this.key(account, scope);
    const current = await this.get(account);
    throwIfAborted(taskOptions?.signal);
    if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
    const shared = this.pending.get(key);
    const wait = (promise: Promise<ProvisionedAccount>) =>
      withTaskDeadline(taskOptions, options =>
        withAbortSignal([options.signal], undefined, () => promise.then(entry => structuredClone(entry)))
      );
    if (shared) {
      if (!isDeepStrictEqual(shared.options, options))
        throw new AccountSetupRequiredError('Provisioning is already in progress with different billing terms.');
      const entry = await wait(shared.promise);
      if (shared.result) onTaskResult?.(shared.result);
      return entry;
    }
    if (current && current.status !== 'failed_provisioning') {
      const terms = setupTerms(options);
      if (
        Object.entries(terms ?? {}).some(
          ([name, value]) =>
            current.setupTerms?.[name as keyof EnsureAccountOptions] !== undefined &&
            current.setupTerms[name as keyof EnsureAccountOptions] !== value
        )
      )
        throw new AccountSetupRequiredError(
          'The account was provisioned with different billing terms. Call syncAccounts explicitly to change terms.'
        );
      if (current.status !== 'active' && current.account_id && this.repair) {
        try {
          await this.repairStatus(current.account_id, taskOptions, false);
        } catch (error) {
          throwIfAborted(taskOptions?.signal);
          if (isAbortOrTimeoutError(error)) throw error;
          if (scope !== this.scope())
            throw new AccountNotFoundError('Caller credentials changed during reconciliation.');
          return current; // Preserve existing pending-approval behavior if the seller cannot list accounts.
        }
        const refreshed = (await this.get(account)) ?? current;
        if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed during reconciliation.');
        if (refreshed.status === 'unknown')
          throw new AccountNotFoundError(
            'The seller no longer lists this account. Call syncAccounts explicitly to reestablish it.'
          );
        return refreshed;
      }
      if (current.status === 'unknown')
        throw new AccountNotFoundError(
          'Reconcile this account with listAccounts or explicitly reestablish it with syncAccounts.'
        );
      if (current.status === 'provisioning' && current.pendingTaskId)
        throw new AccountSetupRequiredError(
          `Reconcile pending sync_accounts task ${current.pendingTaskId} and observe its completed account rows before provisioning again.`
        );
      return current; // Never silently re-accept terms for pending or suspended accounts.
    }
    const requiredEntries = current?.status === 'failed_provisioning' ? 1 : 2;
    if (!this.storage && this.entries.size + this.pending.size * 2 + requiredEntries > this.maxEntries) {
      throw new AccountSetupRequiredError(
        'Account registry capacity reached; configure durable storage or increase maxEntries.'
      );
    }
    const pending: PendingProvisioning = { promise: undefined!, options: structuredClone(options) };
    let callbackFailed = false;
    let callbackError: unknown;
    const notify = (result: TaskResult<unknown>) => {
      try {
        onTaskResult?.(result);
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
      }
    };
    // Provisioning may commit spend/terms. Each caller cancels its wait; the one seller operation continues.
    const operationOptions = { ...taskOptions, signal: undefined, timeout: undefined };
    const request = this.provision(structuredClone(account), pending.options, operationOptions).then(async initial => {
      let result = initial;
      pending.result = result;
      notify(result);
      if (this.key(account) !== key) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
      if (!result.success)
        throw (
          adcpErrorToTypedError(result.adcpError ?? { code: 'ACCOUNT_NOT_FOUND', message: result.error }) ??
          new Error(result.error)
        );
      if (result.status !== 'completed') {
        const provisional: ProvisionedAccount = {
          account: structuredClone(account),
          status: 'provisioning',
          ...(result.metadata.taskId && { pendingTaskId: result.metadata.taskId }),
        };
        await this.write(provisional, scope);
        if (!result.submitted) return provisional;
        result = await result.submitted.waitForCompletion();
        pending.result = result;
        notify(result);
        if (!result.success) {
          await this.write({ account: structuredClone(account), status: 'failed_provisioning' }, scope);
          throw (
            adcpErrorToTypedError(result.adcpError ?? { code: 'ACCOUNT_SETUP_REQUIRED', message: result.error }) ??
            new Error(result.error)
          );
        }
      }
      if (this.key(account) !== key) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
      if (result.status !== 'completed' || !result.data || !('accounts' in result.data))
        throw new AccountSetupRequiredError(
          'sync_accounts has not completed; observe its completion before provisioning again.'
        );
      await this.observeSync([account], result.data.accounts);
      const entry = await this.get(account);
      if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
      if (!entry || entry.status === 'provisioning' || entry.status === 'failed_provisioning') {
        await this.write({ account, status: 'failed_provisioning' }, scope);
        const failed = result.data.accounts.find(row => row.action === 'failed');
        const error = failed?.errors?.[0];
        throw (
          (error && adcpErrorToTypedError(error)) ??
          new AccountNotFoundError('sync_accounts did not establish the requested account.')
        );
      }
      entry.setupTerms = setupTerms(options);
      await this.write(entry, scope);
      if (entry.account_id && !('account_id' in account)) {
        const idEntry = await this.get({ account_id: entry.account_id });
        if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
        if (idEntry) await this.write({ ...idEntry, setupTerms: entry.setupTerms }, scope);
      }
      return entry;
    });
    pending.promise = request;
    this.pending.set(key, pending);
    const cleanup = () => {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    };
    void request.then(cleanup, cleanup);
    const entry = await wait(request);
    if (callbackFailed) throw callbackError;
    return entry;
  }
  private async write(entry: ProvisionedAccount, scope: string): Promise<void> {
    const key = this.key(entry.account, scope);
    if (scope === this.scope()) this.remember(key, entry);
    await this.storage?.set(key, structuredClone(entry));
  }
  private async record(ref: AccountReference, row: AccountRow, scope: string, preserveTerms = false): Promise<void> {
    const entry: ProvisionedAccount = {
      account: structuredClone(ref),
      status: row.status!,
      ...(row.account_id && { account_id: row.account_id }),
    };
    const prior = await this.get(ref);
    if (scope !== this.scope()) return;
    if (preserveTerms && prior?.setupTerms) entry.setupTerms = prior.setupTerms;
    if ('account_id' in ref) {
      if (prior?.aliases) entry.aliases = prior.aliases;
    }
    await this.write(entry, scope);
    if (!row.account_id || 'account_id' in ref || scope !== this.scope()) return;
    const idRef = { account_id: row.account_id };
    const priorId = await this.get(idRef);
    if (scope !== this.scope()) return;
    const aliases = new Map((priorId?.aliases ?? []).map(alias => [accountReferenceKey(alias), alias]));
    aliases.set(accountReferenceKey(ref), structuredClone(ref));
    await this.write(
      {
        account: idRef,
        account_id: row.account_id,
        status: row.status!,
        aliases: [...aliases.values()],
        ...(preserveTerms && priorId?.setupTerms && { setupTerms: priorId.setupTerms }),
      },
      scope
    );
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.writes.then(run);
    this.writes = next.catch(() => {});
    return next;
  }
  async observeSync(refs: readonly AccountReference[], rows: readonly unknown[], dryRun = false): Promise<void> {
    if (dryRun) return;
    const scope = this.scope();
    return this.enqueue(async () => {
      if (scope !== this.scope()) return;
      for (const ref of refs) {
        const candidates = rows.filter(value => {
          if (!value || typeof value !== 'object') return false;
          const row = value as AccountRow;
          if ('account_id' in ref) return row.account_id === ref.account_id;
          return (
            row.brand?.domain === ref.brand.domain &&
            row.operator === ref.operator &&
            (!ref.brand.brand_id || row.brand.brand_id === ref.brand.brand_id) &&
            sameCountrySet(ref.brand.countries, row.brand.countries) &&
            (!ref.operator_unit || row.operator_unit?.id === ref.operator_unit.id) &&
            (!ref.currency || row.currency === ref.currency) &&
            (!ref.timezone || row.timezone === ref.timezone) &&
            (row.sandbox === undefined || (row.sandbox === true) === (ref.sandbox === true))
          );
        });
        if (candidates.length !== 1) continue; // Never guess between multiple natural-key variants.
        const row = candidates[0] as AccountRow;
        if (row.action === 'failed' || typeof row.status !== 'string') continue;
        await this.record(ref, row, scope);
      }
    });
  }
  private async reconcileId(accountId: string, status: string, scope: string): Promise<void> {
    if (scope !== this.scope()) return;
    const idRef = { account_id: accountId };
    const indexed = await this.get(idRef);
    if (scope !== this.scope()) return;
    const aliases = new Map((indexed?.aliases ?? []).map(ref => [accountReferenceKey(ref), ref]));
    for (const [key, entry] of this.entries) {
      if (
        key === this.key(entry.account, scope) &&
        entry.account_id === accountId &&
        !('account_id' in entry.account)
      ) {
        aliases.set(accountReferenceKey(entry.account), entry.account);
      }
    }
    for (const ref of aliases.values()) {
      const prior = await this.get(ref);
      if (scope !== this.scope()) return;
      await this.write({ ...prior, account: ref, account_id: accountId, status }, scope);
    }
    if (scope !== this.scope()) return;
    if (indexed || aliases.size)
      await this.write(
        { ...indexed, account: idRef, account_id: accountId, status, aliases: [...aliases.values()] },
        scope
      );
  }
  async observeList(rows: readonly unknown[], queriedAccountId?: string): Promise<void> {
    const scope = this.scope();
    return this.observeListAtScope(rows, queriedAccountId, scope);
  }
  private async observeListAtScope(
    rows: readonly unknown[],
    queriedAccountId: string | undefined,
    scope: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    return this.enqueue(async () => {
      if (scope !== this.scope() || !isCurrent()) return;
      let foundQuery = false;
      for (const value of rows) {
        if (!value || typeof value !== 'object') continue;
        const row = value as AccountRow;
        if (typeof row.account_id !== 'string' || typeof row.status !== 'string') continue;
        if (row.account_id === queriedAccountId) foundQuery = true;
        await this.reconcileId(row.account_id, row.status, scope);
        await this.record({ account_id: row.account_id }, row, scope, true);
        if (row.brand?.domain && row.operator)
          await this.record(
            {
              brand: row.brand,
              operator: row.operator,
              ...(row.operator_unit && { operator_unit: row.operator_unit }),
              ...(row.currency && { currency: row.currency }),
              ...(row.timezone && { timezone: row.timezone }),
              ...(row.sandbox !== undefined && { sandbox: row.sandbox }),
            },
            row,
            scope,
            true
          );
      }
      if (queriedAccountId && !foundQuery) await this.reconcileId(queriedAccountId, 'unknown', scope);
    });
  }
  /** After verifying account.status_changed, repair aliases by handle from the authoritative seller. */
  async applyStatusChange(notification: { account_id: string }, options?: TaskOptions): Promise<void> {
    return this.repairStatus(notification.account_id, options, true);
  }
  private async repairStatus(accountId: string, options: TaskOptions | undefined, invalidate: boolean): Promise<void> {
    if (!this.repair) throw new Error('Account registry requires a list_accounts repair callback.');
    const scope = this.scope();
    const key = this.key({ account_id: accountId }, scope);
    const token = {};
    this.repairs.set(key, token);
    if (invalidate) await this.enqueue(() => this.reconcileId(accountId, 'unknown', scope));
    try {
      const rows = await this.repair(accountId, options);
      await this.observeListAtScope(rows, accountId, scope, () => this.repairs.get(key) === token);
    } finally {
      if (this.repairs.get(key) === token) this.repairs.delete(key);
    }
  }
}
