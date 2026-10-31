import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AccountReference,
  BusinessEntity,
  PaymentTerms,
  RequestAccountRequest,
  RequestAccountResponse,
  SyncAccountsResponse,
} from '../types/tools.generated';
import type { AccountRequest, AccountRequestState, PendingAction } from '../types/core.generated';
import { SELLER_REVIEW, pendingActionFromWire, type AccountOutcome, type AccountVia } from './account-outcomes';
import type { TaskOptions, TaskResult } from './ConversationTypes';
import { accountReferenceKey } from './account-key';
import { sameCountrySet } from './account-resolution';
import { adcpErrorToTypedError, AccountNotFoundError, AccountRequestError, AccountSetupRequiredError } from '../errors';
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
  /** `ensure` only: joins the natural key when the key does not carry `currency`. */
  currency?: string;
  /** `ensure` only: joins the natural key when the key does not carry `timezone`. */
  timezone?: string;
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
  /**
   * Set on a buyer key that reached the seller reduced to an older release's
   * account key (`accountIdentityDowngrade: 'reduce'`): the key the seller
   * knows the account by, and the release it was reduced for.
   */
  reduction?: { account: AccountReference; adcpVersion: string };
  /** Set on a reduced seller key: the one buyer key allowed to use it. */
  reducedFrom?: AccountReference;
  /** The seller's `request_account` request behind this natural key (AdCP 3.3 `account.requests`). */
  requestId?: string;
  /** The request's last observed state. */
  requestState?: AccountRequestState;
  /** The last observed pending action of an open request or a `sync_accounts` row pending approval. */
  pendingAction?: PendingAction;
}
/** Partitioned by seller and caller scope. Implementations must provide read-your-writes. */
export interface BuyerAccountStorage {
  get(key: string): Promise<ProvisionedAccount | undefined>;
  set(key: string, account: ProvisionedAccount): Promise<void>;
  /** Read the ID alias within this exact seller/caller scope, equivalent to get(scope + ':' + accountReferenceKey({ account_id })). */
  getByAccountId?(accountId: string, scope: string): Promise<ProvisionedAccount | undefined>;
  /** Atomically insert (undefined revision) or replace. Store the supplied new revision. Required for multi-process safety. */
  compareAndSet?(key: string, expectedRevision: number | undefined, account: ProvisionedAccount): Promise<boolean>;
  /**
   * Every row stored under this exact seller/caller scope (keys starting `scope + ':'`). Optional: without
   * it `client.accounts.refresh()` and `pending()` see only the keys this process ensured.
   */
  list?(scope: string): Promise<ProvisionedAccount[]>;
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
  /** @internal Only implicit routing caches may evict; explicitly used provisioning registries retain their state. */
  evictAtCapacity?: () => boolean;
  normalizeOptions?: (options: EnsureAccountOptions, taskOptions?: TaskOptions) => Promise<EnsureAccountOptions>;
  /**
   * @internal The seller's `account.requests` lifecycle, supplied by the client: whether the seller
   * advertises it, `request_account`, and reading the caller's requests back through `list_accounts`.
   */
  requests?: {
    supported(taskOptions?: TaskOptions): Promise<boolean>;
    request(params: RequestAccountRequest, taskOptions?: TaskOptions): Promise<TaskResult<RequestAccountResponse>>;
    read(requestIds: readonly string[], taskOptions?: TaskOptions): Promise<AccountRequest[]>;
  };
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

/** Whether a sync_accounts row is the account the reference names. */
function rowMatchesReference(ref: AccountReference, row: AccountRow): boolean {
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
}

export class BuyerAccountRegistry {
  private entries = new Map<string, ProvisionedAccount>();
  /** Reduction bindings when no storage is configured (never evicted). */
  private reductions = new Map<string, ProvisionedAccount>();
  private inFlight = new Map<string, PendingProvisioning>();
  private writes: Promise<void> = Promise.resolve();
  private repairs = new Map<string, object>();
  private repairWaiters = new Map<string, Promise<void>>();
  private invalidatedHandles = new Set<string>();
  private observationEpoch = 0;
  private observationFloor = 0;
  private statusEpochs = new Map<string, number>();
  private readonly maxEntries: number;
  private provisioningAccessed = false;
  private readonly normalizeOptions?: BuyerAccountRegistryOptions['normalizeOptions'];
  constructor(
    private scope: () => string,
    private provisionAccount: (
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
      if (!this.storage && !this.canEvict())
        throw new AccountSetupRequiredError(
          'Account registry capacity reached; configure durable storage or increase maxEntries.'
        );
      this.entries.delete(this.entries.keys().next().value!);
    }
    // Refresh recency when updating an existing alias, so the following natural
    // binding cannot evict the ID that was just published for it.
    this.entries.delete(key);
    this.entries.set(key, structuredClone(entry));
  }
  private canEvict(): boolean {
    return !this.provisioningAccessed && this.registryOptions.evictAtCapacity?.() === true;
  }
  async get(account: AccountReference): Promise<ProvisionedAccount | undefined> {
    const scope = this.scope();
    const key = this.key(account);
    let entry = this.storage?.compareAndSet ? await this.storage.get(key) : this.entries.get(key);
    if (!entry && !this.storage?.compareAndSet) {
      const persisted = await this.storage?.get(key);
      entry = this.entries.get(key) ?? persisted; // A setup may have settled while storage was reading.
    }
    if (!entry && 'account_id' in account && this.storage?.getByAccountId) {
      const persisted = await this.storage.getByAccountId(account.account_id, scope);
      entry = this.storage.compareAndSet ? persisted : (this.entries.get(key) ?? persisted);
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
  /** Lookup by seller-issued ID, partitioned by the registry's seller and caller. */
  async getByAccountId(accountId: string): Promise<ProvisionedAccount | undefined> {
    return this.get({ account_id: accountId });
  }
  /**
   * Low-level: provision an account through `sync_accounts` and return the registry's record. This is
   * what `ensure` returned before AdCP 3.3; most callers want {@link BuyerAccountRegistry.ensure}, which
   * also routes to `request_account` and returns an `AccountOutcome`.
   */
  async provision(
    account: AccountReference,
    options: EnsureAccountOptions = {},
    taskOptions?: TaskOptions,
    onTaskResult?: (result: TaskResult<unknown>) => void
  ): Promise<ProvisionedAccount> {
    this.provisioningAccessed = true;
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
    const shared = this.inFlight.get(key);
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
    if (!this.storage && this.entries.size + this.inFlight.size * 2 + requiredEntries > this.maxEntries) {
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
        return await this.provisionAccount(structuredClone(account), pending.options, operationOptions, {
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
    this.inFlight.set(key, pending);
    const cleanup = () => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    };
    void request.then(cleanup, cleanup);
    const entry = await wait(request);
    if (callbackFailed) throw callbackError;
    return entry;
  }
  /** Natural keys this process ensured, for storage that cannot enumerate. */
  private touched = new Set<string>();
  /** Serializes `ensure` per natural key, so concurrent calls never open two requests. */
  private ensuring = new Map<string, Promise<unknown>>();

  /**
   * Get an account for a natural key at this seller (AdCP 3.3). Routes by capability: `request_account`
   * when the seller advertises `account.requests`, otherwise `sync_accounts`. Either way it resolves to an
   * {@link AccountOutcome}: `ready`, `pending`, `ambiguous` or `rejected`. Pending, ambiguous and rejected
   * are values, not errors; only a failure to process the call throws (`AccountRequestError` on the
   * `request_account` path, the typed account errors on `sync_accounts`).
   *
   * Idempotent per (seller, caller, natural key): a repeat call returns the account, or the open request's
   * current state, and never opens a duplicate. `currency` and `timezone` join the key when it does not
   * carry them. Billing terms are sent only when an account is first requested.
   *
   * Breaking in SDK 17 (AdCP 3.3): `ensure` used to resolve to the registry's `ProvisionedAccount`. That
   * call is now {@link BuyerAccountRegistry.provision}.
   */
  async ensure(
    account: AccountReference,
    options: EnsureAccountOptions = {},
    taskOptions?: TaskOptions
  ): Promise<AccountOutcome> {
    const { currency, timezone, ...terms } = options;
    let ref = structuredClone(account);
    if (!('account_id' in ref)) {
      if (currency !== undefined && ref.currency === undefined) ref = { ...ref, currency };
      if (timezone !== undefined && ref.timezone === undefined) ref = { ...ref, timezone };
    }
    const key = this.key(ref);
    const previous = this.ensuring.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.ensureOnce(ref, terms, taskOptions));
    this.ensuring.set(key, run);
    const cleanup = () => {
      if (this.ensuring.get(key) === run) this.ensuring.delete(key);
    };
    void run.then(cleanup, cleanup);
    return run;
  }

  private async ensureOnce(
    ref: AccountReference,
    terms: EnsureAccountOptions,
    taskOptions?: TaskOptions
  ): Promise<AccountOutcome> {
    this.provisioningAccessed = true;
    const requests = this.registryOptions.requests;
    const natural = !('account_id' in ref);
    if (natural) this.touched.add(this.key(ref));
    const viaRequests = natural && requests !== undefined && (await requests.supported(taskOptions));
    if (viaRequests) {
      const existing = await this.get(ref);
      if (existing) {
        const known = await this.knownOutcome(ref, existing, true, taskOptions);
        if (known) return known;
      }
      const body: Record<string, unknown> = { ...ref };
      if (terms.billing !== undefined) body.billing = terms.billing;
      if (terms.paymentTerms !== undefined) body.payment_terms = terms.paymentTerms;
      if (terms.billingEntity !== undefined) body.billing_entity = terms.billingEntity;
      const followed = existing?.requestState === 'rejected' ? existing.requestId : undefined;
      return this.sendRequest(
        ref,
        {
          idempotency_key: terms.idempotencyKey ?? this.ensureKey(body, followed),
          ...body,
        } as RequestAccountRequest,
        taskOptions
      );
    }
    let captured: TaskResult<unknown> | undefined;
    let entry: ProvisionedAccount;
    try {
      entry = await this.provision(ref, terms, taskOptions, result => {
        captured = result;
      });
    } catch (error) {
      const row = this.syncRow(captured);
      if (row && (row.action === 'failed' || row.status === 'rejected')) return this.syncRejected(row);
      throw error;
    }
    const row = this.syncRow(captured);
    if (entry.status === 'rejected') return this.syncRejected(row);
    if (entry.status === 'pending_approval' && row?.setup && natural) {
      const action = pendingActionFromWire(row.setup);
      const latest = await this.get(ref);
      if (latest && !isDeepStrictEqual(latest.pendingAction, action))
        await this.write({ ...latest, pendingAction: action }, this.scope());
      return this.syncOutcome({ ...entry, pendingAction: action });
    }
    return this.syncOutcome(entry);
  }

  /** A deterministic `request_account` idempotency key: one request per (seller, caller, body). */
  private ensureKey(body: unknown, previous?: string): string {
    const digest = createHash('sha256')
      .update(JSON.stringify([this.scope(), body, previous ?? null]))
      .digest('hex');
    return `adcp-ensure-${digest.slice(0, 48)}`;
  }

  private syncRow(result: TaskResult<unknown> | undefined): Record<string, any> | undefined {
    const data = result?.data as { accounts?: Record<string, any>[] } | undefined;
    return Array.isArray(data?.accounts) ? data.accounts[0] : undefined;
  }

  private syncRejected(row: Record<string, any> | undefined): AccountOutcome {
    const errors = Array.isArray(row?.errors) && row.errors.length > 0 ? row.errors : undefined;
    return {
      kind: 'rejected',
      errors: structuredClone(errors ?? [{ code: 'ACCOUNT_REJECTED', message: 'The seller declined the account' }]),
      via: 'sync_accounts',
    };
  }

  /** The outcome of a `sync_accounts`-path record. */
  private syncOutcome(entry: ProvisionedAccount): AccountOutcome {
    if (entry.status === 'pending_approval' || entry.status === 'provisioning') {
      return {
        kind: 'pending',
        action: structuredClone(
          entry.pendingAction ??
            (entry.status === 'provisioning'
              ? { ...SELLER_REVIEW, message: 'The seller is still provisioning the account' }
              : SELLER_REVIEW)
        ),
        via: 'sync_accounts',
        ...(entry.account_id ? { account_id: entry.account_id } : {}),
        status: entry.status,
      };
    }
    if (entry.status === 'rejected') return this.syncRejected(undefined);
    return {
      kind: 'ready',
      ...(entry.account_id ? { account_id: entry.account_id } : {}),
      status: entry.status,
      via: 'sync_accounts',
    };
  }

  /** The outcome a stored record already answers, or `undefined` to request again. */
  private async knownOutcome(
    ref: AccountReference,
    record: ProvisionedAccount,
    requests: boolean,
    taskOptions?: TaskOptions
  ): Promise<AccountOutcome | undefined> {
    if (record.requestId && (record.requestState === 'in_review' || record.requestState === 'ambiguous') && requests) {
      const [wire] = (await this.registryOptions.requests!.read([record.requestId], taskOptions)).filter(
        item => item.request_id === record.requestId
      );
      // The seller no longer knows the request (expired or dropped): request again.
      return wire ? this.recordRequest(ref, wire, taskOptions) : undefined;
    }
    if (record.requestState === 'rejected' && !record.account_id) return undefined;
    if (record.status === 'failed_provisioning' || record.status === 'unknown') return undefined;
    if (!record.account_id && !record.requestId) return undefined;
    const via: AccountVia = record.requestId ? 'request_account' : 'sync_accounts';
    if (via === 'sync_accounts') return this.syncOutcome(record);
    if (record.status === 'pending_approval') {
      return {
        kind: 'pending',
        action: structuredClone(record.pendingAction ?? SELLER_REVIEW),
        via,
        request_id: record.requestId!,
        ...(record.account_id ? { account_id: record.account_id } : {}),
        status: record.status,
      };
    }
    return {
      kind: 'ready',
      ...(record.account_id ? { account_id: record.account_id } : {}),
      status: record.status,
      via,
      request_id: record.requestId!,
    };
  }

  private async sendRequest(
    ref: AccountReference,
    params: RequestAccountRequest,
    taskOptions?: TaskOptions
  ): Promise<AccountOutcome> {
    const result = await this.registryOptions.requests!.request(params, taskOptions);
    const body = (result.data ?? {}) as Partial<RequestAccountResponse>;
    if (!result.success || body.adcp_error || !body.request || typeof body.request !== 'object') {
      const errors = (body.errors as { code: string; message?: string }[] | undefined)?.length
        ? body.errors!
        : [result.adcpError ?? { code: 'SERVICE_UNAVAILABLE', message: result.error ?? 'request_account failed' }];
      throw new AccountRequestError('request_account', structuredClone(errors) as never);
    }
    return this.recordRequest(ref, body.request, taskOptions);
  }

  /** Persist a request's state under its natural key and return its outcome. */
  private async recordRequest(
    ref: AccountReference,
    wire: AccountRequest,
    taskOptions?: TaskOptions
  ): Promise<AccountOutcome> {
    const scope = this.scope();
    const requestId = wire.request_id;
    let outcome: AccountOutcome;
    if (wire.state === 'resolved' && wire.account_id) {
      const status = String((wire.account as { status?: string } | undefined)?.status ?? 'active');
      outcome = {
        kind: 'ready',
        account_id: wire.account_id,
        status,
        via: 'request_account',
        request_id: requestId,
        ...(wire.account ? { account: structuredClone(wire.account) as unknown as Record<string, unknown> } : {}),
      };
      // Publish the account_id alias too, so resolveAccount and account-scoped tasks find it.
      await this.record(ref, { account_id: wire.account_id, status }, scope);
    } else if (wire.state === 'in_review') {
      outcome = {
        kind: 'pending',
        action: pendingActionFromWire(wire.pending_action),
        via: 'request_account',
        request_id: requestId,
      };
    } else if (wire.state === 'ambiguous') {
      outcome = {
        kind: 'ambiguous',
        candidates: structuredClone(wire.candidates ?? []),
        request_id: requestId,
        via: 'request_account',
        choose: accountId => this.choose(ref, requestId, accountId, wire.candidates ?? [], taskOptions),
      };
    } else {
      outcome = {
        kind: 'rejected',
        errors: structuredClone(
          wire.errors?.length
            ? wire.errors
            : [{ code: 'ACCOUNT_REQUEST_REJECTED', message: 'The seller declined the request' }]
        ),
        via: 'request_account',
        request_id: requestId,
      };
    }
    const latest = await this.get(ref);
    const ready = outcome.kind === 'ready' ? outcome : undefined;
    const { pendingAction: _previousAction, ...kept } = latest ?? ({ account: ref } as ProvisionedAccount);
    void _previousAction;
    await this.write(
      {
        ...kept,
        account: structuredClone(ref),
        status: ready ? ready.status! : wire.state === 'rejected' ? 'rejected' : 'requested',
        ...(ready?.account_id ? { account_id: ready.account_id } : {}),
        requestId,
        requestState: wire.state,
        ...(outcome.kind === 'pending' ? { pendingAction: outcome.action } : {}),
      },
      scope
    );
    if (!('account_id' in ref)) this.touched.add(this.key(ref, scope));
    return outcome;
  }

  private async choose(
    ref: AccountReference,
    requestId: string,
    accountId: string,
    candidates: readonly { account_id?: string }[],
    taskOptions?: TaskOptions
  ): Promise<AccountOutcome> {
    if (!candidates.some(candidate => candidate.account_id === accountId))
      throw new TypeError(`${JSON.stringify(accountId)} is not one of this request's candidates.`);
    return this.sendRequest(
      ref,
      {
        idempotency_key: this.ensureKey({ request_id: requestId, account_id: accountId }),
        request_id: requestId,
        account_id: accountId,
      },
      taskOptions
    );
  }

  /** The natural-key records stored under the current seller and caller. */
  private async known(): Promise<ProvisionedAccount[]> {
    const scope = this.scope();
    const byKey = new Map<string, ProvisionedAccount>();
    if (this.storage?.list) {
      for (const entry of await this.storage.list(scope)) byKey.set(this.key(entry.account, scope), entry);
    }
    const prefix = `${scope}:`;
    const keys = new Set([...this.touched, ...[...this.entries.keys()]].filter(key => key.startsWith(prefix)));
    for (const key of keys) {
      if (byKey.has(key)) continue;
      const entry = this.entries.get(key) ?? (await this.storage?.get(key));
      if (entry) byKey.set(key, entry);
    }
    return [...byKey.values()].filter(entry => !('account_id' in entry.account));
  }

  /**
   * The outcomes still waiting: open requests in review and accounts pending approval. Read from the
   * registry; no network call. Use {@link BuyerAccountRegistry.refresh} to learn what moved.
   */
  async pending(): Promise<AccountOutcome[]> {
    const result: AccountOutcome[] = [];
    for (const record of await this.known()) {
      // An ambiguous request's candidates live with the seller; refresh() reads them.
      if (record.requestState === 'ambiguous') continue;
      if (record.requestState === 'in_review' || record.status === 'pending_approval') {
        result.push({
          kind: 'pending',
          action: structuredClone(record.pendingAction ?? SELLER_REVIEW),
          via: record.requestId ? 'request_account' : 'sync_accounts',
          ...(record.requestId ? { request_id: record.requestId } : {}),
          ...(record.account_id ? { account_id: record.account_id } : {}),
          status: record.status,
        });
      }
    }
    return result;
  }

  /**
   * Re-read open requests and accounts pending approval; resolve to the outcomes whose state moved. Call
   * it from a cron job or an `account_request.changed` webhook. One `list_accounts` read covers every
   * open request (`request_ids`); each account pending approval is re-read by its `account_id`.
   */
  async refresh(taskOptions?: TaskOptions): Promise<AccountOutcome[]> {
    const known = await this.known();
    const open = known.filter(
      record => record.requestId && (record.requestState === 'in_review' || record.requestState === 'ambiguous')
    );
    const pendingAccounts = known.filter(
      record => !record.requestId && record.status === 'pending_approval' && record.account_id
    );
    const moved: AccountOutcome[] = [];
    if (open.length > 0 && this.registryOptions.requests) {
      const wire = new Map(
        (
          await this.registryOptions.requests.read(
            open.map(record => record.requestId!),
            taskOptions
          )
        ).map(item => [item.request_id, item])
      );
      for (const record of open) {
        const current = wire.get(record.requestId!);
        if (!current) continue;
        const action = current.state === 'in_review' ? pendingActionFromWire(current.pending_action) : undefined;
        if (current.state === record.requestState && isDeepStrictEqual(action, record.pendingAction)) continue;
        moved.push(await this.recordRequest(record.account, current, taskOptions));
      }
    }
    for (const record of pendingAccounts) {
      if (!this.repair) break;
      await this.repairStatus(record.account_id!, taskOptions, false);
      const latest = await this.get(record.account);
      if (latest && latest.status !== record.status) moved.push(this.syncOutcome(latest));
    }
    return moved;
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
      if (aliases.size > this.maxEntries) {
        if (!this.canEvict())
          throw new AccountSetupRequiredError('Account alias capacity reached; increase registry maxEntries.');
        aliases.delete(aliases.keys().next().value!);
      }
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
    // Publish the ID alias before a natural-key reader can select that ID.
    if (idRef) {
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
    if (scope === this.scope() && isCurrent()) await this.write(entry, scope, isCurrent);
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
        const isRow = (value: unknown): value is AccountRow => !!value && typeof value === 'object';
        let candidates = rows.filter(value => isRow(value) && rowMatchesReference(ref, value));
        if (candidates.length === 0 && !('account_id' in ref)) {
          // A seller on an older release answers with the reduced key it was sent.
          const reduction = (await this.reductionFor(ref))?.account;
          if (scope !== this.scope()) return;
          if (reduction) candidates = rows.filter(value => isRow(value) && rowMatchesReference(reduction, value));
        }
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

  private reductionKey(kind: 'reduction' | 'reduced', account: AccountReference, scope = this.scope()): string {
    return `${scope}:${kind}:${accountReferenceKey(account)}`;
  }
  private async readReduction(key: string): Promise<ProvisionedAccount | undefined> {
    const entry = this.storage ? await this.storage.get(key) : this.reductions.get(key);
    return entry && entry.status === 'reduced' ? structuredClone(entry) : undefined;
  }
  /** Insert-if-absent; returns false when another writer already holds the key. */
  private async insertReduction(key: string, entry: ProvisionedAccount): Promise<boolean> {
    const prior = this.storage ? await this.storage.get(key) : this.reductions.get(key);
    if (prior && prior.status === 'reduced') return false;
    if (this.storage?.compareAndSet) {
      return this.storage.compareAndSet(key, prior?.revision, { ...entry, revision: (prior?.revision ?? 0) + 1 });
    }
    if (this.storage) await this.storage.set(key, structuredClone(entry));
    else this.reductions.set(key, structuredClone(entry));
    return true;
  }
  private async replaceReduction(key: string, entry: ProvisionedAccount): Promise<void> {
    const prior = this.storage ? await this.storage.get(key) : this.reductions.get(key);
    if (this.storage?.compareAndSet) {
      const next = { ...entry, revision: (prior?.revision ?? 0) + 1 };
      if (!(await this.storage.compareAndSet(key, prior?.revision, next)))
        throw new AccountSetupRequiredError('Account storage revision changed. Reload and reconcile before retrying.');
    } else if (this.storage) await this.storage.set(key, structuredClone(entry));
    else this.reductions.set(key, structuredClone(entry));
  }

  /**
   * Bind reduced account keys to the buyer keys they came from, before a
   * request carrying them is sent to a seller on an older release. Each
   * reduced key serves one buyer key only. A key sent unreduced claims itself
   * (`account` and `reduced` equal), so a plain key and a reduced one can never
   * land on the same seller account in either order.
   *
   * All-or-nothing: every claim is checked, against storage and against the
   * other claims in the same request, before any is written. On a conflict
   * nothing is written and the index and owner of the first conflicting claim
   * are returned. A claim lost to a concurrent writer rolls back the claims
   * this call already wrote.
   */
  async claimReductions(
    claims: ReadonlyArray<{ account: AccountReference; reduced: AccountReference; adcpVersion: string }>
  ): Promise<{ index: number; owner: AccountReference } | undefined> {
    const scope = this.scope();
    let conflict: { index: number; owner: AccountReference } | undefined;
    await this.enqueue(async () => {
      const pending = new Map<string, AccountReference>();
      const toInsert: number[] = [];
      for (const [index, claim] of claims.entries()) {
        const reducedKey = accountReferenceKey(claim.reduced);
        const inRequest = pending.get(reducedKey);
        if (inRequest && accountReferenceKey(inRequest) !== accountReferenceKey(claim.account)) {
          conflict = { index, owner: inRequest };
          return;
        }
        pending.set(reducedKey, claim.account);
        const owner = (await this.readReduction(this.reductionKey('reduced', claim.reduced, scope)))?.reducedFrom;
        if (owner && accountReferenceKey(owner) !== accountReferenceKey(claim.account)) {
          conflict = { index, owner };
          return;
        }
        if (!owner && !inRequest) toInsert.push(index);
      }
      const inserted: number[] = [];
      for (const index of toInsert) {
        const claim = claims[index]!;
        const reverseKey = this.reductionKey('reduced', claim.reduced, scope);
        const ok = await this.insertReduction(reverseKey, {
          account: structuredClone(claim.reduced),
          status: 'reduced',
          reducedFrom: structuredClone(claim.account),
        });
        const winner = ok ? undefined : (await this.readReduction(reverseKey))?.reducedFrom;
        if (!ok && winner && accountReferenceKey(winner) !== accountReferenceKey(claim.account)) {
          for (const done of inserted) {
            const doneClaim = claims[done]!;
            await this.replaceReduction(this.reductionKey('reduced', doneClaim.reduced, scope), {
              account: structuredClone(doneClaim.reduced),
              status: 'released',
            });
          }
          conflict = { index, owner: winner };
          return;
        }
        if (ok) inserted.push(index);
      }
      for (const claim of claims) {
        // A key sent unreduced owns itself; there is nothing to migrate later.
        if (accountReferenceKey(claim.account) === accountReferenceKey(claim.reduced)) continue;
        const forwardKey = this.reductionKey('reduction', claim.account, scope);
        const current = await this.readReduction(forwardKey);
        const reduction = { account: claim.reduced, adcpVersion: claim.adcpVersion };
        if (current?.reduction && isDeepStrictEqual(current.reduction, reduction)) continue;
        await this.replaceReduction(forwardKey, {
          account: structuredClone(claim.account),
          status: 'reduced',
          reduction: structuredClone(reduction),
        });
      }
    });
    return conflict;
  }

  /** The buyer key a reduced seller key was claimed for, if any. */
  async reductionOwner(reduced: AccountReference): Promise<AccountReference | undefined> {
    return (await this.readReduction(this.reductionKey('reduced', reduced)))?.reducedFrom;
  }

  /** The reduced key a buyer key reached an older seller with, if any. */
  async reductionFor(account: AccountReference): Promise<ProvisionedAccount['reduction']> {
    return (await this.readReduction(this.reductionKey('reduction', account)))?.reduction;
  }

  /**
   * Forget that `account` reached this seller under a reduced key. Call once
   * the account has moved to its full key: after a `sync_accounts` settings
   * update rekeys `operator_unit` in place, or after opening a new account
   * under the full key when the reduced fields (`currency`, `timezone`,
   * `brand.countries`) cannot change on an existing account. Until then the
   * client keeps addressing the seller account by its reduced key.
   */
  async clearReduction(account: AccountReference): Promise<void> {
    const scope = this.scope();
    await this.enqueue(async () => {
      const forwardKey = this.reductionKey('reduction', account, scope);
      const forward = await this.readReduction(forwardKey);
      if (!forward?.reduction) return;
      const reverseKey = this.reductionKey('reduced', forward.reduction.account, scope);
      const reverse = await this.readReduction(reverseKey);
      if (reverse?.reducedFrom && accountReferenceKey(reverse.reducedFrom) === accountReferenceKey(account)) {
        await this.replaceReduction(reverseKey, { account: reverse.account, status: 'released' });
      }
      await this.replaceReduction(forwardKey, { account: forward.account, status: 'released' });
    });
  }
}
