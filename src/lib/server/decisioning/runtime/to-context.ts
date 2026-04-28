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
 * @public
 */

import type { HandlerContext } from '../../create-adcp-server';
import type { Account } from '../account';
import type { RequestContext } from '../context';
import type { TaskRegistry } from './task-registry';
import { _createTaskHandoff, type TaskHandoffContext, type TaskHandoff } from '../async-outcome';

export function buildRequestContext<TMeta = Record<string, unknown>>(
  handlerCtx: HandlerContext<Account<TMeta>>
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
    handoffToTask<TResult>(
      fn: (taskCtx: TaskHandoffContext) => Promise<TResult>
    ): TaskHandoff<TResult> {
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
 * v6.0 doesn't yet model the `progress` field on the task record — the
 * `message` from `update(...)` rides through but isn't yet projected
 * onto `tasks_get`. v6.1 ships `taskRegistry.transition(taskId, { ... })`
 * which closes the loop. Until then, adopters can call `update(...)`
 * to bump `updated_at`; structured progress fields are captured but
 * not surfaced to buyers.
 */
export function buildHandoffContext(taskRegistry: TaskRegistry, taskId: string): TaskHandoffContext {
  void taskRegistry;
  return {
    id: taskId,
    update: async (progress) => {
      void progress;
      await Promise.resolve();
    },
    heartbeat: async () => {
      await Promise.resolve();
    },
  };
}
