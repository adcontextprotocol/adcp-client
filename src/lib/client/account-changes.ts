import { ADCPError, ConfigurationError } from '../errors';
import type { AgentClient } from '../core/AgentClient';
import type { ListAccountChangesRequest, ListAccountChangesResponse } from '../types';
import type { TaskResult, TaskOptions } from '../core/ConversationTypes';
import { getSchemaValidatorByRef } from '../validation/schema-loader';
import {
  restoreAccountChangeCursor,
  AccountChangeCursorError,
  type DurableAccountChangeCursor,
} from './account-change-cursor';
import { assertAccountChangeJsonSize } from './account-change-json';

export type AccountChangePage = Extract<ListAccountChangesResponse, { status: 'completed' }>;
export type AccountChangeFailure = Extract<ListAccountChangesResponse, { status: 'failed' }>;
export type AccountChangeSourceCoverage = NonNullable<AccountChangePage['source_coverage']>[number];
/** Resolve natural account references with listAccounts before opening a scoped drain. */
export type AccountChangeAccount = Extract<ListAccountChangesRequest['account'], { account_id: string }>;

export class AccountChangeCursorExpiredError extends ADCPError {
  readonly code = 'CURSOR_EXPIRED';
  readonly recovery = 'correctable';
  constructor(public readonly result: TaskResult<ListAccountChangesResponse>) {
    super('Account change cursor expired. Acquire latest, rebuild authoritative snapshots, then drain.');
  }
}

export type AccountChangeDrainErrorCode =
  | 'account_change_read_failed'
  | 'account_change_page_invalid'
  | 'account_change_checkpoint_unacknowledged'
  | 'account_change_checkpoint_closed'
  | 'account_change_checkpoint_commit_in_progress';

export class AccountChangeDrainError extends ADCPError {
  constructor(
    public readonly code: AccountChangeDrainErrorCode,
    message: string,
    public readonly result?: TaskResult<ListAccountChangesResponse>
  ) {
    super(message);
  }
}

export interface AccountChangeBootstrapContext {
  readonly reason: 'initial' | 'cursor_expired';
  readonly account: AccountChangeAccount;
  readonly resourceTypes?: readonly string[];
  readonly error?: AccountChangeCursorExpiredError;
}

export interface StreamAccountChangesOptions {
  account: AccountChangeAccount;
  /** Restored from the same seller/principal/account/filter partition. */
  cursor?: DurableAccountChangeCursor;
  resourceTypes?: readonly string[];
  maxResults?: number;
  taskOptions?: TaskOptions;
  /**
   * Rebuild every authoritative snapshot in scope, including all statuses and
   * pages. A fresh latest cursor is acquired BEFORE this hook. No checkpoint
   * is offered until it succeeds and the subsequent feed page is processed.
   * Without this hook, first use drains earliest; expiry throws a typed error.
   */
  bootstrap?: (context: AccountChangeBootstrapContext) => Promise<void>;
}

export interface AccountChangeDrainPage extends Omit<AccountChangePage, 'cursor'> {
  /**
   * Call after repairing this page's invalidations. The hook owns the atomic
   * projection/checkpoint commit. Failure never advances the stream. Each page,
   * including an empty tail, must be acknowledged before requesting the next.
   */
  acknowledge(commit: (cursor: DurableAccountChangeCursor) => Promise<void>): Promise<void>;
}

/**
 * Drain to the seller's ingestion tail, using the client's typed, session-aware
 * listAccountChanges call. Opaque cursors are never compared or sorted, and
 * webhook targets never enter continuation requests. Poll again periodically.
 * The adopter owns storage, transaction atomicity and concurrency fencing.
 */
export async function* streamAccountChanges(
  client: Pick<AgentClient, 'listAccountChanges'>,
  options: StreamAccountChangesOptions
): AsyncGenerator<AccountChangeDrainPage, void, void> {
  if (options.resourceTypes?.length === 0) {
    throw new ConfigurationError(
      'Omit resourceTypes for an unfiltered feed; an explicit filter must be nonempty.',
      'resourceTypes'
    );
  }
  if (
    options.maxResults !== undefined &&
    (!Number.isInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > 100)
  ) {
    throw new ConfigurationError('maxResults must be an integer between 1 and 100.', 'maxResults');
  }
  const account = structuredClone(options.account);
  const resourceTypes = options.resourceTypes ? [...new Set(options.resourceTypes)].sort() : undefined;
  const request: ListAccountChangesRequest = {
    account,
    ...(resourceTypes && { resource_types: resourceTypes }),
    ...(options.maxResults !== undefined && { max_results: options.maxResults }),
  };
  const bootstrap = options.bootstrap;
  const taskOptions = options.taskOptions;
  let cursor: string | undefined;
  if (options.cursor !== undefined) {
    if (options.cursor?.kind !== 'checkpoint') {
      throw new AccountChangeCursorError();
    }
    cursor = restoreAccountChangeCursor(options.cursor.value).value;
  }
  let rebooted = false;

  const read = async (position: { cursor: string } | { starting_position: 'earliest' | 'latest' }) => {
    const result = await client.listAccountChanges(
      structuredClone({ ...request, ...position }),
      undefined,
      taskOptions
    );
    if (!result.success) {
      if (result.adcpError?.code === 'CURSOR_EXPIRED') throw new AccountChangeCursorExpiredError(result);
      throw new AccountChangeDrainError(
        'account_change_read_failed',
        'Account change read failed. Inspect result for diagnostics.',
        result
      );
    }
    if (result.status !== 'completed') {
      throw new AccountChangeDrainError(
        'account_change_read_failed',
        'Account change reads must complete synchronously.',
        result
      );
    }
    let page: ListAccountChangesResponse;
    try {
      // Up to 100 records of 64 KiB plus bounded page metadata. Check before
      // cloning to avoid multiplying a malformed response's memory footprint.
      assertAccountChangeJsonSize(result.data, 7 * 1024 * 1024);
      page = structuredClone(result.data);
    } catch {
      throw new AccountChangeDrainError(
        'account_change_page_invalid',
        'Account change page exceeds JSON bounds.',
        result
      );
    }
    const validator = getSchemaValidatorByRef('account/list-account-changes-response.json');
    if (!validator) throw new ConfigurationError('Bundled account change response schema is unavailable.', 'schemas');
    if (!validator(page)) {
      throw new AccountChangeDrainError('account_change_page_invalid', 'Invalid account change feed response.', result);
    }
    if (page.status === 'failed') {
      if (page.errors.some(error => error.code === 'CURSOR_EXPIRED')) throw new AccountChangeCursorExpiredError(result);
      throw new AccountChangeDrainError(
        'account_change_read_failed',
        'Account change feed returned a failure.',
        result
      );
    }
    for (const change of page.changes) {
      try {
        assertAccountChangeJsonSize(change, 64 * 1024);
      } catch {
        throw new AccountChangeDrainError(
          'account_change_page_invalid',
          'Account change record exceeds 64 KiB.',
          result
        );
      }
      if (
        change.resource.account_id !== account.account_id ||
        (change.resource.type === 'account' && change.resource.resource_id !== change.resource.account_id) ||
        (resourceTypes && !resourceTypes.includes(change.resource.type))
      ) {
        throw new AccountChangeDrainError(
          'account_change_page_invalid',
          'Account change page has an incompatible resource identity.',
          result
        );
      }
    }
    if (page.has_more && 'cursor' in position && position.cursor === page.cursor) {
      throw new AccountChangeDrainError(
        'account_change_page_invalid',
        'Account change continuation made no progress.',
        result
      );
    }
    return page;
  };

  const rebuild = async (error?: AccountChangeCursorExpiredError) => {
    const latest = await read({ starting_position: 'latest' });
    if (latest.has_more) {
      throw new AccountChangeDrainError(
        'account_change_page_invalid',
        'Latest must return the ingestion-tail checkpoint.'
      );
    }
    await bootstrap!({
      reason: error ? 'cursor_expired' : 'initial',
      account: structuredClone(account),
      ...(resourceTypes && { resourceTypes: [...resourceTypes] }),
      ...(error && { error }),
    });
    return latest.cursor;
  };

  if (cursor === undefined && bootstrap) cursor = await rebuild();
  while (true) {
    let page: AccountChangePage;
    try {
      page = await read(cursor === undefined ? { starting_position: 'earliest' } : { cursor });
    } catch (error) {
      if (!(error instanceof AccountChangeCursorExpiredError) || !bootstrap || rebooted) throw error;
      rebooted = true;
      cursor = await rebuild(error);
      continue;
    }
    const { cursor: nextCursor, ...metadata } = page;
    let acknowledged = false;
    let committing = false;
    let closed = false;
    try {
      yield {
        ...metadata,
        async acknowledge(commit) {
          if (closed || acknowledged) {
            throw new AccountChangeDrainError('account_change_checkpoint_closed', 'This page is no longer pending.');
          }
          if (committing) {
            throw new AccountChangeDrainError(
              'account_change_checkpoint_commit_in_progress',
              'This page is already committing.'
            );
          }
          committing = true;
          try {
            await commit(restoreAccountChangeCursor(nextCursor));
            acknowledged = true;
          } finally {
            committing = false;
          }
        },
      };
      if (!acknowledged) {
        throw new AccountChangeDrainError(
          'account_change_checkpoint_unacknowledged',
          'Acknowledge this page before requesting another.'
        );
      }
    } finally {
      closed = true;
    }
    cursor = nextCursor;
    if (!page.has_more) return;
  }
}
