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
  if (!testKit) return;
  const auth = testKit.auth;
  if (!auth || typeof auth !== 'object') return;

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
      `test_kit.auth.probe_task must be a non-empty string; got ${JSON.stringify(probeTask)}.`
    );
  }
  if (!PROBE_TASK_ALLOWLIST.includes(probeTask)) {
    // Truncate + JSON-escape the echoed value so a hostile kit can't poison
    // the rendered compliance report with control chars, ANSI escapes, or
    // megabyte strings. Kits are operator-supplied, so this is defensive,
    // not adversarial — but the error message ends up in shareable reports.
    const safe = JSON.stringify(probeTask.slice(0, 120));
    throw new TestKitValidationError(
      'test_kit.auth.probe_task',
      `test_kit.auth.probe_task ${safe} is not in the allowlist. ` +
        `Allowed tasks (auth-required, read-only, accept empty body): ` +
        `${PROBE_TASK_ALLOWLIST.join(', ')}. ` +
        `Tasks outside this list can 400 on schema validation before auth is evaluated, ` +
        `which would misreport as an agent auth failure.`
    );
  }
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
 *     options.
 *   - A declared-but-unloadable kit throws: the storyboard cannot run as
 *     designed, and an explicit configuration error beats a deterministic
 *     false FAIL.
 */
export function resolveDeclaredTestKit<
  O extends { test_kit?: TestOptions['test_kit']; adcpVersion?: string; complianceDir?: string },
>(storyboard: { id?: string; prerequisites?: { test_kit?: string } }, options: O): O {
  const declared = storyboard.prerequisites?.test_kit;
  if (!declared || options.test_kit) return options;

  // Lazy imports keep this module safe for programmatic (non-filesystem) use.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join, resolve, sep } = require('node:path') as typeof import('node:path');
  const { parse } = require('yaml') as typeof import('yaml');
  const { getComplianceCacheDir } = require('./compliance') as typeof import('./compliance');

  const sbId = storyboard.id ?? '<unknown>';
  const cacheDir = resolve(
    getComplianceCacheDir({
      ...(options.adcpVersion !== undefined && { version: options.adcpVersion }),
      ...(options.complianceDir !== undefined && { complianceDir: options.complianceDir }),
    })
  );
  const kitPath = resolve(join(cacheDir, declared));
  // Containment: the declared path comes from cache-shipped YAML; never let
  // it escape the cache root.
  if (kitPath !== cacheDir && !kitPath.startsWith(cacheDir + sep)) {
    throw new Error(
      `storyboard "${sbId}" declares prerequisites.test_kit ${JSON.stringify(declared.slice(0, 120))} ` +
        `which resolves outside the compliance cache root — refusing to load it.`
    );
  }

  let raw: string;
  try {
    raw = readFileSync(kitPath, 'utf8');
  } catch {
    // A declared kit that isn't present in this cache is tolerated at load
    // time: storyboards may declare a kit whose auth no step uses (and
    // external bundles may omit kit files entirely). Steps that DO require
    // the credential hard-fail individually in `authHeadersForStep` with an
    // explicit configuration error — never a silent unauthenticated probe.
    return options;
  }
  let kit: TestOptions['test_kit'];
  try {
    kit = parse(raw) as TestOptions['test_kit'];
  } catch (err) {
    throw new Error(
      `storyboard "${sbId}" declares prerequisites.test_kit "${declared}" but ${kitPath} is not ` +
        `valid YAML: ${err instanceof Error ? err.message : String(err)}.`
    );
  }
  validateTestKit(kit);
  return { ...options, test_kit: kit };
}
