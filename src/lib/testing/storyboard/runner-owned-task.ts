import { VALIDATION_ONLY_TASK } from './loader';
import { PROBE_TASKS } from './probes';
import { TRUSTED_MATCH_PUBLISHER_AUTH_TASKS } from './trusted-match-publisher-auth';
import { MCP_SESSION_PROBE_TASK } from './types';
import { WEBHOOK_ASSERTION_TASKS } from './webhook-assertions';

export const REPLAY_WEBHOOK_VECTOR_TASK = 'replay_webhook_vector';

/** Runner operations are not seller request-schema names. */
export function isRunnerOwnedTask(task: string): boolean {
  return (
    task === VALIDATION_ONLY_TASK ||
    task === MCP_SESSION_PROBE_TASK ||
    task === 'assert_contribution' ||
    task === REPLAY_WEBHOOK_VECTOR_TASK ||
    TRUSTED_MATCH_PUBLISHER_AUTH_TASKS.has(task) ||
    PROBE_TASKS.has(task) ||
    WEBHOOK_ASSERTION_TASKS.has(task)
  );
}
