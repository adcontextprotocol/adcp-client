/**
 * Convert a task's terminal result from the server's release down to the
 * release its request was served at (DR-0024). The in-process task webhook and
 * the bound push settlement a worker runs both use this, so a buyer's terminal
 * webhook has the same shape whichever path settles the task.
 */
import { downgradeResponse, type VersionDrift } from '../../../adapters/version';
import { parseAdcpRelease } from '../../../adapters/version/negotiate';
import { translationSteps } from '../../../adapters/version/translate';
import { projectErrorsForRelease } from '../../error-release-projection';
import { hasSchemaBundle } from '../../../validation/schema-loader';
import { ADCP_VERSION } from '../../../version';

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

/**
 * Convert a bound task's result for its webhook, from the server's release
 * recorded at handoff to the served release. The settling worker may run a
 * later SDK than the one that bound the task, and the SDK packages one
 * preview per minor line, so a recorded preview may have no schemas here. The
 * result is then converted from the release this SDK ships on the same minor
 * line, as a `get_task_status` poll converts a stored result from the
 * server's current release. Throws when a release the conversion needs has no
 * schemas, rather than return a result the served release cannot express.
 */
export function projectBoundTaskResultForRelease(
  tool: string,
  result: unknown,
  recordedServerVersion: string,
  servedVersion: string
): unknown {
  if (translationSteps(recordedServerVersion, servedVersion).length === 0) return result;
  const fromVersion = shippedSourceRelease(recordedServerVersion);
  if (fromVersion === undefined) {
    throw new Error(`No AdCP ${recordedServerVersion} schemas (or another release on its minor line) are available`);
  }
  for (const step of translationSteps(fromVersion, servedVersion)) {
    for (const version of [step.upper, step.lower]) {
      if (!hasSchemaBundle(version)) throw new Error(`No AdCP ${version} schemas are available`);
    }
  }
  return projectTaskResultForRelease(tool, result, { fromVersion, toVersion: servedVersion }).data;
}

function shippedSourceRelease(recorded: string): string | undefined {
  if (hasSchemaBundle(recorded)) return recorded;
  const release = parseAdcpRelease(recorded);
  const current = parseAdcpRelease(ADCP_VERSION);
  if (!release) return undefined;
  if (current && current.major === release.major && current.minor === release.minor && hasSchemaBundle(ADCP_VERSION)) {
    return ADCP_VERSION;
  }
  const line = `${release.major}.${release.minor}`;
  return hasSchemaBundle(line) ? line : undefined;
}
