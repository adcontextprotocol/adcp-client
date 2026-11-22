/**
 * Convert a task's terminal result from the server's release down to the
 * release its request was served at (DR-0024). The in-process task webhook and
 * the bound push settlement a worker runs both use this, so a buyer's terminal
 * webhook has the same shape whichever path settles the task.
 */
import { downgradeResponse, type VersionDrift } from '../../../adapters/version';
import { projectErrorsForRelease } from '../../error-release-projection';

/**
 * Convert `result` for task type `tool` from `fromVersion` (the server's
 * release) to `toVersion` (the served release). The errors of a failed or
 * rejected result also go through `core/error.json`, which covers a task type
 * whose schema has no Error arm. The input is never mutated.
 */
export function projectTaskResultForRelease(
  tool: string,
  result: unknown,
  range: { fromVersion: string; toVersion: string }
): { data: unknown; drifts: VersionDrift[] } {
  const converted = downgradeResponse(tool, result, range);
  const errors = projectErrorsForRelease(converted.data, { toolName: tool, ...range });
  return { data: errors.data, drifts: [...converted.drifts, ...errors.drifts] };
}
