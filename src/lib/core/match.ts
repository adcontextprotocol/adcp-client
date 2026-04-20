import type { TaskResult } from './ConversationTypes';

/**
 * Status discriminant values actually used by `TaskResult` variants. Narrower
 * than `TaskStatus` (which includes pre-response states like `'pending'`).
 */
type StatusOf<T> = TaskResult<T>['status'];

/**
 * Narrow `TaskResult<T>` to the variant whose `status` includes `K`.
 *
 * Plain `Extract<TaskResult<T>, { status: K }>` returns `never` here because
 * `TaskResultFailure<T>` and `TaskResultIntermediate<T>` each cover multiple
 * status literals — neither is assignable to `{ status: K }` for a single
 * `K`. The distributive conditional below keeps a variant `U` when `K` is a
 * member of `U['status']`.
 */
type Narrow<T, K extends StatusOf<T>> = TaskResult<T> extends infer U
  ? U extends { status: infer S } ? (K extends S ? U : never) : never
  : never;

/**
 * Exhaustive handler map: one arm per possible `status`. Omitting any arm is
 * a compile error — use {@link PartialMatchHandlers} with a `_` catchall to
 * handle a subset.
 */
export type MatchHandlers<T, R> = {
  [K in StatusOf<T>]: (r: Narrow<T, K>) => R;
};

/**
 * Partial handler map with a required `_` catchall. Any omitted status arm
 * routes to `_`, which receives the full `TaskResult<T>` type.
 */
export type PartialMatchHandlers<T, R> = Partial<{
  [K in StatusOf<T>]: (r: Narrow<T, K>) => R;
}> & { _: (r: TaskResult<T>) => R };

/**
 * Exhaustive pattern match on a {@link TaskResult}'s `status` discriminant.
 *
 * Each handler receives the variant narrowed to its status, so `data`,
 * `error`, `adcpError`, `deferred`, and `submitted` are correctly typed
 * without manual `if (result.status === ...)` guards.
 *
 * @example
 * ```ts
 * const rendered = match(result, {
 *   completed: (r) => `OK: ${r.data.media_buy_id}`,
 *   failed: (r) => `Error: ${r.adcpError?.code ?? r.error}`,
 *   'governance-denied': (r) => `Denied: ${r.error}`,
 *   submitted: (r) => `Pending: ${r.metadata.taskId}`,
 *   'input-required': (r) => `Input: ${r.metadata.inputRequest?.question}`,
 *   working: (r) => `Working: ${r.metadata.taskId}`,
 *   deferred: (r) => `Deferred: ${r.deferred?.token}`,
 * });
 * ```
 *
 * @example With `_` catchall, other arms become optional:
 * ```ts
 * const label = match(result, {
 *   completed: (r) => `OK: ${r.data.media_buy_id}`,
 *   _: (r) => `${r.status}: ${r.metadata.taskId}`,
 * });
 * ```
 */
export function match<T, R>(result: TaskResult<T>, handlers: MatchHandlers<T, R>): R;
export function match<T, R>(result: TaskResult<T>, handlers: PartialMatchHandlers<T, R>): R;
export function match<T, R>(result: TaskResult<T>, handlers: Record<string, unknown>): R {
  const handler = (handlers[result.status] ?? handlers._) as
    | ((r: TaskResult<T>) => R)
    | undefined;
  if (!handler) {
    throw new Error(`match: no handler for status "${result.status}" and no "_" catchall provided`);
  }
  return handler(result);
}
