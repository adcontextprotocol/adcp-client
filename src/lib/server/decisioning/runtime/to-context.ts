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
import type { TaskRegistry } from './task-registry';
import { AdcpError, TaskDeferredError } from '../async-outcome';

export interface BuildRequestContextOpts {
  tool: string;
  taskRegistry: TaskRegistry;
  /**
   * Default `submittedAfterMs` for `ctx.runAsync` if the adopter doesn't
   * pass one inline. Defaults to 30 seconds — long enough that most sync
   * paths complete inside it, short enough that buyer doesn't time out
   * waiting on the HTTP roundtrip.
   */
  defaultSubmittedAfterMs?: number;
  /**
   * Hard cap on in-process await for `ctx.runAsync`. After this elapses,
   * the framework stops waiting on the in-flight promise and the task
   * record stays `submitted` — adopter must push completion from
   * out-of-process via webhook + `notify`. Defaults to 10 minutes.
   */
  defaultMaxAutoAwaitMs?: number;
}

const DEFAULT_SUBMITTED_AFTER_MS = 30_000;
const DEFAULT_MAX_AUTO_AWAIT_MS = 10 * 60_000;

export function buildRequestContext<TAccount = unknown>(
  handlerCtx: HandlerContext<TAccount>,
  opts: BuildRequestContextOpts
): RequestContext<Account> {
  const account = handlerCtx.account as Account | undefined;
  if (!account) {
    throw new Error('buildRequestContext: handler context missing resolved account');
  }
  const defaultSubmittedAfterMs = opts.defaultSubmittedAfterMs ?? DEFAULT_SUBMITTED_AFTER_MS;
  const defaultMaxAutoAwaitMs = opts.defaultMaxAutoAwaitMs ?? DEFAULT_MAX_AUTO_AWAIT_MS;

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
    startTask: <TResult>(taskOpts?: { partialResult?: TResult }) =>
      opts.taskRegistry.startTask<TResult>({
        tool: opts.tool,
        accountId: account.id,
        ...(taskOpts?.partialResult !== undefined && { partialResult: taskOpts.partialResult }),
      }),

    runAsync: async <TResult>(
      runOpts: { message?: string; partialResult?: TResult; submittedAfterMs?: number; maxAutoAwaitMs?: number },
      fn: () => Promise<TResult>
    ): Promise<TResult> => {
      const submittedAfterMs = runOpts.submittedAfterMs ?? defaultSubmittedAfterMs;
      // maxAutoAwaitMs is reserved for the production-hardening commit
      // (AbortSignal-cancellable cap). The alpha runtime awaits indefinitely.
      void runOpts.maxAutoAwaitMs;

      const work = fn();
      // Settle into a value so the loser of Promise.race doesn't leak
      // unhandled rejections.
      const settled: Promise<{ kind: 'ok'; value: TResult } | { kind: 'err'; error: unknown }> = work.then(
        value => ({ kind: 'ok' as const, value }),
        error => ({ kind: 'err' as const, error })
      );

      // Pre-flight timeout race: if `fn()` resolves within submittedAfterMs,
      // return its value (sync arm). Otherwise throw TaskDeferredError so
      // the runtime can project to the submitted wire envelope; meanwhile
      // attach the still-running settled promise to the registry.
      const TIMEOUT = Symbol('runAsync.timeout');
      let timer: NodeJS.Timeout | undefined;
      let resolveTimeout!: (v: typeof TIMEOUT) => void;
      const timeoutPromise = new Promise<typeof TIMEOUT>(resolve => {
        resolveTimeout = resolve;
        timer = setTimeout(() => resolve(TIMEOUT), submittedAfterMs);
        timer.unref?.();
      });

      // When settled lands first, drain the timeout promise so it doesn't
      // leak as a pending Promise (Node test runner detects pending
      // promises after `it()` returns).
      void settled.then(() => {
        if (timer) clearTimeout(timer);
        resolveTimeout(TIMEOUT);
      });

      const winner = await Promise.race([settled, timeoutPromise]);

      if (winner !== TIMEOUT) {
        if (winner.kind === 'err') throw winner.error;
        return winner.value;
      }

      // Timeout won. Issue a framework task handle and attach the still-pending
      // settled promise as the completion. Runtime catches TaskDeferredError
      // and projects to submitted envelope.
      const taskHandle = opts.taskRegistry.startTask<TResult>({
        tool: opts.tool,
        accountId: account.id,
        ...(runOpts.partialResult !== undefined && { partialResult: runOpts.partialResult }),
      });

      const completion = settled.then(outcome => {
        if (outcome.kind === 'ok') {
          taskHandle.notify({ kind: 'completed', result: outcome.value });
        } else {
          const error =
            outcome.error instanceof AdcpError
              ? outcome.error.toStructuredError()
              : {
                  code: 'SERVICE_UNAVAILABLE' as const,
                  recovery: 'transient' as const,
                  message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
                };
          taskHandle.notify({ kind: 'failed', error });
        }
      });
      opts.taskRegistry._registerBackground(taskHandle.taskId, completion);

      throw new TaskDeferredError({
        taskHandle,
        ...(runOpts.partialResult !== undefined && { partialResult: runOpts.partialResult }),
        ...(runOpts.message !== undefined && { statusMessage: runOpts.message }),
      });
    },
  };
}
