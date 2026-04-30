/**
 * Translate the existing `HandlerContext` into the v6 `RequestContext` shape
 * that platform methods receive.
 *
 * The handler-style framework already resolves the account, sets sessionKey,
 * and exposes `store` + `authInfo` + `emitWebhook`. The new context layers
 * `state.*` (sync state reads), `resolve.*` (async framework-mediated
 * resolvers), and `handoffToTask(...)` (the unified hybrid-seller handoff
 * primitive) on top.
 *
 * **Stub status — v6.0 alpha.** `state.*` (workflow-step reads, proposal
 * lookups, governance JWS) and `resolve.*` (property/collection-list +
 * format fetchers) are NOT yet wired. The state readers return empty
 * results; the resolvers throw. Touching them in a platform method will
 * crash the request — the framework hasn't connected them to an underlying
 * store / fetch layer yet.
 *
 * Adopters spiking against the preview surface MUST avoid `ctx.state.*`
 * and `ctx.resolve.*` until the wire-up commits land in rc.1. Use
 * `ctx.account`, `ctx.handoffToTask(...)`, and the structured-error /
 * status-change primitives only.
 *
 * @internal — framework-internal wiring; not adopter surface. The
 * exported helpers (`buildRequestContext`, `buildHandoffContext`) are
 * called from the dispatch seam in `from-platform.ts`. Adopters should
 * never construct a `RequestContext` themselves; the framework supplies
 * one to every specialism method call.
 */

import type { HandlerContext } from '../../create-adcp-server';
import type { Account } from '../account';
import type { RequestContext, CtxMetadataAccessor } from '../context';
import type { TaskRegistry } from './task-registry';
import { _createTaskHandoff, type TaskHandoffContext, type TaskHandoff } from '../async-outcome';
import type { CtxMetadataStore, ResourceKind, CtxMetadataRef } from '../../ctx-metadata';

/**
 * Build an account-scoped CtxMetadataAccessor for a single request.
 *
 * Account scope comes from `ctx.account.id` — accessor methods don't take
 * an account param. When `account.id` is null/undefined (no-account tools),
 * the accessor methods reject — no-account tools cannot use ctx_metadata
 * (cross-tenant collision risk via missing scope).
 */
function buildCtxMetadataAccessor(
  store: CtxMetadataStore,
  accountId: string
): CtxMetadataAccessor {
  return {
    get(kind: ResourceKind, id: string) {
      return store.get(accountId, kind, id);
    },
    bulkGet(refs: readonly CtxMetadataRef[]) {
      return store.bulkGet(accountId, refs);
    },
    set(kind: ResourceKind, id: string, value: unknown, ttlSeconds?: number) {
      return store.set(accountId, kind, id, value, ttlSeconds);
    },
    delete(kind: ResourceKind, id: string) {
      return store.delete(accountId, kind, id);
    },
    account(id: string) {
      return store.get(accountId, 'account', id);
    },
    product(id: string) {
      return store.get(accountId, 'product', id);
    },
    mediaBuy(id: string) {
      return store.get(accountId, 'media_buy', id);
    },
    package(id: string) {
      return store.get(accountId, 'package', id);
    },
    creative(id: string) {
      return store.get(accountId, 'creative', id);
    },
    audience(id: string) {
      return store.get(accountId, 'audience', id);
    },
    signal(id: string) {
      return store.get(accountId, 'signal', id);
    },
  };
}

export function buildRequestContext<TMeta = Record<string, unknown>>(
  handlerCtx: HandlerContext<Account<TMeta>>,
  ctxMetadataStore?: CtxMetadataStore
): RequestContext<Account<TMeta>> {
  // `account` may legitimately be undefined for tools whose wire request
  // doesn't carry an `account` field AND whose `resolveAccountFromAuth`
  // returned null (`'explicit'`-mode adopters who don't model the
  // no-account tools, or buyers calling without auth). Adopter handlers
  // for those tools are responsible for either deriving the account
  // themselves (e.g., via `media_buy_id` ownership) or throwing
  // `AdcpError('ACCOUNT_NOT_FOUND')` if account is required.
  //
  // The `RequestContext.account` type is non-optional for ergonomic typing
  // — adopters writing handlers for the 90% case (tools with `account` on
  // the wire) shouldn't have to optional-chain everywhere. Adopters of
  // no-account tools either:
  //   1. Declare `resolution: 'derived'` and return a singleton from
  //      `accounts.resolve(undefined)` — `ctx.account` is always set
  //   2. Implement only `'explicit'` and never claim no-account
  //      specialisms — the tool is unreachable
  //   3. Read `ctx.account` defensively (`as Account | undefined` cast)
  //      and look up by request body when missing
  const account = handlerCtx.account as Account<TMeta>;

  const stubResolver = (name: string) => async (): Promise<never> => {
    throw new Error(
      `ctx.resolve.${name}: not yet wired in v6.0 alpha — landing in rc.1. ` +
        `Avoid touching ctx.resolve.* in adopter code until the framework ` +
        `connects this resolver to an underlying fetcher.`
    );
  };

  // Bind ctx-metadata accessor when store wired AND account scope present.
  // No-account tools (provide_performance_feedback, list_creative_formats)
  // get `ctx.ctxMetadata = undefined` even when the store is wired — cannot
  // use ctx_metadata without an account boundary (cross-tenant risk).
  const ctxMetadata =
    ctxMetadataStore != null && account != null && (account.id ?? '') !== ''
      ? buildCtxMetadataAccessor(ctxMetadataStore, account.id)
      : undefined;

  return {
    account,
    state: {
      findByObject: () => [],
      findProposalById: () => null,
      governanceContext: () => null,
      workflowSteps: () => [],
    },
    resolve: {
      propertyList: stubResolver('propertyList'),
      collectionList: stubResolver('collectionList'),
      creativeFormat: stubResolver('creativeFormat'),
    },
    ctxMetadata,
    handoffToTask<TResult>(fn: (taskCtx: TaskHandoffContext) => Promise<TResult>): TaskHandoff<TResult> {
      return _createTaskHandoff(fn);
    },
  };
}

/**
 * Construct a `TaskHandoffContext` from a registry + framework-issued
 * task id. The framework calls this AFTER detecting a `TaskHandoff`
 * marker on a method's return — the handoff function gets a context
 * carrying the framework-allocated `taskId` plus `update`/`heartbeat`
 * affordances.
 *
 * `update(progress)` writes the progress payload to the task record and
 * transitions status `submitted` → `working`. Buyers polling `tasks_get`
 * see the `progress` object and the `'working'` status — this is the
 * buyer-facing UX signal that distinguishes "stuck/no news" from
 * "step 2/3, awaiting trafficker." Errors from the registry write are
 * swallowed so a transient DB hiccup doesn't abort the adopter's handoff
 * function.
 *
 * `heartbeat()` remains a no-op stub (v6.1); it is a liveness / TTL-reset
 * signal for operator infrastructure, not buyer-facing.
 */
export function buildHandoffContext(taskRegistry: TaskRegistry, taskId: string): TaskHandoffContext {
  return {
    id: taskId,
    update: async progress => {
      try {
        await taskRegistry.updateProgress(taskId, progress);
      } catch {
        // Swallow — a transient registry write failure must not abort the
        // adopter's background handoff function. The buyer-facing impact is
        // a missed progress event, not a failed task.
      }
    },
    heartbeat: async () => {
      await Promise.resolve();
    },
  };
}
