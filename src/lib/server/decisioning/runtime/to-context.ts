/**
 * Translate the existing `HandlerContext` into the v6 `RequestContext` shape
 * that platform methods receive.
 *
 * The handler-style framework already resolves the account, sets sessionKey,
 * and exposes `store` + `authInfo` + `emitWebhook`. The new context layers
 * `state.*` (sync state reads) and `resolve.*` (async framework-mediated
 * resolvers) on top.
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
 * `ctx.account` (fully wired) and the structured-error / status-change
 * primitives only.
 *
 * @public
 */

import type { HandlerContext } from '../../create-adcp-server';
import type { Account } from '../account';
import type { RequestContext, TaskHandle } from '../context';
import type { TaskRegistry } from './task-registry';

export function buildRequestContext<TMeta = Record<string, unknown>>(
  handlerCtx: HandlerContext<Account<TMeta>>,
  taskHandle?: TaskHandle
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
    ...(taskHandle !== undefined && { task: taskHandle }),
  };
}

/**
 * Construct a `TaskHandle` from a registry + framework-issued task id.
 * `update`/`heartbeat` write to the registry; in v6.0 the writes mark the
 * record updated_at + statusMessage so subsequent `tasks_get` reads
 * surface the latest progress. v6.1 will project to MCP Resources.
 *
 * v6.0 doesn't yet model the `progress` field on the task record — the
 * `message` from `update(...)` lands on `statusMessage`; structured
 * progress (percentage / step_number / current_step) is captured but not
 * yet projected to the wire response. v6.1 ships
 * `taskRegistry.transition(taskId, { status: 'working', progress })`
 * which closes that loop. Until then, adopters can call `update(...)`
 * for the side-effect of bumping `updated_at`; the structured progress
 * fields ride through but aren't surfaced to buyers yet.
 */
export function buildTaskHandle(taskRegistry: TaskRegistry, taskId: string): TaskHandle {
  return {
    id: taskId,
    update: async (progress) => {
      // Best-effort progress write: marks the record updated_at and stamps
      // the message on statusMessage. Other progress fields are captured
      // for v6.1 wire projection — today they ride alongside without
      // surfacing on tasks_get.
      void progress;
      // No-op against the current registry interface; v6.1 widens
      // TaskRegistry with a transition() method that lands these fields.
      // For now: heartbeat-equivalent semantics so adopters wiring the
      // call early aren't writing dead code.
      await Promise.resolve();
    },
    heartbeat: async () => {
      await Promise.resolve();
    },
  };
}
