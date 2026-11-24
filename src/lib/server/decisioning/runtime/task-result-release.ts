/**
 * Convert a task's terminal result from the server's release down to the
 * release its request was served at (DR-0024). The in-process task webhook and
 * the bound push settlement a worker runs both use this, so a buyer's terminal
 * webhook has the same shape whichever path settles the task.
 */
import { downgradeResponse, type VersionDrift } from '../../../adapters/version';
import { translationSteps } from '../../../adapters/version/translate';
import { projectErrorsForRelease } from '../../error-release-projection';
import { hasSchemaBundle } from '../../../validation/schema-loader';
import { projectPlatformIdsForRelease, toolHasPlatformIdRows } from '../../../utils/platform-id';

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
  return { data: platformIdsFor(tool, errors.data, range.toVersion), drifts: [...converted.drifts, ...errors.drifts] };
}

/**
 * Convert a bound task's result for its webhook, from the server's release
 * recorded at handoff to the served release. The settling worker may run a
 * later SDK than the one that bound the task. Previews are not additive over
 * each other and the SDK packages one per minor line, so a result shaped by a
 * preview this SDK no longer packages has no faithful conversion: another
 * release's schemas would keep a field the preview later withdrew. Throws
 * when any release the conversion needs is not packaged, rather than return a
 * result the served release cannot express. A stable release resolves to its
 * minor line's packaged bundle.
 */
export function projectBoundTaskResultForRelease(
  tool: string,
  result: unknown,
  recordedServerVersion: string,
  servedVersion: string
): unknown {
  const steps = translationSteps(recordedServerVersion, servedVersion);
  if (steps.length === 0) return platformIdsFor(tool, result, servedVersion);
  for (const step of steps) {
    for (const version of [step.upper, step.lower]) {
      if (!hasSchemaBundle(version)) throw new Error(`AdCP ${version} schemas are not packaged in this SDK`);
    }
  }
  return projectTaskResultForRelease(tool, result, {
    fromVersion: recordedServerVersion,
    toVersion: servedVersion,
  }).data;
}

/**
 * AdCP 3.3 renamed the platform identifier on sync_event_sources and
 * sync_audiences rows to platform_id and kept seller_id as an alias. A result
 * is stored as the seller wrote it; each reader gets both names at 3.3 and
 * later and seller_id alone below 3.3.
 */
function platformIdsFor(tool: string, result: unknown, servedVersion: string): unknown {
  return toolHasPlatformIdRows(tool) ? projectPlatformIdsForRelease(result, servedVersion) : result;
}
