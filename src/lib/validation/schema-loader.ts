/**
 * JSON Schema loader for AdCP tool request/response validation.
 *
 * Loads the bundled per-tool schemas shipped with the SDK plus the
 * `core/` schemas that async response variants `$ref`, then compiles
 * AJV validators lazily by `(toolName, direction)`.
 *
 * Stage 3: state is per-AdCP-version. The same SDK instance can hold
 * compiled validators for `3.0.0`, `3.0.1`, `3.1.0-beta.1`, etc. side by
 * side; callers pass the version they're validating against. Default is
 * the SDK-pinned `ADCP_VERSION` so callers that don't care about
 * cross-version selection (most internal call sites) keep working
 * unchanged.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { ADCP_VERSION } from '../version';

export type ResponseVariant = 'sync' | 'submitted' | 'working' | 'input-required';
export type Direction = 'request' | ResponseVariant;

interface LoadedSchema {
  $id?: string;
  [k: string]: unknown;
}

const SCHEMA_FILENAME_SUFFIX: Record<Direction, string> = {
  request: 'request',
  sync: 'response',
  submitted: 'async-response-submitted',
  working: 'async-response-working',
  'input-required': 'async-response-input-required',
};

/**
 * Map a consumer-provided version pin to the loader's bundle key.
 *
 *   - Stable semver `'3.0.0'` / `'3.0.1'` → `'3.0'` (latest patch in minor)
 *   - Bare minor `'3.0'` → `'3.0'` (already the bundle key)
 *   - Prerelease `'3.1.0-beta.1'` → `'3.1.0-beta.1'` (exact-version, intentional pin)
 *   - Legacy alias `'v3'` → `'v3'` (pass-through; cache keeps these as-is)
 *   - Unparseable input → returned as-is so the existsSync check fails with
 *     a clear "not found" error rather than a confusing rewrite
 *
 * Per the AdCP spec convention patches don't change wire shape, so collapsing
 * stable patches into the minor is functionally equivalent for any validator
 * consumer. Prereleases are kept exact because pinning a beta is intentional
 * and bit-fidelity matters for cross-version interop tests.
 */
export function resolveBundleKey(version: string): string {
  // Bare 'MAJOR.MINOR' (no patch).
  const minorOnly = version.match(/^(\d+)\.(\d+)$/);
  if (minorOnly) return `${minorOnly[1]}.${minorOnly[2]}`;
  // Full 'MAJOR.MINOR.PATCH' with optional prerelease.
  const semver = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (semver) {
    const [, major, minor, , prerelease] = semver;
    if (prerelease !== undefined) return version;
    return `${major}.${minor}`;
  }
  // Legacy alias / unrecognized — pass through.
  return version;
}

/**
 * Resolve the directory that holds the bundled + core schemas for a given
 * AdCP version. Source layout (dev):
 *   schemas/cache/<exact-version>/{bundled,core}
 * Built layout (dist):
 *   dist/lib/schemas-data/<bundle-key>/{bundled,core}
 *
 * Stable releases use minor-name keys (`3.0/`); prereleases use full-version
 * keys (`3.1.0-beta.1/`). See {@link resolveBundleKey}.
 *
 * Falls back to the source-tree cache when dist isn't built (dev workflow
 * before `npm run build:lib`). For stable pins, the cache fallback scans
 * for the highest-patch sibling in the requested minor — `'3.0.0'` resolves
 * to `schemas/cache/3.0.1/` when only `3.0.1` is cached, matching dist's
 * collapse behavior.
 *
 * Throws when no bundle exists. Callers pinning a specific prerelease
 * surface the error; the construction-time fence in `resolveAdcpVersion`
 * catches most cross-major mistakes before this point.
 */
function resolveSchemaRoot(version: string): string {
  const key = resolveBundleKey(version);
  const distCandidate = path.join(__dirname, '..', 'schemas-data', key);
  if (existsSync(distCandidate)) return distCandidate;

  // Source-tree fallback: cache stays exact-version-named, so map the key
  // back to the highest-patch cache directory in the same minor for stable
  // pins. Prereleases need an exact match.
  const cacheRoot = path.join(__dirname, '..', '..', '..', 'schemas', 'cache');
  const exactCandidate = path.join(cacheRoot, version);
  if (existsSync(exactCandidate)) return exactCandidate;

  // For minor-only or stable-patch pins, find the highest stable patch in
  // the cache that matches the resolved minor.
  const minorMatch = key.match(/^(\d+)\.(\d+)$/);
  if (minorMatch && existsSync(cacheRoot)) {
    const [, major, minor] = minorMatch;
    const prefix = `${major}.${minor}.`;
    const cached = readdirSync(cacheRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(prefix) && /^\d+\.\d+\.\d+$/.test(e.name))
      .map(e => ({
        name: e.name,
        patch: parseInt(e.name.slice(prefix.length), 10),
      }))
      .filter(c => Number.isFinite(c.patch))
      .sort((a, b) => b.patch - a.patch);
    if (cached.length > 0) return path.join(cacheRoot, cached[0]!.name);
  }

  throw new Error(
    `AdCP schema data for version "${version}" not found. ` +
      `Looked for bundle key "${key}" in ${distCandidate}, exact path ${exactCandidate}, ` +
      `and the latest-patch fallback in ${cacheRoot}. ` +
      `Run \`npm run sync-schemas\` and \`npm run build:lib\` to populate the bundle.`
  );
}

interface LoaderState {
  ajv: Ajv;
  fileIndex: Map<string, string>;
  validators: Map<string, ValidateFunction>;
  rawSchemas: Map<string, Record<string, unknown>>;
  root: string;
  coreLoaded: boolean;
  version: string;
}

const states: Map<string, LoaderState> = new Map();

function walkJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function loadJson(file: string): LoadedSchema {
  return JSON.parse(readFileSync(file, 'utf-8')) as LoadedSchema;
}

/**
 * Clear `additionalProperties: false` at the response root so envelope
 * fields (`replayed`, `context`, `ext`, and future envelope additions)
 * can ride alongside the tool-specific body — per security.mdx the
 * envelope is always extensible. Upstream bundled schemas pin
 * `additionalProperties: false` at the root on a handful of mutating
 * tools (the property-list family), which rejects envelope fields like
 * `replayed` that aren't declared in the tool-specific body.
 *
 * Scope is deliberately narrow: only the top-level object, plus each
 * direct branch of a root-level `oneOf` / `anyOf` / `allOf`. Nested
 * bodies stay strict so response-side drift detection still catches
 * typos inside `Product`, `Package`, `MediaBuy` etc. Applied only to
 * response variants; request schemas stay strict so outgoing drift
 * fails at the edge.
 */
function relaxResponseRoot(schema: LoadedSchema): LoadedSchema {
  const clone = { ...schema };
  if (clone.additionalProperties === false) {
    clone.additionalProperties = true;
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = clone[key];
    if (Array.isArray(branches)) {
      clone[key] = branches.map(branch => {
        if (!branch || typeof branch !== 'object') return branch;
        const branchClone = { ...(branch as Record<string, unknown>) };
        if (branchClone.additionalProperties === false) {
          branchClone.additionalProperties = true;
        }
        return branchClone;
      });
    }
  }
  return clone;
}

/**
 * Build the (toolName, direction) → file path index by scanning the schema
 * tree once. Runs eagerly at first validator lookup.
 */
function buildFileIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  const record = (toolName: string, direction: Direction, file: string): void => {
    index.set(`${toolName}::${direction}`, file);
  };

  // Sync request/response live in the pre-resolved bundled/ tree.
  const bundledRoot = path.join(root, 'bundled');
  for (const file of walkJsonFiles(bundledRoot)) {
    const base = path.basename(file, '.json');
    if (base.endsWith('-request')) {
      const tool = base.slice(0, -'-request'.length).replace(/-/g, '_');
      record(tool, 'request', file);
    } else if (base.endsWith('-response')) {
      const tool = base.slice(0, -'-response'.length).replace(/-/g, '_');
      record(tool, 'sync', file);
    }
  }

  // Async variants AND domain schemas that ship flat (not pre-bundled) both
  // live in the per-domain directories. Walk each for sync request/response
  // files and async variant files. Skip `bundled/` (already indexed above)
  // and `core/` (pure $ref targets, no tools).
  //
  // Flat-tree domains include `governance/`, `brand/`, `account/`,
  // `content-standards/`, `property/`, `collection/` — their schemas are
  // NOT pre-resolved into `bundled/`, so a bundled-only walk would miss
  // every `check_governance` / `acquire_rights` / `creative_approval` /
  // `sync_governance` / `*_property_list` request-response pair. That gap
  // (flagged by the ad-tech-protocol reviewer on PR #831) would leave
  // protocol-wide-requirement-bearing tasks (idempotency_key pattern,
  // `format: uri` on `caller`) invisible to the strict-validation signal.
  // Register flat-tree sync pairs only when `bundled/` didn't already
  // index them, so pre-resolved schemas (with $refs already inlined) win
  // for any domain that ships both.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'bundled' || entry.name === 'core') continue;
    const domainDir = path.join(root, entry.name);
    for (const file of walkJsonFiles(domainDir)) {
      const base = path.basename(file, '.json');
      if (base.endsWith('-async-response-submitted')) {
        const tool = base.slice(0, -'-async-response-submitted'.length).replace(/-/g, '_');
        record(tool, 'submitted', file);
      } else if (base.endsWith('-async-response-working')) {
        const tool = base.slice(0, -'-async-response-working'.length).replace(/-/g, '_');
        record(tool, 'working', file);
      } else if (base.endsWith('-async-response-input-required')) {
        const tool = base.slice(0, -'-async-response-input-required'.length).replace(/-/g, '_');
        record(tool, 'input-required', file);
      } else if (base.endsWith('-request')) {
        const tool = base.slice(0, -'-request'.length).replace(/-/g, '_');
        if (!index.has(`${tool}::request`)) record(tool, 'request', file);
      } else if (base.endsWith('-response')) {
        const tool = base.slice(0, -'-response'.length).replace(/-/g, '_');
        if (!index.has(`${tool}::sync`)) record(tool, 'sync', file);
      }
    }
  }

  return index;
}

function ensureInit(version: string): LoaderState {
  // States are keyed by bundle key, not by raw version string, so
  // `getValidator('foo', 'request', '3.0.0')` and the same call with
  // `'3.0.1'` share state — both resolve to bundle key `'3.0'` and the
  // same compiled AJV instance.
  const key = resolveBundleKey(version);
  const cached = states.get(key);
  if (cached) return cached;

  const root = resolveSchemaRoot(version);
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  const state: LoaderState = {
    ajv,
    fileIndex: buildFileIndex(root),
    validators: new Map(),
    rawSchemas: new Map(),
    root,
    coreLoaded: false,
    version: key,
  };
  states.set(key, state);
  return state;
}

/**
 * Lazily pre-register every non-tool JSON schema shipped with the SDK so
 * cross-domain `$ref`s compile. Async response variants and flat-tree
 * domain schemas `$ref` out to three classes of building-block schemas:
 *
 *   - `core/` + `enums/` — shared primitives referenced by every domain.
 *   - `pricing-options/`, `error-details/`, `extensions/` — stand-alone
 *     fragment trees.
 *   - Sibling fragments inside each domain directory — e.g.
 *     `governance/audience-constraints.json` referenced by
 *     `governance/sync-plans-request.json`, or `signals/*` fragments
 *     referenced by `signals/activate-signal-*.json`.
 *
 * Walk every directory except `bundled/` (pre-resolved schemas with refs
 * already inlined). Skip files that `buildFileIndex` registered as tool
 * request/response — those compile via `getValidator` with
 * `relaxResponseRoot` applied to the response variant, and pre-registering
 * the raw schema would short-circuit the relaxation. The fileIndex check
 * is stricter than a filename-suffix match: building-block fragments like
 * `core/pagination-response.json` end in `-response.json` but aren't tools,
 * so suffix-matching would wrongly exclude them.
 */
function ensureCoreLoaded(s: LoaderState): void {
  if (s.coreLoaded) return;
  const toolFiles = new Set(s.fileIndex.values());
  for (const entry of readdirSync(s.root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'bundled') continue;
    const abs = path.join(s.root, entry.name);
    for (const file of walkJsonFiles(abs)) {
      if (toolFiles.has(file)) continue;
      const schema = loadJson(file);
      if (typeof schema.$id === 'string' && !s.ajv.getSchema(schema.$id)) {
        s.ajv.addSchema(schema);
      }
    }
  }
  s.coreLoaded = true;
}

/**
 * Look up the compiled AJV validator for a given tool + direction in the
 * specified AdCP version's schema bundle. Returns `undefined` when no
 * schema exists for the pair — callers can skip validation cleanly (e.g.,
 * custom tools outside the AdCP spec).
 *
 * `version` defaults to the SDK-pinned `ADCP_VERSION`. Pass the per-instance
 * `getAdcpVersion()` value when the validator should track the client/server's
 * configured pin (Stage 3+).
 */
export function getValidator(
  toolName: string,
  direction: Direction,
  version: string = ADCP_VERSION
): ValidateFunction | undefined {
  const s = ensureInit(version);
  const cacheKey = `${toolName}::${direction}`;
  const cached = s.validators.get(cacheKey);
  if (cached) return cached;

  const file = s.fileIndex.get(cacheKey);
  if (!file) return undefined;

  // Schemas that $ref into core/ and enums/ need those trees registered
  // before compile. Async response variants always do; flat-tree domain
  // schemas (anything outside `bundled/`) do too — their $refs weren't
  // pre-resolved at spec-publish time.
  const fromBundled = file.includes(`${path.sep}bundled${path.sep}`);
  if (!fromBundled) ensureCoreLoaded(s);

  const rawSchema = loadJson(file);
  const schema = direction === 'request' ? rawSchema : relaxResponseRoot(rawSchema);
  const existing = typeof schema.$id === 'string' ? s.ajv.getSchema(schema.$id) : undefined;
  const compiled = existing ?? s.ajv.compile(schema);
  s.validators.set(cacheKey, compiled);
  return compiled;
}

/** List of (toolName, direction) pairs that have schemas. Used by tests. */
export function listValidatorKeys(version: string = ADCP_VERSION): string[] {
  const s = ensureInit(version);
  return [...s.fileIndex.keys()].sort();
}

/** Suffix used in the suffix table — exported for testing. */
export { SCHEMA_FILENAME_SUFFIX };

/**
 * Test hook: reset cached state. With no argument, clears every version's
 * loader state; with a version, clears only the bundle that version
 * resolves to (so passing `'3.0.0'` and `'3.0.1'` both clear the `'3.0'`
 * bundle).
 */
export function _resetValidationLoader(version?: string): void {
  if (version === undefined) {
    states.clear();
  } else {
    states.delete(resolveBundleKey(version));
  }
}

/**
 * Returns true when `field` is a declared top-level property in the request
 * schema for `toolName`, or when no schema is available (fail-open). Used by
 * the storyboard runner to decide whether to inject envelope fields that aren't
 * universally present across tools (e.g. `brand`, `account`).
 *
 * Reads the raw JSON schema file without compiling — avoids coupling to AJV
 * internals. Only inspects the top-level `properties` / `additionalProperties`
 * pair; nested sub-schemas are not traversed. Results are memoized in
 * `LoaderState.rawSchemas` so multi-step storyboard runs don't re-read the
 * same file on each step.
 *
 * Fails open (returns `true`) when:
 * - No schema file is indexed for the tool (custom tool, schema not synced)
 * - The schema root is not reachable (schemas not built/synced yet)
 * - The schema does not set `additionalProperties: false` (permissive schema)
 *
 * @internal — not part of the public API surface; may change without a major bump.
 */
export function schemaAllowsTopLevelField(toolName: string, field: string, version: string = ADCP_VERSION): boolean {
  try {
    const s = ensureInit(version);
    const cacheKey = `${toolName}::request`;
    const file = s.fileIndex.get(cacheKey);
    if (!file) return true;
    let schema = s.rawSchemas.get(cacheKey);
    if (!schema) {
      schema = loadJson(file) as Record<string, unknown>;
      s.rawSchemas.set(cacheKey, schema);
    }
    if (schema.additionalProperties === false) {
      const props = schema.properties as Record<string, unknown> | undefined;
      return props !== undefined && field in props;
    }
    return true;
  } catch {
    return true;
  }
}
