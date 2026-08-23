/**
 * Test-kit schema validation.
 *
 * The test-kit YAML format has no formal schema today — the runner accepts
 * `options.test_kit` as a loose bag the security_baseline storyboard reads
 * via `$test_kit.<path>` references. This module enforces two invariants:
 *
 *   1. If a kit declares an `auth` block, `auth.probe_task` is required
 *      (no default). A missing probe_task fails kit-load rather than
 *      silently defaulting, so a kit that hasn't been explicitly migrated
 *      to declare the field can't green-light storyboards by accident.
 *
 *   2. `probe_task` must be one of an allowlist of auth-required, read-only
 *      AdCP tasks that accept an empty request body. Pointing probe_task at
 *      a task with required parameters would make the security_baseline
 *      runner misreport "agent failed auth" when the root cause is that
 *      schema validation rejected the probe before the auth layer ran.
 */

import type { TestOptions } from '../types';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse } from 'yaml';

/**
 * AdCP tasks safe to call with unauth / invalid-key credentials during the
 * security_baseline probes:
 *
 *   - authenticated (so unauth yields 401/403, not 200)
 *   - read-only (no side effects across retries)
 *   - accept an empty request body (so auth failures fire before schema
 *     validation — otherwise a 400 would mask a 401)
 *
 * If a future task qualifies, add it here AND update the allowlist in the
 * upstream adcp storyboard narrative so this repo stays the single source
 * of runner truth.
 */
export const PROBE_TASK_ALLOWLIST: readonly string[] = Object.freeze([
  'list_creatives',
  'get_media_buy_delivery',
  'list_authorized_properties',
  'get_signals',
  // governance specialism tools — all fields optional, auth-required, read-only
  'list_property_lists',
  'list_collection_lists',
  'list_content_standards',
]);

/**
 * Select an advertised auth probe without dispatching an inapplicable tool.
 * The configured task is a preference, not permission to call a tool the
 * agent did not advertise. Returns undefined when the agent has no safe,
 * empty-body read probe (currently true for SI-only agents).
 */
export function selectProbeTask(
  preferred: string | undefined,
  advertisedTools: readonly string[] | undefined
): string | undefined {
  if (!advertisedTools) return preferred;
  const advertised = new Set(advertisedTools);
  if (preferred && PROBE_TASK_ALLOWLIST.includes(preferred) && advertised.has(preferred)) return preferred;
  return PROBE_TASK_ALLOWLIST.find(task => advertised.has(task));
}

/**
 * Raised when a test kit violates the schema invariants above. Carries the
 * field name so upstream loaders can render a YAML-friendly error.
 */
export class TestKitValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'TestKitValidationError';
    this.field = field;
  }
}

/**
 * Validate `options.test_kit`. No-op when `test_kit` or `test_kit.auth` is
 * absent — kits without an auth block are valid and the storyboard will
 * skip auth probes via `skip_if: "!test_kit.auth.api_key"`.
 *
 * Throws {@link TestKitValidationError} on the first violation. Intended for
 * eager use at comply/runStoryboard entry; upstream YAML loaders can also
 * import this directly to reject malformed kits at file-load time.
 */
export function validateTestKit(testKit: TestOptions['test_kit']): void {
  const value: unknown = testKit;
  if (value === undefined) return;
  if (!isPlainMapping(value)) {
    throw new TestKitValidationError('test_kit', 'test_kit must be a YAML mapping.');
  }
  const auth = value.auth;
  if (auth === undefined) return;
  if (!isPlainMapping(auth)) {
    throw new TestKitValidationError('test_kit.auth', 'test_kit.auth must be a YAML mapping.');
  }

  const apiKey = auth.api_key;
  if (
    apiKey !== undefined &&
    (typeof apiKey !== 'string' || apiKey.trim().length === 0 || /[^\x20-\x7E]/u.test(apiKey))
  ) {
    throw new TestKitValidationError(
      'test_kit.auth.api_key',
      'test_kit.auth.api_key must be a non-empty string containing only printable ASCII characters.'
    );
  }

  const probeTask = auth.probe_task;
  if (probeTask === undefined) {
    throw new TestKitValidationError(
      'test_kit.auth.probe_task',
      `test_kit.auth.probe_task is required when test_kit.auth is declared. ` +
        `Set it to one of: ${PROBE_TASK_ALLOWLIST.join(', ')}. ` +
        `The runner uses this task for the security_baseline unauth + invalid-key probes.`
    );
  }
  if (typeof probeTask !== 'string' || probeTask.length === 0) {
    throw new TestKitValidationError(
      'test_kit.auth.probe_task',
      'test_kit.auth.probe_task must be a non-empty string selected from the allowlist.'
    );
  }
  if (!PROBE_TASK_ALLOWLIST.includes(probeTask)) {
    throw new TestKitValidationError(
      'test_kit.auth.probe_task',
      `test_kit.auth.probe_task is not in the allowlist. ` +
        `Allowed tasks (auth-required, read-only, accept empty body): ` +
        `${PROBE_TASK_ALLOWLIST.join(', ')}. ` +
        `Tasks outside this list can 400 on schema validation before auth is evaluated, ` +
        `which would misreport as an agent auth failure.`
    );
  }
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function filesystemErrorCode(err: unknown): string | undefined {
  return isPlainMapping(err) && typeof err.code === 'string' ? err.code : undefined;
}

function safeLabel(value: unknown): string {
  return JSON.stringify(String(value ?? '<unknown>').slice(0, 120));
}

/**
 * Resolve a storyboard's declared `prerequisites.test_kit` into
 * `options.test_kit` (adcontextprotocol/adcp#6735).
 *
 * Historically the declaration was decorative: `from_test_kit` / `$test_kit.*`
 * references read only the caller-supplied `options.test_kit`, so a run
 * without an explicit kit silently degraded credentialed steps to
 * unauthenticated probes — grading conformant sellers FAIL on
 * credential-keyed storyboards (`comply_controller_mode_gate`). This loader
 * makes the declaration real:
 *
 *   - No-op when the storyboard declares no kit, or when the caller already
 *     supplied `options.test_kit` (caller/hosted-engine configuration wins;
 *     the hosted engine pre-populates the declared kit itself — see the
 *     server-side half of adcp#6735).
 *   - Otherwise loads `<compliance cache>/<declared path>`, validates it
 *     with the same invariants as a caller-supplied kit, and returns amended
 *     options. Loading requires an explicit caller-selected complianceDir or
 *     loader-attached trusted provenance (which the runner promotes to that
 *     option); a storyboard-authored version alone grants no filesystem
 *     authority.
 *   - A genuinely absent kit is tolerated because external bundles may omit
 *     kits that none of their steps use. Other filesystem faults, invalid
 *     YAML, and invalid kit shapes throw instead of degrading silently.
 */
export function resolveDeclaredTestKit<
  O extends { test_kit?: TestOptions['test_kit']; adcpVersion?: string; complianceDir?: string },
>(storyboard: { id?: string; prerequisites?: { test_kit?: string } }, options: O): O {
  const declared = storyboard.prerequisites?.test_kit;
  if (declared === undefined || options.test_kit !== undefined) return options;
  if (typeof declared !== 'string' || declared.trim().length === 0) {
    throw new Error(
      `storyboard ${safeLabel(storyboard.id)} declares an invalid prerequisites.test_kit path; expected a non-empty string.`
    );
  }
  // Storyboard YAML is data, not authority to read credentials from the SDK's
  // packaged cache (or ADCP_COMPLIANCE_DIR). Only the caller or the trusted
  // compliance loader may select a filesystem root.
  if (options.complianceDir === undefined) return options;
  if (typeof options.complianceDir !== 'string' || options.complianceDir.trim().length === 0) {
    throw new Error(
      `storyboard ${safeLabel(storyboard.id)} received an invalid complianceDir for its declared test kit; expected a non-empty string.`
    );
  }

  const sbId = safeLabel(storyboard.id);
  const declaredLabel = safeLabel(declared);
  const cacheDir = resolve(options.complianceDir);
  const kitPath = resolve(join(cacheDir, declared));
  // Containment: the declared path comes from cache-shipped YAML; never let
  // it escape the cache root.
  if (kitPath !== cacheDir && !kitPath.startsWith(cacheDir + sep)) {
    throw new Error(
      `storyboard ${sbId} declares prerequisites.test_kit ${declaredLabel} ` +
        `which resolves outside the compliance cache root — refusing to load it.`
    );
  }

  let physicalCacheDir: string;
  try {
    physicalCacheDir = realpathSync(cacheDir);
  } catch (err) {
    if (filesystemErrorCode(err) === 'ENOENT') return options;
    throw new Error(
      `storyboard ${sbId} could not resolve the compliance cache for declared test kit ${declaredLabel} ` +
        `(${filesystemErrorCode(err) ?? 'filesystem error'}).`
    );
  }

  let physicalKitPath: string;
  try {
    physicalKitPath = realpathSync(kitPath);
  } catch (err) {
    // A declared kit that genuinely isn't present is tolerated at load time:
    // storyboards may declare a kit whose auth no step uses. Steps that do
    // require it hard-fail individually before any request reaches the agent.
    if (filesystemErrorCode(err) === 'ENOENT') return options;
    throw new Error(
      `storyboard ${sbId} could not resolve declared test kit ${declaredLabel} ` +
        `(${filesystemErrorCode(err) ?? 'filesystem error'}).`
    );
  }
  if (physicalKitPath !== physicalCacheDir && !physicalKitPath.startsWith(physicalCacheDir + sep)) {
    throw new Error(
      `storyboard ${sbId} declares prerequisites.test_kit ${declaredLabel} ` +
        `which resolves outside the physical compliance cache root — refusing to load it.`
    );
  }

  let raw: string;
  try {
    if (!statSync(physicalKitPath).isFile()) {
      throw new Error('not a regular file');
    }
    raw = readFileSync(physicalKitPath, 'utf8');
  } catch (err) {
    throw new Error(
      `storyboard ${sbId} could not read declared test kit ${declaredLabel} ` +
        `(${filesystemErrorCode(err) ?? 'not a regular file'}).`
    );
  }
  let kit: TestOptions['test_kit'];
  try {
    kit = parse(raw) as TestOptions['test_kit'];
  } catch {
    throw new Error(
      `storyboard ${sbId} declares prerequisites.test_kit ${declaredLabel}, but the file is not valid YAML.`
    );
  }
  validateTestKit(kit);
  return { ...options, test_kit: kit };
}
