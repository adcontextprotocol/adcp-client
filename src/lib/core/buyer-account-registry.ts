import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { AccountReference, BusinessEntity, PaymentTerms, SyncAccountsResponse } from '../types/tools.generated';
import type { TaskOptions, TaskResult } from './ConversationTypes';
import { accountReferenceKey } from './account-key';
import { sameCountrySet } from './account-resolution';
import { adcpErrorToTypedError, AccountNotFoundError, AccountSetupRequiredError } from '../errors';
import { isAbortOrTimeoutError, MAX_TIMER_DELAY_MS, throwIfAborted, withAbortSignal } from '../protocols/abort';
import { withTaskDeadline } from './task-deadline';
import { isValidIdempotencyKey } from '../utils/idempotency';

export type AccountPolicy = 'auto' | 'strict' | 'off';
export interface EnsureAccountOptions {
  billing?: 'operator' | 'agent' | 'advertiser';
  paymentTerms?: PaymentTerms;
  billingEntity?: BusinessEntity;
  /** Caller-owned retry identity. Settle ambiguous dispatches explicitly with this key; the registry never rotates it. */
  idempotencyKey?: string;
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
  /** Monotonically increasing row revision when compareAndSet is implemented. */
  revision?: number;
  /** Durable claim. Reconcile an uncertain dispatch explicitly before provisioning again. */
  dispatch?: { idempotencyKey: string; startedAt: string };
}
/** Partitioned by seller and caller scope. Implementations must provide read-your-writes. */
export interface BuyerAccountStorage {
  get(key: string): Promise<ProvisionedAccount | undefined>;
  set(key: string, account: ProvisionedAccount): Promise<void>;
  /** Atomically insert (undefined revision) or replace. Store the supplied new revision. Required for multi-process safety. */
  compareAndSet?(key: string, expectedRevision: number | undefined, account: ProvisionedAccount): Promise<boolean>;
}
export interface BuyerAccountDispatch {
  storageKey: string;
  account: AccountReference;
  idempotencyKey: string;
}
export interface BuyerAccountProvisioningDispatch {
  idempotencyKey: string;
  /** @internal Legacy sellers can omit idempotency only when no durability or caller key was requested. */
  requireIdempotencyKey?: boolean;
  /** Invoke immediately before the transport receives the mutation. */
  beforeDispatch(): Promise<void>;
}
export interface BuyerAccountRegistryOptions {
  /** Awaited before dispatch; rejection prevents the mutation. */
  onDispatchStart?: (dispatch: BuyerAccountDispatch) => Promise<void>;
  /** Awaited for each seller result before account writes. Rejection preserves the claim for caller reconciliation. */
  onResult?: (dispatch: BuyerAccountDispatch & { result: TaskResult<unknown> }) => Promise<void>;
  /** @internal The provision callback invokes beforeDispatch at its transport boundary. */
  provisionOwnsDispatchBoundary?: boolean;
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
    Object.entries(options)
      .filter(([key]) => key !== 'idempotencyKey')
      .map(([key, value]) => [
        key,
        createHash('sha256')
          .update(JSON.stringify(stable(value)))
          .digest('hex'),
      ])
  );
}

/** Synthetic transport/protocol errors do not establish the seller mutation's outcome. */
function isDefinitiveRejection(result: TaskResult<unknown>): boolean {
  return Boolean(
    result.adcpError &&
    !result.adcpError.synthetic &&
    !result.adcpError.code.startsWith('IDEMPOTENCY_') &&
    ['terminal', 'correctable'].includes(result.adcpError.recovery ?? '')
  );
}

export class BuyerAccountRegistry {
  private entries = new Map<string, ProvisionedAccount>();
  private pending = new Map<string, PendingProvisioning>();
  private writes: Promise<void> = Promise.resolve();
  private repairs = new Map<string, object>();
  private repairWaiters = new Map<string, Promise<void>>();
  private invalidatedHandles = new Set<string>();
  private observationEpoch = 0;
  private observationFloor = 0;
  private statusEpochs = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly normalizeOptions?: BuyerAccountRegistryOptions['normalizeOptions'];
  constructor(
    private scope: () => string,
    private provision: (
      key: AccountReference,
      options: EnsureAccountOptions,
      taskOptions?: TaskOptions,
      dispatch?: BuyerAccountProvisioningDispatch
    ) => Promise<TaskResult<SyncAccountsResponse>>,
    private storage?: BuyerAccountStorage,
    private repair?: (accountId: string, taskOptions?: TaskOptions) => Promise<readonly unknown[]>,
    private readonly registryOptions: BuyerAccountRegistryOptions = {}
  ) {
    this.maxEntries = registryOptions.maxEntries ?? 10_000;
    this.normalizeOptions = registryOptions.normalizeOptions;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 2)
      throw new Error('Account registry maxEntries must be an integer >= 2.');
  }
  private key(account: AccountReference, scope = this.scope()): string {
    return `${scope}:${accountReferenceKey(account)}`;
  }
  /** Capture before a seller request; observations older than a status repair are ignored. */
  captureObservation(): number {
    return this.observationEpoch;
  }
  private observationIsCurrent(accountId: string | undefined, epoch: number | undefined, scope: string): boolean {
    return (
      epoch === undefined ||
      (epoch >= this.observationFloor &&
        (!accountId || (this.statusEpochs.get(this.key({ account_id: accountId }, scope)) ?? 0) <= epoch))
    );
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
    let entry = this.storage?.compareAndSet ? await this.storage.get(key) : this.entries.get(key);
    if (!entry && !this.storage?.compareAndSet) {
      const persisted = await this.storage?.get(key);
      entry = this.entries.get(key) ?? persisted; // A setup may have settled while storage was reading.
    }
    if (key !== this.key(account) || (entry && accountReferenceKey(entry.account) !== accountReferenceKey(account)))
      return undefined;
    if (entry && this.storage?.compareAndSet && (!Number.isSafeInteger(entry.revision) || entry.revision! < 1))
      throw new Error('CAS account storage must return a positive integer revision.');
    if (entry) this.remember(key, entry);
    if (entry?.account_id && this.invalidatedHandles.has(this.key({ account_id: entry.account_id })))
      return { ...structuredClone(entry), status: 'unknown' };
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
    if (options.idempotencyKey !== undefined && !isValidIdempotencyKey(options.idempotencyKey))
      throw new TypeError('idempotencyKey must match [A-Za-z0-9_.:-]{16,255}.');
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
        throw new AccountSetupRequiredError(
          'Provisioning is already in progress with different billing terms or idempotency keys.'
        );
      const entry = await wait(shared.promise);
      if (shared.result) onTaskResult?.(shared.result);
      return entry;
    }
    const terms = setupTerms(options);
    if (
      current?.status === 'failed_provisioning' &&
      current.setupTerms &&
      !isDeepStrictEqual(current.setupTerms, terms)
    )
      throw new AccountSetupRequiredError(
        'The pending account was provisioned with different billing terms. Call syncAccounts explicitly to change terms.'
      );
    if (current && current.status !== 'failed_provisioning') {
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
      if (current.status === 'provisioning' && current.dispatch)
        throw new AccountSetupRequiredError(
          `Provisioning is claimed or in doubt in durable storage.${current.pendingTaskId ? ` Recover task ${current.pendingTaskId}.` : ''} Reconcile the recorded idempotency key and observeSync before retrying.`
        );
      if (current.status === 'provisioning' && current.pendingTaskId)
        throw new AccountSetupRequiredError(
          `Reconcile pending sync_accounts task ${current.pendingTaskId} and observe its completed account rows before provisioning again.`
        );
      if (current.status !== 'pending_approval' || current.account_id) return current;
      // Legacy sellers can return pending rows without a handle. Repeat setup only with identical selected terms.
      if (!current.setupTerms || !isDeepStrictEqual(current.setupTerms, terms))
        throw new AccountSetupRequiredError(
          'Provide the original billing options to refresh a legacy account without a handle, or call syncAccounts explicitly.'
        );
    }
    const requiredEntries = current ? 1 : 2;
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
    const observationEpoch = this.captureObservation();
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    const dispatch: BuyerAccountDispatch = { storageKey: key, account: structuredClone(account), idempotencyKey };
    let claimRevision: number | undefined;
    let dispatched = false;
    const releaseClaim = async () => {
      if (!this.storage?.compareAndSet || claimRevision === undefined) return;
      const latest = await this.storage.get(key);
      if (latest?.revision !== claimRevision || latest.dispatch?.idempotencyKey !== idempotencyKey) return;
      await this.write({ ...latest, status: 'failed_provisioning', dispatch: undefined }, scope);
    };
    const beforeDispatch = async () => {
      if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed before dispatch.');
      if (this.storage?.compareAndSet) {
        await this.write(
          {
            account,
            status: 'provisioning',
            setupTerms: terms,
            revision: current?.revision,
            dispatch: { idempotencyKey, startedAt: new Date().toISOString() },
          },
          scope
        );
        claimRevision = (current?.revision ?? 0) + 1;
      }
      await this.registryOptions.onDispatchStart?.(structuredClone(dispatch));
      if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed before dispatch.');
      dispatched = true;
    };
    const request = (async () => {
      try {
        if (!this.registryOptions.provisionOwnsDispatchBoundary) await beforeDispatch();
        return await this.provision(structuredClone(account), pending.options, operationOptions, {
          idempotencyKey,
          beforeDispatch,
          requireIdempotencyKey: Boolean(
            options.idempotencyKey ||
            this.storage?.compareAndSet ||
            this.registryOptions.onDispatchStart ||
            this.registryOptions.onResult
          ),
        });
      } catch (error) {
        if (!dispatched) await releaseClaim();
        throw error;
      }
    })().then(async initial => {
      let result = initial;
      pending.result = result;
      if (dispatched) await this.registryOptions.onResult?.({ ...structuredClone(dispatch), result });
      notify(result);
      if (this.key(account) !== key) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
      if (!result.success) {
        // A typed correctable/terminal rejection is definitive; unknown transport outcomes retain the claim.
        if (!dispatched || isDefinitiveRejection(result)) await releaseClaim();
        throw (
          adcpErrorToTypedError(result.adcpError ?? { code: 'ACCOUNT_NOT_FOUND', message: result.error }) ??
          new Error(result.error)
        );
      }
      if (result.status !== 'completed') {
        const provisional: ProvisionedAccount = {
          account: structuredClone(account),
          status: 'provisioning',
          setupTerms: current?.setupTerms ?? terms,
          ...((result.metadata.serverTaskId ?? result.metadata.taskId) && {
            pendingTaskId: result.metadata.serverTaskId ?? result.metadata.taskId,
          }),
        };
        await this.enqueue(async () => {
          const latest = await this.get(account);
          if (
            this.storage?.compareAndSet
              ? latest?.revision === claimRevision && latest?.dispatch?.idempotencyKey === idempotencyKey
              : !latest ||
                latest.status === 'failed_provisioning' ||
                (latest.status === current?.status && latest.account_id === current?.account_id)
          ) {
            await this.write({ ...provisional, revision: latest?.revision, dispatch: latest?.dispatch }, scope);
            if (claimRevision !== undefined) claimRevision = (latest?.revision ?? 0) + 1;
          }
        });
        if (!result.submitted) return provisional;
        result = await result.submitted.waitForCompletion();
        pending.result = result;
        await this.registryOptions.onResult?.({ ...structuredClone(dispatch), result });
        notify(result);
        if (!result.success) {
          if (this.storage?.compareAndSet) {
            if (isDefinitiveRejection(result)) await releaseClaim();
          } else {
            await this.enqueue(async () => {
              const latest = await this.get(account);
              if (!latest || latest.status === 'provisioning')
                await this.write(
                  {
                    account: structuredClone(account),
                    status: 'failed_provisioning',
                    setupTerms: current?.setupTerms ?? terms,
                  },
                  scope
                );
            });
          }
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
      await this.observeSync([account], result.data.accounts, false, observationEpoch, claimRevision);
      const entry = await this.get(account);
      if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
      if (!entry || entry.status === 'provisioning' || entry.status === 'failed_provisioning') {
        if (this.storage?.compareAndSet) await releaseClaim();
        else
          await this.enqueue(async () => {
            const latest = await this.get(account);
            if (!latest || ['provisioning', 'failed_provisioning'].includes(latest.status))
              await this.write(
                { account, status: 'failed_provisioning', setupTerms: current?.setupTerms ?? terms },
                scope
              );
          });
        const failed = result.data.accounts.find(row => row.action === 'failed');
        const error = failed?.errors?.[0];
        throw (
          (error && adcpErrorToTypedError(error)) ??
          new AccountNotFoundError('sync_accounts did not establish the requested account.')
        );
      }
      if (claimRevision !== undefined && entry.revision !== claimRevision + 1) return entry;
      let settled = entry;
      await this.enqueue(async () => {
        const latest = await this.get(account);
        if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
        if (!latest) throw new AccountNotFoundError('The provisioned account is no longer registered.');
        settled = latest;
        if (
          latest.account_id !== entry.account_id ||
          (this.storage?.compareAndSet && latest.revision !== entry.revision)
        )
          return; // An explicit sync replaced this handle.
        settled = { ...latest, setupTerms: setupTerms(options) };
        await this.write(settled, scope);
        settled = (await this.get(account)) ?? settled;
        if (settled.account_id && !('account_id' in account)) {
          const idEntry = await this.get({ account_id: settled.account_id });
          if (scope !== this.scope()) throw new AccountNotFoundError('Caller credentials changed during provisioning.');
          if (idEntry) await this.write({ ...idEntry, setupTerms: settled.setupTerms }, scope);
        }
      });
      return settled;
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
  private async write(entry: ProvisionedAccount, scope: string, isCurrent: () => boolean = () => true): Promise<void> {
    if (!isCurrent()) return;
    const key = this.key(entry.account, scope);
    if (this.storage?.compareAndSet) {
      const revision = entry.revision;
      entry = { ...entry, revision: (revision ?? 0) + 1 };
      if (!(await this.storage.compareAndSet(key, revision, structuredClone(entry))))
        throw new AccountSetupRequiredError('Account storage revision changed. Reload and reconcile before retrying.');
    } else {
      await this.storage?.set(key, structuredClone(entry));
    }
    if (scope === this.scope()) this.remember(key, entry);
  }
  private async record(
    ref: AccountReference,
    row: AccountRow,
    scope: string,
    preserveTerms = false,
    isCurrent: () => boolean = () => true,
    expectedRevision?: number
  ): Promise<void> {
    const entry: ProvisionedAccount = {
      account: structuredClone(ref),
      status: row.status!,
      ...(row.account_id && { account_id: row.account_id }),
    };
    const prior = await this.get(ref);
    if (expectedRevision !== undefined && prior?.revision !== expectedRevision) return;
    if (scope !== this.scope() || !isCurrent()) return;
    const idRef = row.account_id && !('account_id' in ref) ? { account_id: row.account_id } : undefined;
    const priorId = idRef ? await this.get(idRef) : undefined;
    if (scope !== this.scope() || !isCurrent()) return;
    const aliases = new Map((priorId?.aliases ?? []).map(alias => [accountReferenceKey(alias), alias]));
    if (idRef) {
      aliases.set(accountReferenceKey(ref), structuredClone(ref));
      if (aliases.size > this.maxEntries)
        throw new AccountSetupRequiredError('Account alias capacity reached; increase registry maxEntries.');
    }
    if (!('account_id' in ref) && prior?.account_id && prior.account_id !== row.account_id) {
      const oldId = await this.get({ account_id: prior.account_id });
      if (scope !== this.scope() || !isCurrent()) return;
      if (oldId?.aliases) {
        await this.write(
          { ...oldId, aliases: oldId.aliases.filter(alias => accountReferenceKey(alias) !== accountReferenceKey(ref)) },
          scope,
          isCurrent
        );
      }
    }
    entry.revision = prior?.revision;
    if (preserveTerms && prior?.setupTerms) entry.setupTerms = prior.setupTerms;
    if ('account_id' in ref) {
      if (prior?.aliases) entry.aliases = prior.aliases;
    }
    await this.write(entry, scope, isCurrent);
    if (!idRef || scope !== this.scope() || !isCurrent()) return;
    await this.write(
      {
        account: idRef,
        revision: priorId?.revision,
        account_id: row.account_id,
        status: row.status!,
        aliases: [...aliases.values()],
        ...(preserveTerms && priorId?.setupTerms && { setupTerms: priorId.setupTerms }),
      },
      scope,
      isCurrent
    );
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.writes.then(run);
    this.writes = next.catch(() => {});
    return next;
  }
  async observeSync(
    refs: readonly AccountReference[],
    rows: readonly unknown[],
    dryRun = false,
    observationEpoch?: number,
    expectedRevision?: number
  ): Promise<void> {
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
        let row = candidates[0] as AccountRow;
        if (row.action === 'failed' || typeof row.status !== 'string') continue;
        const prior = await this.get(ref);
        if (scope !== this.scope()) return;
        let rowEpoch = observationEpoch;
        let repairedBinding = false;
        if (!this.observationIsCurrent(row.account_id, rowEpoch, scope)) {
          if (!row.account_id || (prior?.account_id && prior.account_id !== row.account_id)) continue;
          const captured = this.captureObservation();
          const authoritative = await this.get({ account_id: row.account_id });
          if (scope !== this.scope()) return;
          row = {
            ...row,
            status: captured === this.captureObservation() ? (authoritative?.status ?? 'unknown') : 'unknown',
          };
          rowEpoch = this.captureObservation();
          repairedBinding = true;
        }
        const isCurrent = () => scope === this.scope() && this.observationIsCurrent(row.account_id, rowEpoch, scope);
        await this.record(ref, row, scope, false, isCurrent, expectedRevision);
        if (!isCurrent() || repairedBinding) continue;
        for (const id of [row.account_id])
          if (id) {
            const key = this.key({ account_id: id }, scope);
            this.repairs.delete(key);
            this.invalidatedHandles.delete(key);
          }
      }
    });
  }
  private async reconcileId(
    accountId: string,
    status: string,
    scope: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (scope !== this.scope() || !isCurrent()) return;
    const idRef = { account_id: accountId };
    const indexed = await this.get(idRef);
    if (scope !== this.scope() || !isCurrent()) return;
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
      if (scope !== this.scope() || !isCurrent()) return;
      if (!prior || prior.account_id !== accountId) {
        aliases.delete(accountReferenceKey(ref));
        continue;
      }
      await this.write({ ...prior, account: ref, account_id: accountId, status }, scope, isCurrent);
    }
    if (scope !== this.scope() || !isCurrent()) return;
    if (indexed || aliases.size)
      await this.write(
        { ...indexed, account: idRef, account_id: accountId, status, aliases: [...aliases.values()] },
        scope,
        isCurrent
      );
  }
  async observeList(rows: readonly unknown[], queriedAccountId?: string, observationEpoch?: number): Promise<void> {
    const scope = this.scope();
    return this.observeListAtScope(rows, queriedAccountId, scope, undefined, observationEpoch);
  }
  private async observeListAtScope(
    rows: readonly unknown[],
    queriedAccountId: string | undefined,
    scope: string,
    isCurrent?: () => boolean,
    observationEpoch?: number
  ): Promise<void> {
    return this.enqueue(async () => {
      if (scope !== this.scope() || (isCurrent && !isCurrent())) return;
      if (!this.observationIsCurrent(queriedAccountId, observationEpoch, scope)) return;
      let foundQuery = false;
      for (const value of rows) {
        if (!value || typeof value !== 'object') continue;
        const row = value as AccountRow;
        if (typeof row.account_id !== 'string' || typeof row.status !== 'string') continue;
        if (!this.observationIsCurrent(row.account_id, observationEpoch, scope)) continue;
        const current = () =>
          scope === this.scope() &&
          (!isCurrent || isCurrent()) &&
          this.observationIsCurrent(row.account_id, observationEpoch, scope);
        if (row.account_id === queriedAccountId) foundQuery = true;
        await this.reconcileId(row.account_id, row.status, scope, current);
        await this.record({ account_id: row.account_id }, row, scope, true, current);
        if (row.brand?.domain && row.operator) {
          const ref: AccountReference = {
            brand: row.brand,
            operator: row.operator,
            ...(row.operator_unit && { operator_unit: row.operator_unit }),
            ...(row.currency && { currency: row.currency }),
            ...(row.timezone && { timezone: row.timezone }),
            ...(row.sandbox !== undefined && { sandbox: row.sandbox }),
          };
          const prior = await this.get(ref);
          if (scope !== this.scope()) return;
          // A roster/status lookup cannot undo an explicit sync to a replacement handle.
          if (!prior?.account_id || prior.account_id === row.account_id)
            await this.record(ref, row, scope, true, current);
        }
        if (!isCurrent && current()) {
          const key = this.key({ account_id: row.account_id }, scope);
          this.repairs.delete(key);
          this.invalidatedHandles.delete(key);
        }
      }
      if (queriedAccountId && !foundQuery) {
        const current = () =>
          scope === this.scope() &&
          (!isCurrent || isCurrent()) &&
          this.observationIsCurrent(queriedAccountId, observationEpoch, scope);
        await this.reconcileId(queriedAccountId, 'unknown', scope, current);
        if (!isCurrent && current()) {
          const key = this.key({ account_id: queriedAccountId }, scope);
          this.repairs.delete(key);
          this.invalidatedHandles.delete(key);
        }
      }
    });
  }
  /** After verifying account.status_changed, repair aliases by handle from the authoritative seller. */
  async applyStatusChange(notification: { account_id: string }, options?: TaskOptions): Promise<void> {
    return this.repairStatus(notification.account_id, options, true);
  }
  private async repairStatus(accountId: string, options: TaskOptions | undefined, invalidate: boolean): Promise<void> {
    throwIfAborted(options?.signal);
    const key = this.key({ account_id: accountId });
    let operation = !invalidate ? this.repairWaiters.get(key) : undefined;
    if (!operation) {
      operation = this.runRepair(accountId, { ...options, signal: undefined, timeout: undefined }, invalidate);
      this.repairWaiters.set(key, operation);
      const cleanup = () => {
        if (this.repairWaiters.get(key) === operation) this.repairWaiters.delete(key);
      };
      void operation.then(cleanup, cleanup);
    }
    const wait = (promise: Promise<void>) =>
      withTaskDeadline(options, taskOptions => withAbortSignal([taskOptions.signal], undefined, () => promise));
    await wait(operation);
    let newer = this.repairWaiters.get(key);
    while (newer && newer !== operation) {
      operation = newer;
      await wait(operation);
      newer = this.repairWaiters.get(key);
    }
  }
  private async runRepair(accountId: string, options: TaskOptions | undefined, invalidate: boolean): Promise<void> {
    if (!this.repair) throw new Error('Account registry requires a list_accounts repair callback.');
    const scope = this.scope();
    const key = this.key({ account_id: accountId }, scope);
    const token = {};
    this.statusEpochs.delete(key);
    this.statusEpochs.set(key, ++this.observationEpoch);
    if (this.statusEpochs.size > this.maxEntries) {
      const oldestKey = this.statusEpochs.keys().next().value!;
      this.observationFloor = this.statusEpochs.get(oldestKey)!;
      this.statusEpochs.delete(oldestKey);
    }
    this.repairs.set(key, token);
    if (invalidate) this.invalidatedHandles.add(key);
    let invalidationPersisted = !invalidate;
    try {
      if (invalidate) {
        await this.enqueue(() => this.reconcileId(accountId, 'unknown', scope, () => this.repairs.get(key) === token));
        invalidationPersisted = true;
      }
      const rows = (await this.repair(accountId, options)).filter(
        row => row !== null && typeof row === 'object' && (row as AccountRow).account_id === accountId
      );
      await this.observeListAtScope(rows, accountId, scope, () => this.repairs.get(key) === token);
    } finally {
      if (this.repairs.get(key) === token) {
        this.repairs.delete(key);
        if (invalidationPersisted) this.invalidatedHandles.delete(key);
      }
    }
  }
}
