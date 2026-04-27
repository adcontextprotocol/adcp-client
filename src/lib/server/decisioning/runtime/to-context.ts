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
import type { RequestContext } from '../context';

export function buildRequestContext<TMeta = Record<string, unknown>>(
  handlerCtx: HandlerContext<Account<TMeta>>
): RequestContext<Account<TMeta>> {
  const account = handlerCtx.account;
  if (!account) {
    // The framework calls `resolveAccount` before dispatch and aborts with
    // ACCOUNT_NOT_FOUND when it returns null. Reaching this branch means
    // either (a) a handler dispatched without a resolved account (framework
    // bug) or (b) a test harness invoked `buildRequestContext` directly
    // with an unresolved context. Surface a precise diagnostic.
    throw new Error(
      'buildRequestContext: handler context missing resolved account. ' +
        'This is a framework invariant violation — every dispatch path runs ' +
        '`resolveAccount` before reaching the platform layer. If you see this ' +
        'in a test, the test fixture is constructing HandlerContext without ' +
        'an `account` field; pass one explicitly.'
    );
  }

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
  };
}
