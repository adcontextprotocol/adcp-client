/**
 * Translate the existing `HandlerContext` into the v6 `RequestContext` shape
 * that platform methods receive.
 *
 * The handler-style framework already resolves the account, sets sessionKey,
 * and exposes `store` + `authInfo` + `emitWebhook`. The new context layers
 * `state.*` (sync state reads) and `resolve.*` (async framework-mediated
 * resolvers) on top.
 *
 * Status: Preview / 6.0. v1.0 wires `account` and stub-shape `state` /
 * `resolve` — full state/resolve plumbing arrives with the runtime refactor
 * over subsequent commits.
 *
 * @public
 */

import type { HandlerContext } from '../../create-adcp-server';
import type { Account } from '../account';
import type { RequestContext } from '../context';

export function buildRequestContext<TAccount = unknown>(
  handlerCtx: HandlerContext<TAccount>
): RequestContext<Account> {
  const account = handlerCtx.account as Account | undefined;
  if (!account) {
    throw new Error('buildRequestContext: handler context missing resolved account');
  }

  return {
    account,
    state: {
      findByObject: () => [],
      findProposalById: () => null,
      governanceContext: () => null,
      workflowSteps: () => [],
    },
    resolve: {
      propertyList: async () => {
        throw new Error('ctx.resolve.propertyList: not yet wired in v6.0 alpha');
      },
      collectionList: async () => {
        throw new Error('ctx.resolve.collectionList: not yet wired in v6.0 alpha');
      },
      creativeFormat: async () => {
        throw new Error('ctx.resolve.creativeFormat: not yet wired in v6.0 alpha');
      },
    },
  };
}
