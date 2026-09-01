/**
 * Apply a durable task-settlement intent and prove the exact terminal artifact.
 *
 * This is deliberately the single supported bridge between the durable intent
 * queue and polling/push task registries. Callers may acknowledge an intent
 * checkpoint only after this function returns `settled`.
 */

import { isDeepStrictEqual } from 'node:util';
import { completeScopedTask, failScopedTask, type TaskRegistry } from './task-registry';
import {
  completeScopedPushTask,
  failScopedPushTask,
  type PostgresTaskSettlementCoordinator,
  type TaskPushSettlementConfig,
} from './postgres-task-settlement';
import {
  canonicalizeTaskSettlementIntent,
  type TaskSettlementIntent,
} from './postgres-task-settlement-intents';

export type ApplyTaskSettlementIntentOptions =
  | {
      /** Polling-only task registry. Push-enabled tasks are rejected. */
      registry: TaskRegistry;
      coordinator?: never;
      push?: never;
    }
  | {
      /** Crash-safe PostgreSQL task/outbox coordinator for push-enabled tasks. */
      coordinator: PostgresTaskSettlementCoordinator;
      /** The original, durably protected push route for this task. */
      push: TaskPushSettlementConfig;
      registry?: never;
    };

/**
 * Apply one intent idempotently and verify an existing terminal state exactly.
 *
 * Throws on scope misses, conflicting artifacts, missing durable push
 * checkpoints, or invalid input. Those failures intentionally keep a queued
 * intent recoverable; never acknowledge its checkpoint after a throw.
 */
export async function applyTaskSettlementIntent(
  intent: TaskSettlementIntent,
  options: ApplyTaskSettlementIntentOptions
): Promise<'settled'> {
  const canonicalIntent = canonicalizeTaskSettlementIntent(intent);

  if (options.coordinator !== undefined) {
    const outcome =
      canonicalIntent.action === 'complete'
        ? await completeScopedPushTask(
            options.coordinator,
            canonicalIntent.taskRef,
            options.push,
            canonicalIntent.result
          )
        : await failScopedPushTask(
            options.coordinator,
            canonicalIntent.taskRef,
            options.push,
            canonicalIntent.error,
            canonicalIntent.result
          );

    if (outcome.outcome === 'applied') return 'settled';
    if (outcome.outcome === 'already_terminal' && outcome.compatibility === 'compatible') return 'settled';
    throw new Error('Push task has a scope or settlement compatibility conflict');
  }

  const outcome =
    canonicalIntent.action === 'complete'
      ? await completeScopedTask(options.registry, canonicalIntent.taskRef, canonicalIntent.result)
      : await failScopedTask(
          options.registry,
          canonicalIntent.taskRef,
          canonicalIntent.error,
          canonicalIntent.result
        );

  if (outcome.outcome === 'applied') return 'settled';
  if (outcome.outcome === 'not_found_in_scope') {
    throw new Error('Settlement task was not found in its trusted scope');
  }

  const stored = await options.registry.getTask(canonicalIntent.taskRef.taskId, canonicalIntent.taskRef);
  if (!stored) throw new Error('Terminal task disappeared from its trusted scope');

  let storedIntent: TaskSettlementIntent | undefined;
  if (stored.status === 'completed' && Object.hasOwn(stored, 'result')) {
    storedIntent = canonicalizeTaskSettlementIntent({
      taskRef: canonicalIntent.taskRef,
      action: 'complete',
      result: stored.result,
    });
  } else if (stored.status === 'failed' && stored.error) {
    storedIntent = canonicalizeTaskSettlementIntent({
      taskRef: canonicalIntent.taskRef,
      action: 'fail',
      error: stored.error,
      ...(Object.hasOwn(stored, 'result') && { result: stored.result }),
    });
  }

  if (storedIntent === undefined || !isDeepStrictEqual(storedIntent, canonicalIntent)) {
    throw new Error('Task is terminal with a conflicting settlement artifact');
  }
  return 'settled';
}
