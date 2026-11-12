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
 *
 * An agent that advertises none of the allowlist can still have its auth
 * verified: {@link selectProbeTask} falls back to the MCP session probe, which
 * calls a *canonical* AdCP read task the agent does advertise. An agent whose
 * whole surface is its own invented tool names has nothing the runner will
 * trust as a protected AdCP operation, and is reported
 * `session_probe_ungradable` with a remedy rather than certified. That sentinel
 * is intentionally absent from {@link PROBE_TASK_ALLOWLIST} so a kit cannot
 * name it via `probe_task`; the runner resolves it, or a storyboard may name it
 * directly, and either way `planMcpSessionSentinel` grades it honestly — and
 * only on an explicit `protocol: 'mcp'`.
 */

import type { TestKitAuth, TestOptions } from '../types';
import { MCP_SESSION_PROBE_TASK } from './types';
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
  'list_accounts',
]);

/**
 * Human-readable rendering of {@link PROBE_TASK_ALLOWLIST}, so probe, runner
 * and operator-facing remedies all name the same tools and cannot drift.
 *
 * Internal to the runner: exported for sibling modules, deliberately **not**
 * re-exported from `@adcp/sdk/testing`. Report consumers should read
 * {@link PROBE_TASK_ALLOWLIST} (which is public) and render it themselves.
 *
 * @internal
 */
export const PROBE_TASK_ALLOWLIST_SUMMARY: string = PROBE_TASK_ALLOWLIST.join(', ');

/**
 * Select an advertised auth probe without dispatching an inapplicable tool.
 * The configured task is a preference, not permission to call a tool the
 * agent did not advertise.
 *
 * Resolution order:
 *   1. Discovery unavailable (`advertisedTools === undefined`) → the caller's
 *      preference, unchanged. The runner has no tool list to vet it against.
 *   2. The preference, when it is allowlisted AND advertised.
 *   3. The first allowlisted task the agent advertises.
 *   4. **MCP only**: the {@link MCP_SESSION_PROBE_TASK} sentinel
 *      (adcp-client#2940). An agent whose entire read surface sits outside the
 *      allowlist may still expose a canonical protected read
 *      (`get_principal`, `list_tasks`, …), and the sentinel drives a complete
 *      session lifecycle (`initialize` → `notifications/initialized` →
 *      `tools/call`) against one — so `security_baseline` can verify a
 *      correctly configured agent instead of reporting
 *      `auth_mechanism_verified: []`. The chosen tool is called with empty
 *      arguments; when the agent refuses that shape the probe reports
 *      *inconclusive* rather than guessing, which is the hazard the allowlist
 *      exists to avoid.
 *   5. Anything other than an explicit `protocol: 'mcp'` → `undefined`
 *      (unchanged). A2A's `message/send` requires `params.message` and has no
 *      equivalent parameter-free protected operation, and an unset protocol
 *      means the caller never declared a transport — neither is a safe place
 *      to substitute an MCP probe.
 */
export function selectProbeTask(
  preferred: string | undefined,
  advertisedTools: readonly string[] | undefined,
  options: { protocol?: 'mcp' | 'a2a' } = {}
): string | undefined {
  if (!advertisedTools) return preferred;
  const advertised = new Set(advertisedTools);
  if (preferred && PROBE_TASK_ALLOWLIST.includes(preferred) && advertised.has(preferred)) return preferred;
  const advertisedProbe = PROBE_TASK_ALLOWLIST.find(task => advertised.has(task));
  if (advertisedProbe !== undefined) return advertisedProbe;
  // Only an *explicit* `protocol: 'mcp'` selects the sentinel. An unset
  // protocol means the caller never told the runner which transport it is
  // driving, and an A2A run has no equivalent parameter-free protected
  // operation; both keep the historical `undefined` resolution so the step
  // grades `not_applicable` instead of hard-failing on a substituted probe.
  return options.protocol === 'mcp' ? MCP_SESSION_PROBE_TASK : undefined;
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
  if (value.auth === undefined) return;
  validateTestKitAuthBlock(value.auth, 'test_kit.auth');
}

/**
 * Validate `options.test_kit_auth`, the credential laid over each storyboard's
 * declared kit (adcontextprotocol/adcp#8929).
 *
 * The overlay becomes a kit's whole `auth` block, so it carries the same
 * invariants: `probe_task` is required and must be allowlisted, and `api_key`
 * must be printable ASCII. A caller that also passes `test_kit` is refused
 * rather than having one of the two silently win: `test_kit` replaces every
 * declared kit while the overlay keeps them, so a silent choice would either
 * drop the declared fixtures or send a credential the caller did not pick.
 */
export function validateTestKitAuthOverlay(options: {
  test_kit?: TestOptions['test_kit'];
  test_kit_auth?: TestOptions['test_kit_auth'];
}): void {
  if (options.test_kit_auth === undefined) return;
  if (options.test_kit !== undefined) {
    throw new TestKitValidationError(
      'test_kit_auth',
      'Pass either test_kit or test_kit_auth, not both. test_kit replaces every storyboard-declared kit; ' +
        'test_kit_auth keeps each declared kit and replaces only its auth block.'
    );
  }
  validateTestKitAuthBlock(options.test_kit_auth, 'test_kit_auth');
}

function validateTestKitAuthBlock(auth: unknown, field: string): void {
  if (!isPlainMapping(auth)) {
    throw new TestKitValidationError(field, `${field} must be a YAML mapping.`);
  }

  const apiKey = auth.api_key;
  if (
    apiKey !== undefined &&
    (typeof apiKey !== 'string' || apiKey.trim().length === 0 || /[^\x20-\x7E]/u.test(apiKey))
  ) {
    throw new TestKitValidationError(
      `${field}.api_key`,
      `${field}.api_key must be a non-empty string containing only printable ASCII characters.`
    );
  }

  const probeTask = auth.probe_task;
  if (probeTask === undefined) {
    throw new TestKitValidationError(
      `${field}.probe_task`,
      `${field}.probe_task is required when ${field} is declared. ` +
        `Set it to one of: ${PROBE_TASK_ALLOWLIST.join(', ')}. ` +
        `The runner uses this task for the security_baseline unauth + invalid-key probes.`
    );
  }
  if (typeof probeTask !== 'string' || probeTask.length === 0) {
    throw new TestKitValidationError(
      `${field}.probe_task`,
      `${field}.probe_task must be a non-empty string selected from the allowlist.`
    );
  }
  if (!PROBE_TASK_ALLOWLIST.includes(probeTask)) {
    throw new TestKitValidationError(
      `${field}.probe_task`,
      `${field}.probe_task is not in the allowlist. ` +
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
 *     supplied `options.test_kit` (caller configuration wins for the whole
 *     run).
 *   - Otherwise loads `<compliance cache>/<declared path>`, validates it
 *     with the same invariants as a caller-supplied kit, and returns amended
 *     options. Loading requires an explicit caller-selected complianceDir or
 *     loader-attached trusted provenance (which the runner promotes to that
 *     option); a storyboard-authored version alone grants no filesystem
 *     authority.
 *   - A genuinely absent kit is tolerated because external bundles may omit
 *     kits that none of their steps use. Other filesystem faults, invalid
 *     YAML, and invalid kit shapes throw instead of degrading silently.
 *
 * `options.test_kit_auth` (adcontextprotocol/adcp#8929) is for callers that
 * grade with their own credential but still need each storyboard's own kit
 * fixtures. A run-level `test_kit` cannot do both: it replaces every
 * declared kit for the whole run.
 *
 *   - The declared kit keeps every field except `auth`, which the overlay
 *     replaces whole, so none of the kit's own `api_key`, `basic` or
 *     `probe_task` sits next to the caller's credential.
 *   - A kit with `sandbox: false` keeps its own `auth` (or none). It names a
 *     live-mode principal the storyboard is written around; sending the
 *     caller's sandbox credential in its place grades a conformant seller
 *     FAIL (adcp#6735).
 *   - A storyboard that declares no kit gets `{ auth: test_kit_auth }` alone.
 *   - A declared kit that cannot be loaded (no trusted cache root, or no such
 *     file) gets no overlay: nothing says it is not a live-mode principal, so
 *     its `from_test_kit` steps fail as configuration errors, exactly as they
 *     would without `test_kit_auth`.
 *   - The resulting kit is validated after the overlay. The overlay is always
 *     consumed: the returned options carry no `test_kit_auth`, so no later
 *     client (an `auth: none` probe included) can pick it up as a credential.
 *   - `test_kit` and `test_kit_auth` together throw.
 */
export function resolveDeclaredTestKit<
  O extends {
    test_kit?: TestOptions['test_kit'];
    test_kit_auth?: TestOptions['test_kit_auth'];
    adcpVersion?: string;
    complianceDir?: string;
  },
>(storyboard: { id?: string; prerequisites?: { test_kit?: string } }, options: O): O {
  validateTestKitAuthOverlay(options);
  if (options.test_kit !== undefined) return options;
  const declaredKit = loadDeclaredTestKit(storyboard, options.complianceDir);
  const { test_kit_auth: authOverlay, ...withoutOverlay } = options;
  if (authOverlay === undefined) {
    if (declaredKit === undefined) return options;
    validateTestKit(declaredKit);
    return { ...options, test_kit: declaredKit };
  }
  if (storyboard.prerequisites?.test_kit !== undefined && declaredKit === undefined) {
    return withoutOverlay as O;
  }
  const testKit = withAuthOverlay(declaredKit, authOverlay);
  validateTestKit(testKit);
  return { ...withoutOverlay, test_kit: testKit } as O;
}

function withAuthOverlay(kit: TestOptions['test_kit'], auth: TestKitAuth): TestOptions['test_kit'] {
  if (kit === undefined) return { auth };
  // A malformed kit stays as it is, so validateTestKit reports it.
  if (!isPlainMapping(kit) || kit.sandbox === false) return kit;
  return { ...kit, auth };
}

/**
 * Load a storyboard's declared kit from the compliance cache, unvalidated.
 * `undefined` when the storyboard declares none, no trusted cache root is
 * selected, or the file is absent.
 */
function loadDeclaredTestKit(
  storyboard: { id?: string; prerequisites?: { test_kit?: string } },
  complianceDir: string | undefined
): TestOptions['test_kit'] {
  const declared = storyboard.prerequisites?.test_kit;
  if (declared === undefined) return undefined;
  if (typeof declared !== 'string' || declared.trim().length === 0) {
    throw new Error(
      `storyboard ${safeLabel(storyboard.id)} declares an invalid prerequisites.test_kit path; expected a non-empty string.`
    );
  }
  // Storyboard YAML is data, not authority to read credentials from the SDK's
  // packaged cache (or ADCP_COMPLIANCE_DIR). Only the caller or the trusted
  // compliance loader may select a filesystem root.
  if (complianceDir === undefined) return undefined;
  if (typeof complianceDir !== 'string' || complianceDir.trim().length === 0) {
    throw new Error(
      `storyboard ${safeLabel(storyboard.id)} received an invalid complianceDir for its declared test kit; expected a non-empty string.`
    );
  }

  const sbId = safeLabel(storyboard.id);
  const declaredLabel = safeLabel(declared);
  const cacheDir = resolve(complianceDir);
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
    if (filesystemErrorCode(err) === 'ENOENT') return undefined;
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
    if (filesystemErrorCode(err) === 'ENOENT') return undefined;
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
  try {
    return parse(raw) as TestOptions['test_kit'];
  } catch {
    throw new Error(
      `storyboard ${sbId} declares prerequisites.test_kit ${declaredLabel}, but the file is not valid YAML.`
    );
  }
}
