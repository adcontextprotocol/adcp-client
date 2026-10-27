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

import Ajv, { type KeywordDefinition, type ValidateFunction } from 'ajv';
import type { SchemaDiagnosticOrigin, SchemaDiagnosticOrigins } from './schema-diagnostic-origins';
import addFormats from 'ajv-formats';
import { AsyncLocalStorage } from 'async_hooks';
import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'node:util';
import { ADCP_VERSION } from '../version';
import { ConfigurationError } from '../errors';
import {
  clearBundledSchemaStoreCache,
  hasBundledSchemaStore,
  listBundledSchemaFiles,
  loadBundledSchemaFile,
} from './bundled-schema-store';

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

// Protocol bundles may ship transport-specific schema projections alongside
// the canonical AdCP schemas. They are not runtime validation sources: the
// official clients own transport framing, while this loader validates the
// canonical tool arguments/results. AdCP 3.2's `mcp/2026-07-28` projection
// also uses JSON Schema 2020-12, whereas the canonical bundle remains
// Draft-07. Mixing it into the canonical AJV registry both indexes duplicate
// tools and makes a Draft-07 instance attempt to register another dialect.
const TRANSPORT_PROJECTION_DIRECTORIES = new Set(['mcp']);

function isRuntimeSchemaDirectory(name: string): boolean {
  return name !== 'bundled' && !TRANSPORT_PROJECTION_DIRECTORIES.has(name);
}

/**
 * Map a consumer-provided version pin to the loader's bundle key.
 *
 *   - Stable semver `'3.0.0'` / `'3.0.1'` → `'3.0'` (latest patch in minor)
 *   - Bare minor `'3.0'` → `'3.0'` (already the bundle key)
 *   - Release-precision prerelease `'3.1-beta'` / `'3.1-beta.0'` →
 *     returned verbatim. {@link resolveSchemaRoot} fuzzy-resolves to the
 *     highest cached prerelease directory whose own release-precision form
 *     matches (e.g. `'3.1-beta'` matches `schemas/cache/3.1.0-beta.0/`).
 *     Accepted because sellers advertise `supported_versions` in this
 *     shape (`["3.1-beta"]`), and a buyer reading that off the wire must
 *     be able to pin to it.
 *   - Full prerelease semver `'3.1.0-beta.1'` → `'3.1.0-beta.1'`
 *     (exact-version, intentional pin)
 *   - Legacy alias `'v3'` / `'v2.5'` / `'v2.6'` → returned verbatim (cache
 *     historically keyed these directories by the alias name)
 *
 * Per the AdCP spec convention patches don't change wire shape, so collapsing
 * stable patches into the minor is functionally equivalent for any validator
 * consumer. Prereleases are kept exact because pinning a beta is intentional
 * and bit-fidelity matters for cross-version interop tests.
 *
 * Throws `ConfigurationError` for any input that doesn't match one of the
 * recognized shapes. Strings reach `path.join` via `resolveSchemaRoot`, and
 * pass-through of arbitrary garbage (`'../etc'`, `'3foo'`) lets a non-version
 * directory probe leak through `hasSchemaBundle`'s boolean. The throw is
 * caught by `hasSchemaBundle`'s try/catch (still returns false) and surfaces
 * with a useful field name from `resolveAdcpVersion`.
 */
export function resolveBundleKey(version: string): string {
  if (/^v?2(?:\.|$)/.test(version)) {
    throw new ConfigurationError(
      'AdCP 2 reached end of life on 2026-08-01; only AdCP 3 schema bundles are supported.',
      'adcpVersion'
    );
  }
  // Bare 'MAJOR.MINOR' (no patch).
  const minorOnly = version.match(/^(\d+)\.(\d+)$/);
  if (minorOnly) return `${minorOnly[1]}.${minorOnly[2]}`;
  // Release-precision prerelease 'MAJOR.MINOR-PRE' (no patch). Same SemVer §9
  // prerelease constraint as the full-semver branch — `'3.1-/../etc'`-style
  // strings can't slip through. Returns verbatim; resolveSchemaRoot does the
  // fuzzy directory match.
  const releasePrecisionPre = version.match(/^(\d+)\.(\d+)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/);
  if (releasePrecisionPre) return version;
  // Full 'MAJOR.MINOR.PATCH' with optional prerelease. Prerelease group
  // restricted to SemVer §9 identifiers (alphanumerics + hyphen,
  // dot-separated) so `'3.0.0-/../etc'`-style strings can't slip through
  // and reach `path.join` as a directory component. The full version is
  // returned verbatim for prereleases, so this is the last line of defense
  // before that string becomes a path segment.
  const semver = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (semver) {
    const [, major, minor, , prerelease] = semver;
    if (prerelease !== undefined) return version;
    return `${major}.${minor}`;
  }
  // Legacy alias: 'v' followed by a major and optional minor. Restricted to
  // this exact shape so non-version garbage can't reach the filesystem.
  const legacyAlias = version.match(/^v\d+(\.\d+)?$/);
  if (legacyAlias) return version;
  throw new ConfigurationError(
    `AdCP version ${JSON.stringify(version)} is not a recognized version format. ` +
      `Expected semver (e.g. '3.0.1', '3.1.0-beta.1'), bare minor ('3.0'), ` +
      `release-precision ('3.1-beta'), or legacy alias ('v3', 'v2.5').`,
    'adcpVersion'
  );
}

/**
 * Collapse a bundle key to the release-precision string the AdCP wire schema
 * accepts for the `adcp_version` envelope field (spec PR
 * `adcontextprotocol/adcp#3493`). The wire pattern is
 * `^\d+\.\d+(-[a-zA-Z0-9.-]+)?$` — release-precision (MAJOR.MINOR with
 * optional prerelease), never full MAJOR.MINOR.PATCH semver.
 *
 *   - Stable bundle key `'3.0'` / `'3.1'` → returned verbatim.
 *   - Prerelease bundle key `'3.1.0-beta.0'` → `'3.1-beta.0'` (PATCH segment
 *     dropped; the prerelease tag is the wire-meaningful release identifier,
 *     PATCH is implementation-internal).
 *   - Full stable semver `'3.0.11'` → `'3.0'` (patches don't change wire
 *     shape; surface them via `build_version` on capabilities instead).
 *   - Legacy alias `'v3'` / `'v2.5'` — returned verbatim. The wire spec
 *     predates the envelope field, so legacy-aliased clients won't emit
 *     `adcp_version` anyway (gated by `bundleSupportsAdcpVersionField`).
 *
 * The normalization rule is declared in `core/version-envelope.json`:
 *
 *   > SDKs that read full-semver values from bundle metadata (e.g.
 *   > ComplianceIndex.published_version = "3.1.0-beta.1") MUST normalize to
 *   > release-precision ("3.1-beta.1") before emitting on the wire —
 *   > meta-field values are NOT valid wire values.
 *
 * **Idempotent.** Re-applying to an already-wire-shaped value is a no-op:
 * `toReleasePrecisionWire('3.1-beta.0') === '3.1-beta.0'`. Safe to call
 * defensively on values a caller read off the wire and is passing back.
 *
 * **Prerelease regex is stricter than the wire pattern by design.** The wire
 * pattern allows `[a-zA-Z0-9.-]+` (any mix of dots and hyphens), but this
 * function only accepts SemVer §9-shaped prerelease tags
 * (`[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*`) — disallowing leading dots, double
 * dots, or trailing dots. Mirrors the path-traversal hardening on
 * {@link resolveBundleKey} (`'3.0.0-/../etc'`-style strings can't reach the
 * filesystem there, and shouldn't be silently mirrored to the wire here).
 * A future reader who wants to "fix" this to match the wire regex
 * character-for-character should NOT — the strictness is intentional.
 *
 * Defense: rejecting unrecognized shapes here surfaces SDK-internal misuse
 * (someone calling this with raw garbage) loudly instead of silently
 * emitting a non-spec wire string.
 */
/**
 * The exact pattern `core/version-envelope.json` applies to `adcp_version`
 * on the wire. Kept verbatim so {@link validateAdcpVersionWire} doesn't
 * drift from the spec — bump only when the spec itself bumps.
 */
const ADCP_VERSION_WIRE_PATTERN = /^\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;

/**
 * Validate a string against the AdCP 3.1 `adcp_version` wire pattern.
 * Throws `ConfigurationError` with a hint that points at
 * {@link toReleasePrecisionWire} when the value would be sent on the wire
 * but doesn't satisfy `core/version-envelope.json`'s pattern.
 *
 * Use this when you're constructing a request envelope by hand (storyboard
 * fixtures, conformance harnesses, custom transports) and want a clear
 * error rather than a downstream AJV pattern-mismatch from the seller —
 * by the time the seller rejects the request, the buyer's stack frame is
 * long gone and `core/version-envelope.json/properties/adcp_version/pattern`
 * is the only clue.
 *
 * The SDK's own `buildVersionEnvelope` calls this as a postcondition after
 * normalizing the bundle key — should never throw in well-formed SDK code,
 * but if a future refactor breaks the normalization the assertion fires
 * with a message that names the helper to call.
 *
 * Returns the value with the type narrowed to `string` via assertion.
 */
export function validateAdcpVersionWire(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new ConfigurationError(
      `adcp_version must be a string. Got ${typeof value}. ` +
        `Use toReleasePrecisionWire() to convert a bundle key or full-semver pin to a wire-shaped string.`,
      'adcp_version'
    );
  }
  if (!ADCP_VERSION_WIRE_PATTERN.test(value)) {
    throw new ConfigurationError(
      `adcp_version ${JSON.stringify(value)} doesn't match the AdCP 3.1 wire pattern ${ADCP_VERSION_WIRE_PATTERN}. ` +
        `Full-semver bundle keys (e.g. "3.1.0-beta.0") are NOT valid wire values — ` +
        `call toReleasePrecisionWire() to normalize (e.g. "3.1.0-beta.0" → "3.1-beta.0").`,
      'adcp_version'
    );
  }
}

export function toReleasePrecisionWire(bundleKeyOrVersion: string): string {
  // Bare release-precision (MAJOR.MINOR or MAJOR.MINOR-PRE) — already wire-shaped.
  const releasePrecision = bundleKeyOrVersion.match(/^(\d+)\.(\d+)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (releasePrecision) {
    const [, major, minor, prerelease = ''] = releasePrecision;
    return `${major}.${minor}${prerelease}`;
  }
  // Full semver — collapse PATCH segment. Prerelease (if any) is preserved.
  const fullSemver = bundleKeyOrVersion.match(/^(\d+)\.(\d+)\.\d+(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (fullSemver) {
    const [, major, minor, prerelease = ''] = fullSemver;
    return `${major}.${minor}${prerelease}`;
  }
  // Legacy alias passthrough. Callers that reach here with a legacy alias
  // shouldn't be emitting `adcp_version` (no version-envelope support), but
  // returning the input verbatim is least-surprise.
  if (/^v\d+(\.\d+)?$/.test(bundleKeyOrVersion)) return bundleKeyOrVersion;
  throw new ConfigurationError(
    `Cannot normalize ${JSON.stringify(bundleKeyOrVersion)} to release-precision wire format. ` +
      `Expected a bundle key or AdCP version string.`,
    'adcpVersion'
  );
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
const identity33Scope = new AsyncLocalStorage<boolean>();
/** @internal Draft schema resolution is scoped to an explicitly configured instance. */
export function isIdentity33SchemaScope(): boolean {
  return identity33Scope.getStore() === true;
}
export function withIdentity33SchemaScope<T>(fn: () => T, enabled = true): T {
  return identity33Scope.run(enabled, fn);
}
export function bindIdentity33SchemaScope<T extends object>(instance: T): T {
  return new Proxy(instance, {
    get(target, property, receiver) {
      const value = withIdentity33SchemaScope(() => Reflect.get(target, property, receiver));
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) return value;
      return typeof value === 'function'
        ? (...args: unknown[]) => withIdentity33SchemaScope(() => value.apply(target, args))
        : value;
    },
  });
}

/** @internal Resolve the active schema authority for SDK-internal schema-derived behavior. */
export function resolveSchemaRoot(version: string): string {
  const key = resolveBundleKey(version);
  const scopedRoot = scopedExternalSchemaRoots.getStore()?.get(key);
  if (scopedRoot && existsSync(scopedRoot)) return scopedRoot;

  const externalRoot = externalSchemaRoots.get(key);
  if (externalRoot && existsSync(externalRoot)) return externalRoot;

  if (isIdentity33SchemaScope() && key === '3.3') return resolveSchemaRoot(ADCP_VERSION);
  const distCandidate = path.join(__dirname, '..', 'schemas-data', key);
  if (existsSync(distCandidate)) return distCandidate;

  // Published builds carry exact prerelease bundle directories
  // (`3.1.0-rc.1/`), while callers may pin the release-precision family
  // alias (`3.1-rc`). Resolve that alias before falling back to source cache.
  const releasePrecisionMatch = /^\d+\.\d+-/.test(key);
  if (releasePrecisionMatch) {
    const distPrereleaseCandidate = findPrereleaseBundle(path.join(__dirname, '..', 'schemas-data'), key);
    if (distPrereleaseCandidate) return distPrereleaseCandidate;
  }

  // Source-tree fallback: cache stays exact-version-named, so map the key
  // back to the highest-patch cache directory in the same minor for stable
  // pins. Prereleases need an exact match.
  const cacheRoot = path.join(__dirname, '..', '..', '..', 'schemas', 'cache');
  const exactCandidate = path.join(cacheRoot, version);
  if (existsSync(exactCandidate)) return exactCandidate;

  // For minor-only or stable-patch pins, find the highest stable patch in
  // the cache that matches the resolved minor. Skip `*.previous` snapshots
  // — `sync-schemas` writes those as transient backups during replaceTree;
  // a partially-written snapshot whose patch number happens to be highest
  // would otherwise win the sort.
  const minorMatch = key.match(/^(\d+)\.(\d+)$/);
  if (minorMatch && existsSync(cacheRoot)) {
    const [, major, minor] = minorMatch;
    const prefix = `${major}.${minor}.`;
    const cached = readdirSync(cacheRoot, { withFileTypes: true })
      .filter(
        e =>
          e.isDirectory() &&
          e.name.startsWith(prefix) &&
          !e.name.endsWith('.previous') &&
          /^\d+\.\d+\.\d+$/.test(e.name)
      )
      .map(e => ({
        name: e.name,
        patch: parseInt(e.name.slice(prefix.length), 10),
      }))
      .filter(c => Number.isFinite(c.patch))
      .sort((a, b) => b.patch - a.patch);
    if (cached.length > 0) return path.join(cacheRoot, cached[0]!.name);
  }

  // For release-precision prerelease pins (`'3.1-beta'`, `'3.1-beta.0'`),
  // find the highest cached prerelease directory whose own release-precision
  // form starts with the requested key. A pin of `'3.1-beta'` matches any
  // directory whose `toReleasePrecisionWire` form is `'3.1-beta'` or
  // `'3.1-beta.*'`. A pin of `'3.1-beta.0'` matches `'3.1-beta.0'` or
  // `'3.1-beta.0.*'`. Sort newest-first by directory name with numeric
  // collation so rc.10 wins over rc.9.
  if (releasePrecisionMatch) {
    const cachePrereleaseCandidate = findPrereleaseBundle(cacheRoot, key);
    if (cachePrereleaseCandidate) return cachePrereleaseCandidate;
  }

  throw new Error(
    `AdCP schema data for version "${version}" not found. ` +
      `Looked for bundle key "${key}" in ${distCandidate}, exact path ${exactCandidate}, ` +
      `and the latest-patch fallback in ${cacheRoot}. ` +
      `Run \`npm run sync-schemas\` and \`npm run build:lib\` to populate the bundle.`
  );
}

function findPrereleaseBundle(root: string, key: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const cached = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.endsWith('.previous'))
    .map(e => {
      try {
        return { name: e.name, rp: toReleasePrecisionWire(e.name) };
      } catch {
        return null;
      }
    })
    .filter((c): c is { name: string; rp: string } => c !== null)
    .filter(c => c.rp === key || c.rp.startsWith(`${key}.`))
    .sort((a, b) => compareBundleNamesDesc(a.name, b.name));
  if (cached.length === 0) return undefined;
  return path.join(root, cached[0]!.name);
}

function compareBundleNamesDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
}

interface LoaderState {
  ajv: Ajv;
  bundledAjv: Ajv;
  diagnosticOrigins: SchemaDiagnosticOrigins;
  bundledDiagnosticOrigins: SchemaDiagnosticOrigins;
  canonicalAjv?: Ajv;
  canonicalValidators: Map<string, ValidateFunction>;
  fileIndex: Map<string, string>;
  validators: Map<string, ValidateFunction>;
  rawSchemas: Map<string, Record<string, unknown>>;
  entityPaths: Map<string, SchemaEntityPath[]>;
  schemaIdFiles?: Map<string, string>;
  root: string;
  coreLoaded: boolean;
  version: string;
}

const states: Map<string, LoaderState> = new Map();
const validatorDiagnosticOrigins = new WeakMap<ValidateFunction, SchemaDiagnosticOrigins>();

/** @internal Resolve the exact function origin retained during compilation. */
export function resolveValidatorDiagnosticPath(validator: ValidateFunction, schemaPath: string): unknown {
  return validatorDiagnosticOrigins.get(validator)?.resolve(schemaPath);
}
/** @internal Resource identity and the original public AJV path for a failure. */
export function getValidatorDiagnosticOrigin(
  validator: ValidateFunction,
  schemaPath: string
): SchemaDiagnosticOrigin | undefined {
  return validatorDiagnosticOrigins.get(validator)?.origin(schemaPath);
}
const schemaRefValidators = new Map<string, ValidateFunction>();
const keywordSchemaRefValidators = new WeakMap<
  ReadonlyArray<KeywordDefinition>,
  { generation: number; validators: Map<string, ValidateFunction> }
>();
let keywordCacheGeneration = 0;

/** @internal Epoch for schema-derived caches sharing loader registration/scope invalidation. */
export function getSchemaLoaderGeneration(): number {
  return keywordCacheGeneration;
}
const externalSchemaRoots: Map<string, string> = new Map();
const scopedExternalSchemaRoots = new AsyncLocalStorage<Map<string, string>>();

function stateCacheKey(bundleKey: string, root: string): string {
  return `${bundleKey}\0${root}`;
}

function clearStatesForBundle(bundleKey: string): void {
  keywordCacheGeneration++;
  for (const [stateKey, state] of states) {
    if (state.version === bundleKey) states.delete(stateKey);
  }
  for (const cacheKey of schemaRefValidators.keys()) {
    if (cacheKey.startsWith(`${bundleKey}\0`)) schemaRefValidators.delete(cacheKey);
  }
}

function hasSchemaRootShape(root: string): boolean {
  if (!existsSync(root)) return false;
  const bundledRoot = path.join(root, 'bundled');
  const files = hasBundledSchemaStore(bundledRoot) ? walkJsonFiles(bundledRoot) : walkJsonFiles(root);
  return files.some(file => {
    try {
      const schema = loadJson(file);
      return typeof schema.$id === 'string' || typeof schema.$schema === 'string';
    } catch {
      return false;
    }
  });
}

function schemaIdVersionHint(schemaId: string): string | undefined {
  return schemaId.match(/\/schemas\/([^/]+)\//)?.[1];
}

function collectSchemaRootVersionAliases(root: string): Set<string> {
  const aliases = new Set<string>();
  for (const file of walkJsonFiles(root)) {
    let schema: LoadedSchema;
    try {
      schema = loadJson(file);
    } catch {
      continue;
    }
    if (typeof schema.$id !== 'string') continue;
    const hint = schemaIdVersionHint(schema.$id);
    if (!hint) continue;
    for (const alias of schemaRootVersionAliases(hint)) aliases.add(alias);
  }
  return aliases;
}

function schemaRootVersionAliases(version: string): Set<string> {
  const aliases = new Set<string>([version]);
  try {
    aliases.add(resolveBundleKey(version));
  } catch {
    // Keep the raw value only; callers that care will throw separately.
  }
  try {
    const releasePrecision = toReleasePrecisionWire(version);
    aliases.add(releasePrecision);
    const family = prereleaseFamilyAlias(releasePrecision);
    if (family) aliases.add(family);
  } catch {
    // Keep any aliases already collected.
  }
  return aliases;
}

function prereleaseFamilyAlias(releasePrecisionVersion: string): string | undefined {
  return releasePrecisionVersion.match(/^(\d+\.\d+-[0-9A-Za-z-]+)\.\d+$/)?.[1];
}

function collectSchemaRootVersionAliasGroups(root: string): Array<{ hint: string; aliases: Set<string> }> {
  const groups: Array<{ hint: string; aliases: Set<string> }> = [];
  for (const file of walkJsonFiles(root)) {
    let schema: LoadedSchema;
    try {
      schema = loadJson(file);
    } catch {
      continue;
    }
    if (typeof schema.$id !== 'string') continue;
    const hint = schemaIdVersionHint(schema.$id);
    if (!hint) continue;
    groups.push({ hint, aliases: schemaRootVersionAliases(hint) });
  }
  return groups;
}

function readSchemaRootDeclaredVersion(root: string): string | undefined {
  const candidates = [path.join(root, 'index.json')];
  if (path.basename(root) === 'bundled') candidates.push(path.join(path.dirname(root), 'index.json'));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const index = loadJson(candidate);
      if (typeof index.adcp_version === 'string' && index.adcp_version !== 'latest') {
        return index.adcp_version;
      }
    } catch {
      // The normal mismatch error below carries the actionable root/version context.
    }
  }
  return undefined;
}

function assertSchemaRootMatchesVersion(version: string, root: string): Set<string> {
  const expectedAliases = schemaRootVersionAliases(version);
  const rootGroups = collectSchemaRootVersionAliasGroups(root);
  const rootAliases = collectSchemaRootVersionAliases(root);
  const declaredVersion = readSchemaRootDeclaredVersion(root);
  const declaredAliases = declaredVersion ? schemaRootVersionAliases(declaredVersion) : new Set<string>();
  const latestIsPinnedByIndex = [...declaredAliases].some(alias => expectedAliases.has(alias));
  if (
    rootGroups.length > 0 &&
    rootGroups.every(
      group =>
        [...group.aliases].some(alias => expectedAliases.has(alias)) ||
        (group.hint === 'latest' && latestIsPinnedByIndex)
    )
  ) {
    return new Set([...expectedAliases, ...rootAliases]);
  }
  const found =
    rootGroups.length === 0
      ? 'no AdCP schema ids'
      : rootGroups
          .map(group => `${group.hint} (${Array.from(group.aliases).sort().join(', ')})`)
          .sort()
          .join(', ');
  throw new Error(
    `External AdCP schema root for version "${version}" at ${root} does not match the requested version and ` +
      `must contain only schema ids matching ${Array.from(expectedAliases).sort().join(', ')}, or "latest" ids ` +
      `pinned by a matching root index.json adcp_version; found ${found}.`
  );
}

const externalSchemaRootAliases: Map<string, Set<string>> = new Map();

/**
 * Register a schema bundle supplied outside the installed SDK package.
 *
 * Compliance runners use this when `--compliance-dir` points at another
 * package/check-out whose storyboards and schema bundle should be used
 * together. The root must be the schema-data directory itself, e.g.
 * `.../dist/lib/schemas-data/3.0`.
 */
export function registerExternalSchemaRoot(version: string, root: string): void {
  const key = resolveBundleKey(version);
  clearBundledSchemaStoreCache(path.join(root, 'bundled'));
  if (!hasSchemaRootShape(root)) {
    throw new Error(`External AdCP schema root for version "${version}" not found or empty at ${root}`);
  }
  const aliases = assertSchemaRootMatchesVersion(version, root);
  externalSchemaRootAliases.set(key, aliases);
  for (const alias of aliases) {
    externalSchemaRoots.set(alias, root);
    clearStatesForBundle(alias);
  }
}

/** Test/helper hook for unregistering an external schema bundle. */
export function unregisterExternalSchemaRoot(version: string): void {
  const key = resolveBundleKey(version);
  const aliases = new Set(schemaRootVersionAliases(version));
  for (const [registeredKey, registeredAliases] of externalSchemaRootAliases) {
    if (
      registeredKey === key ||
      registeredAliases.has(key) ||
      [...aliases].some(alias => registeredAliases.has(alias))
    ) {
      for (const alias of registeredAliases) aliases.add(alias);
      externalSchemaRootAliases.delete(registeredKey);
    }
  }
  for (const alias of aliases) {
    externalSchemaRoots.delete(alias);
    clearStatesForBundle(alias);
  }
}

/**
 * Run a callback with an external schema root scoped to the current async
 * execution chain. Unlike `registerExternalSchemaRoot`, this does not poison
 * process-global validation state for later hosted/compliance runs.
 */
export function withExternalSchemaRoot<T>(version: string, root: string | undefined, fn: () => T): T {
  if (root === undefined) return fn();
  clearBundledSchemaStoreCache(path.join(root, 'bundled'));
  if (!hasSchemaRootShape(root)) {
    throw new Error(`External AdCP schema root for version "${version}" not found or empty at ${root}`);
  }
  const aliases = assertSchemaRootMatchesVersion(version, root);
  const parent = scopedExternalSchemaRoots.getStore();
  const next = new Map(parent);
  for (const alias of aliases) {
    next.set(alias, root);
    clearStatesForBundle(alias);
  }
  return scopedExternalSchemaRoots.run(next, fn);
}

/**
 * Resolved on-disk location of the schema bundle validation currently uses
 * for `version`, with whether it came from a caller-supplied external root.
 *
 * Exposed so prepared fixture state can bind to the exact artifact it was
 * validated against rather than to a mutable version label. A run that swaps
 * the bundle underneath a prepared state must not silently reuse it.
 *
 * @internal — not part of the public API surface; may change without a major bump.
 */
export function getActiveSchemaArtifactLocation(version: string): {
  bundle_key: string;
  root: string;
  external: boolean;
} {
  return {
    bundle_key: resolveBundleKey(version),
    root: resolveSchemaRoot(version),
    external: isExternalSchemaRootActive(version),
  };
}

/**
 * Return whether validation for `version` currently resolves through a
 * caller-supplied schema bundle rather than the SDK's packaged snapshot.
 *
 * Storyboard validation uses this to make an explicit external JSON Schema
 * bundle authoritative. Without that distinction, the runner can validate a
 * response successfully with the supplied bundle and then fail the same
 * response against the older generated Zod schemas compiled into the SDK.
 *
 * @internal — not part of the public API surface; may change without a major bump.
 */
export function isExternalSchemaRootActive(version: string): boolean {
  const key = resolveBundleKey(version);
  if (isIdentity33SchemaScope() && key === '3.3') return true;
  const scopedRoot = scopedExternalSchemaRoots.getStore()?.get(key);
  if (scopedRoot && existsSync(scopedRoot)) return true;
  const registeredRoot = externalSchemaRoots.get(key);
  return registeredRoot !== undefined && existsSync(registeredRoot);
}

function walkJsonFiles(dir: string): string[] {
  if (path.basename(dir) === 'bundled') return listBundledSchemaFiles(dir);
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
  if (file.includes(`${path.sep}bundled${path.sep}`)) {
    const bundled = loadBundledSchemaFile(file);
    if (bundled) return bundled;
  }
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
 * Scope is deliberately narrow: only the top-level composition chain and
 * its `oneOf` / `anyOf` / `allOf` branches. Composition wrappers may be
 * nested (for example, `buy_products` is an `allOf` alias around the shared
 * commitment response's `oneOf`), so recurse through combinators without
 * descending into `properties`. Nested bodies therefore stay strict and
 * response-side drift detection still catches typos inside `Product`,
 * `Package`, `MediaBuy`, etc. Applied only to response variants; request
 * schemas stay strict so outgoing drift fails at the edge.
 */
/** @internal Shared by opt-in overlays that retain response-envelope compatibility. */
export function relaxResponseRoot(schema: LoadedSchema): LoadedSchema {
  const relaxCompositionNode = (node: Record<string, unknown>): Record<string, unknown> => {
    const clone = { ...node };
    if (clone.additionalProperties === false) {
      clone.additionalProperties = true;
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const branches = clone[key];
      if (Array.isArray(branches)) {
        clone[key] = branches.map(branch =>
          branch && typeof branch === 'object' ? relaxCompositionNode(branch as Record<string, unknown>) : branch
        );
      }
    }
    return clone;
  };

  return relaxCompositionNode(schema) as LoadedSchema;
}

function getAjvRegisteredIds(ajv: Ajv): Set<string> {
  const internals = ajv as unknown as {
    schemas?: Record<string, unknown>;
    refs?: Record<string, unknown>;
  };
  return new Set([...Object.keys(internals.schemas ?? {}), ...Object.keys(internals.refs ?? {})]);
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
    if (!isRuntimeSchemaDirectory(entry.name) || entry.name === 'core') continue;
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
  const root = resolveSchemaRoot(version);
  const cacheKey = stateCacheKey(key, root);
  const cached = states.get(cacheKey);
  if (cached) return cached;
  // Keep referenced validators separate: giant inlined functions can trigger
  // pathological V8 Maglev compilation and native-memory growth on Node 24.
  const { createSchemaDiagnosticOrigins } =
    require('./schema-diagnostic-origins') as typeof import('./schema-diagnostic-origins');
  const diagnosticOrigins = createSchemaDiagnosticOrigins();
  const bundledDiagnosticOrigins = createSchemaDiagnosticOrigins();
  const ajv = new Ajv({
    inlineRefs: false,
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    code: { process: diagnosticOrigins.process },
  });
  addFormats(ajv);
  // Bundled tool roots can intentionally share their canonical `$id` with
  // modular documents registered in `ajv`. Keep them in a separate registry
  // so getValidator compiles the file selected by fileIndex rather than
  // accidentally reusing a modular validator with the same public id.
  const bundledAjv = new Ajv({
    inlineRefs: false,
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    code: { process: bundledDiagnosticOrigins.process },
  });
  addFormats(bundledAjv);

  const state: LoaderState = {
    ajv,
    bundledAjv,
    diagnosticOrigins,
    bundledDiagnosticOrigins,
    canonicalValidators: new Map(),
    fileIndex: buildFileIndex(root),
    validators: new Map(),
    rawSchemas: new Map(),
    entityPaths: new Map(),
    root,
    coreLoaded: false,
    version: key,
  };
  states.set(cacheKey, state);
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
 * already inlined). Files that `buildFileIndex` registered as tools use the
 * selected tool document, not a modular document that happens to share its
 * canonical `$id`. Responses also receive `relaxResponseRoot`, matching
 * `getValidator`.
 * These checks are stricter than a filename-suffix match:
 * building-block fragments like `core/pagination-response.json` end in
 * `-response.json` but aren't tools, so suffix-matching would wrongly treat
 * them as relaxable response roots.
 */
function ensureCoreLoaded(s: LoaderState): void {
  if (s.coreLoaded) return;
  // Tool response files are pre-registered with the same response-root
  // relaxation `getValidator` would apply. This matters for the async response
  // union: `core/async-response-data.json` can `$ref` both async variants and
  // sync responses, so callers must not have to prewarm response validators
  // before compiling a request that references the union.
  //
  // Why this matters: bundles whose source tree doesn't include a `bundled/`
  // pre-resolved subtree (e.g. v2.5, where the spec ships flat schemas with
  // unresolved `$ref`s) classify fragments like `media-buy/package-request.json`
  // as tool `package::request` via the filename-suffix heuristic in
  // `buildFileIndex`. Skipping all tool files would leave that fragment
  // unregistered, so a later compile of `create_media_buy` fails on
  // `MissingRefError: can't resolve /schemas/media-buy/package-request.json`.
  //
  const selectedToolsById = new Map<string, { file: string; response: boolean }>();
  const responseToolFiles = new Set<string>();
  for (const [key, indexedFile] of s.fileIndex) {
    const file = authoredToolSchemaFile(s, indexedFile);
    const response = !key.endsWith('::request');
    if (response) responseToolFiles.add(file);
    const schema = loadJson(file);
    if (typeof schema.$id === 'string') {
      const previous = selectedToolsById.get(schema.$id);
      if (!previous || previous.file === file) selectedToolsById.set(schema.$id, { file, response });
    }
  }
  const registeredIds = getAjvRegisteredIds(s.ajv);
  for (const entry of readdirSync(s.root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isRuntimeSchemaDirectory(entry.name)) continue;
    const abs = path.join(s.root, entry.name);
    for (const file of walkJsonFiles(abs)) {
      const schema = loadJson(file);
      const selected = typeof schema.$id === 'string' ? selectedToolsById.get(schema.$id) : undefined;
      const selectedShadowsModular = selected !== undefined && selected.file !== file;
      const selectedSchema = selectedShadowsModular ? loadJson(selected.file) : schema;
      const prepared =
        selectedShadowsModular && selected.file.includes(`${path.sep}bundled${path.sep}`)
          ? stripNestedIds(selectedSchema)
          : selectedSchema;
      const isResponseTool = selected?.response ?? responseToolFiles.has(file);
      const schemaToRegister = isResponseTool ? relaxResponseRoot(prepared) : prepared;
      if (typeof schemaToRegister.$id === 'string' && !registeredIds.has(schemaToRegister.$id)) {
        s.ajv.addSchema(schemaToRegister);
        registeredIds.add(schemaToRegister.$id);
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

  const indexedFile = s.fileIndex.get(cacheKey);
  if (!indexedFile) return undefined;
  // Prefer a context-safe authored ref graph; retain paired bundled response
  // compositions when envelope relaxation cannot safely traverse shared refs.
  const file = runtimeToolSchemaFile(s, indexedFile, direction);

  // Flat-tree schemas `$ref` into separately published documents and need
  // those trees registered before compile. Bundled schemas contain only
  // root-local refs and compile independently.
  const fromBundled = file.includes(`${path.sep}bundled${path.sep}`);
  if (!fromBundled) ensureCoreLoaded(s);

  const rawSchema = loadJson(file);
  // Bundled files inline every referenced subschema with the original
  // canonical `$id` (e.g. `core/version-envelope.json` appears nested
  // inside every bundled tool response). Bundled files carry no external
  // `$ref`s — root-local `$defs` refs may remain — see
  // the `note: "This is a bundled schema with all $ref resolved inline"`
  // tag on every bundled file. Once `ensureCoreLoaded` has registered
  // any of those core schemas standalone (which it does for the flat-
  // tree governance / brand / property domains), Ajv's compile of a
  // bundled file trips the ambiguous-ref check on every nested $id.
  //
  // The fix: strip nested `$id` fields before compile on bundled
  // schemas. The root `$id` is kept (it's the validator's lookup key);
  // every other `$id` in the tree was just metadata anyway.
  const prepared = fromBundled ? stripNestedIds(rawSchema) : rawSchema;
  // Relax the authored composition before factoring can move a closed arm
  // behind a private ref. Canonical validators deliberately skip relaxation.
  const envelope = direction === 'request' ? prepared : relaxResponseRoot(prepared);
  const schema = fromBundled ? compactSchemaForValidation(envelope) : envelope;
  const ajv = fromBundled ? s.bundledAjv : s.ajv;
  const existing = typeof schema.$id === 'string' ? ajv.getSchema(schema.$id) : undefined;
  const compiled = existing ?? ajv.compile(schema);
  s.validators.set(cacheKey, compiled);
  validatorDiagnosticOrigins.set(compiled, fromBundled ? s.bundledDiagnosticOrigins : s.diagnosticOrigins);
  return compiled;
}

export interface ResolvedToolSchemaDocument {
  toolName: string;
  direction: Direction;
  requestedVersion: string;
  /** Loader key used to select the installed schema bundle. */
  bundleKey: string;
  /** Exact protocol release recorded by the resolved bundle, when available. */
  resolvedVersion: string;
  schema: Readonly<Record<string, unknown>>;
}

export interface ResolvedSchemaDocument {
  schemaRef: string;
  requestedVersion: string;
  /** Loader key used to select the installed schema bundle. */
  bundleKey: string;
  /** Exact protocol release recorded by the resolved bundle, when available. */
  resolvedVersion: string;
  schema: Readonly<Record<string, unknown>>;
}

function authoredToolSchemaFile(state: LoaderState, indexedFile: string): string {
  const bundledRoot = path.join(state.root, 'bundled');
  const relative = path.relative(bundledRoot, indexedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return indexedFile;

  const authoredFile = path.join(state.root, relative);
  return existsSync(authoredFile) ? authoredFile : indexedFile;
}

/** Keep composition-only response relaxation local to the selected tool. */
function runtimeToolSchemaFile(state: LoaderState, indexedFile: string, direction: Direction): string {
  const authoredFile = authoredToolSchemaFile(state, indexedFile);
  if (direction === 'request' || authoredFile === indexedFile) return authoredFile;
  const hasCompositionReference = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const schema = node as LoadedSchema;
    if (typeof schema.$ref === 'string') return true;
    return ['allOf', 'oneOf', 'anyOf'].some(
      keyword => Array.isArray(schema[keyword]) && (schema[keyword] as unknown[]).some(hasCompositionReference)
    );
  };
  // A modular response may alias a closed non-tool fragment. Relaxing that
  // shared fragment globally would also loosen nested request validation.
  // Its paired bundled tree provides a context-local composition to relax.
  return hasCompositionReference(loadJson(authoredFile)) ? indexedFile : authoredFile;
}

function compactSchemaForValidation(schema: LoadedSchema): LoadedSchema {
  // Cold client imports need no schema factoring code until a bundled-only
  // or context-sensitive response graph actually reaches compilation.
  const compactor = require('./compact-schema') as typeof import('./compact-schema');
  return compactor.compactSchemaForValidation(schema);
}

/**
 * Return an unmodified tool JSON Schema from the same version-aware bundle
 * resolver used by runtime validation. Unlike `getValidator().schema`, response
 * documents are not relaxed for extensible envelopes, so callers can publish
 * the protocol-authored schema verbatim from an on-demand discovery tool.
 */
export function getToolSchemaDocument(
  toolName: string,
  direction: Direction,
  version: string = ADCP_VERSION
): ResolvedToolSchemaDocument | undefined {
  const state = ensureInit(version);
  const file = state.fileIndex.get(`${toolName}::${direction}`);
  if (!file) return undefined;
  const schema = loadJson(file) as Record<string, unknown>;
  let resolvedVersion = state.version;
  try {
    const index = loadJson(path.join(state.root, 'index.json')) as Record<string, unknown>;
    if (typeof index.adcp_version === 'string') resolvedVersion = index.adcp_version;
  } catch {
    // Legacy/external bundles may omit index.json; the resolved key remains an
    // accurate identifier for the schema directory selected by the loader.
  }
  return {
    toolName,
    direction,
    requestedVersion: version,
    bundleKey: state.version,
    resolvedVersion,
    schema,
  };
}

/**
 * Return an unmodified JSON Schema fragment from the selected AdCP bundle.
 *
 * This is the document counterpart to {@link getSchemaValidatorByRef}. It is
 * intended for SDK features whose behavior must be derived from protocol
 * metadata rather than from a second, hand-maintained field list.
 */
export function getSchemaDocumentByRef(
  schemaRef: string,
  version: string = ADCP_VERSION
): ResolvedSchemaDocument | undefined {
  const state = ensureInit(version);
  const normalized = normalizeSchemaRef(schemaRef);
  if (!normalized) return undefined;
  const file = path.join(state.root, normalized);
  if (!existsSync(file)) return undefined;

  // Bundle documents are immutable for the lifetime of their loader state,
  // just like compiled validators. Freeze shared documents so domain audits
  // can memoize by identity without allowing callers to mutate a schema.
  const readDocument = (ref: string): Record<string, unknown> => {
    const key = `document::${ref}`;
    let schema = state.rawSchemas.get(key);
    if (!schema) {
      schema = loadJson(path.join(state.root, ref));
      const pending: unknown[] = [schema];
      while (pending.length > 0) {
        const value = pending.pop();
        if (value && typeof value === 'object') {
          for (const child of Object.values(value)) pending.push(child);
          Object.freeze(value);
        }
      }
      state.rawSchemas.set(key, schema);
    }
    return schema;
  };

  let resolvedVersion = state.version;
  try {
    const index = readDocument('index.json');
    if (typeof index.adcp_version === 'string') resolvedVersion = index.adcp_version;
  } catch {
    // Legacy/external bundles may omit index.json; the loader key remains an
    // accurate identifier for the selected schema directory.
  }

  return {
    schemaRef: normalized,
    requestedVersion: version,
    bundleKey: state.version,
    resolvedVersion,
    schema: readDocument(normalized),
  };
}

/**
 * Compile an arbitrary schema from the cached bundle by path, e.g.
 * `core/mcp-webhook-payload.json`. Used by storyboard webhook assertions
 * whose payload schema is not tied to a tool request/response pair.
 */
export function getSchemaValidatorByRef(
  schemaRef: string,
  version: string = ADCP_VERSION,
  keywords?: ReadonlyArray<KeywordDefinition>,
  options: { allErrors?: boolean } = {}
): ValidateFunction | undefined {
  return compileSchemaReference(schemaRef, version, keywords, options);
}

/** @internal Validate delivery envelope metadata separately from its versioned report. */
export function getMediaBuyDeliveryEnvelopeValidator(version: string): ValidateFunction | undefined {
  return compileSchemaReference(
    'core/mcp-webhook-payload.json',
    version,
    undefined,
    {},
    {
      key: 'media-buy-delivery-envelope',
      project: schema => ({
        ...schema,
        properties: {
          ...(schema.properties as Record<string, unknown>),
          // The 3.0 task-type enum predates this documented reporting task. All
          // releases use the same concrete discriminator on delivery envelopes.
          task_type: { const: 'media_buy_delivery' },
          // The caller validates this independently against the served report
          // schema, so result errors cannot masquerade as envelope errors.
          result: {},
        },
        required: [...new Set([...((schema.required as string[] | undefined) ?? []), 'task_type', 'result'])],
      }),
    }
  );
}

function compileSchemaReference(
  schemaRef: string,
  version: string,
  keywords: ReadonlyArray<KeywordDefinition> | undefined,
  options: { allErrors?: boolean },
  projection?: { key: string; project: (schema: LoadedSchema) => LoadedSchema }
): ValidateFunction | undefined {
  // Keep remote schema-ref validation out of the shared tool-validator AJV,
  // which intentionally collects all errors for developer diagnostics.
  const bundleKey = resolveBundleKey(version);
  const root = resolveSchemaRoot(version);
  const normalized = normalizeSchemaRef(schemaRef);
  if (!normalized) return undefined;

  // Keep domain-specific keyword validators isolated from ordinary schema-ref
  // validation. Callers retain an immutable keyword array for cache reuse.
  let cache = schemaRefValidators;
  if (keywords) {
    let entry = keywordSchemaRefValidators.get(keywords);
    if (!entry || entry.generation !== keywordCacheGeneration) {
      entry = { generation: keywordCacheGeneration, validators: new Map() };
      keywordSchemaRefValidators.set(keywords, entry);
    }
    cache = entry.validators;
  }
  const allErrors = options.allErrors ?? false;
  const cacheKey = `${stateCacheKey(bundleKey, root)}\0schema-ref::${normalized}\0all-errors::${allErrors}\0projection::${projection?.key ?? 'raw'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const file = path.join(root, normalized);
  if (!existsSync(file)) return undefined;

  // Use an isolated AJV instance for arbitrary schema refs. Tool response
  // validators deliberately relax some roots for SDK back-compat; webhook
  // payload schemas need strict raw JSON Schema behavior without polluting the
  // shared tool-validator registry with unrelaxed response schemas.
  const ajv = new Ajv({
    inlineRefs: false,
    strict: false,
    // Schema-ref validators process remote webhook payloads. By default they
    // fail on the first violation so deeply nested hostile input cannot
    // amplify error collection into CPU or memory exhaustion. Canonical
    // offline validators explicitly opt into complete developer diagnostics.
    allErrors,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  for (const keyword of keywords ?? []) ajv.addKeyword(keyword);
  const authoredSchema = identity33ReferenceSchema(loadJson(file), version);
  const rawSchema = projection ? projection.project(authoredSchema) : authoredSchema;
  const dependencySchemas: LoadedSchema[] = [];
  const registeredIds = new Map<string, LoadedSchema>();
  for (const schemaFile of walkJsonFiles(root)) {
    if (schemaFile.includes(`${path.sep}bundled${path.sep}`)) continue;
    if (
      [...TRANSPORT_PROJECTION_DIRECTORIES].some(directory => schemaFile.includes(`${path.sep}${directory}${path.sep}`))
    ) {
      continue;
    }
    if (schemaFile === file) continue;
    const schema = identity33ReferenceSchema(loadJson(schemaFile), version);
    if (typeof schema.$id === 'string') {
      // Compare mirrors against the authored root, before any caller-specific
      // envelope projection. Never register the same root id as a dependency.
      const previous = schema.$id === authoredSchema.$id ? authoredSchema : registeredIds.get(schema.$id);
      // Bundles intentionally mirror async-response refs. Identical copies
      // are harmless; conflicting definitions must not shadow audited files.
      if (previous && !isDeepStrictEqual(previous, schema)) {
        throw new ConfigurationError('Schema validation requires unambiguous schema identities', 'schemaRoot');
      }
      if (schema.$id === rawSchema.$id) continue;
    }
    if (typeof schema.$id === 'string' && !registeredIds.has(schema.$id)) {
      registeredIds.set(schema.$id, schema);
      dependencySchemas.push(schema);
    }
  }
  if (dependencySchemas.length > 0) {
    ajv.addSchema(dependencySchemas);
  }
  const compiled = ajv.compile(rawSchema);
  cache.set(cacheKey, compiled);
  return compiled;
}

/**
 * Compile a tool schema without the response-root relaxation used by the SDK's
 * live-wire validator. Kept in the loader so the public schema facade does not
 * need access to loader file-system state.
 */
export function getCanonicalToolValidatorForVersion(
  toolName: string,
  direction: Direction,
  version: string = ADCP_VERSION
): ValidateFunction | undefined {
  const state = ensureInit(version);
  const cacheKey = `${toolName}::${direction}`;
  const cached = state.canonicalValidators.get(cacheKey);
  if (cached) return cached;

  const indexedFile = state.fileIndex.get(cacheKey);
  if (!indexedFile) return undefined;
  const file = authoredToolSchemaFile(state, indexedFile);
  const rawSchema = loadJson(file);
  const ajv = ensureCanonicalAjv(state);
  const existing = typeof rawSchema.$id === 'string' ? ajv.getSchema(rawSchema.$id) : undefined;
  // External/legacy schema roots may contain only self-contained bundled
  // contracts. They have no authored graph to pre-register, so compile the
  // strict bundled fallback lazily after removing nested metadata `$id`s.
  const fromBundled = file.includes(`${path.sep}bundled${path.sep}`);
  const compiled =
    existing ?? ajv.compile(fromBundled ? compactSchemaForValidation(stripNestedIds(rawSchema)) : rawSchema);
  state.canonicalValidators.set(cacheKey, compiled);
  return compiled;
}

function ensureCanonicalAjv(state: LoaderState): Ajv {
  if (state.canonicalAjv) return state.canonicalAjv;

  const ajv = new Ajv({ inlineRefs: false, strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);

  const schemasById = new Map<string, LoadedSchema>();
  for (const schemaFile of walkJsonFiles(state.root)) {
    if (schemaFile.includes(`${path.sep}bundled${path.sep}`)) continue;
    if (
      [...TRANSPORT_PROJECTION_DIRECTORIES].some(directory => schemaFile.includes(`${path.sep}${directory}${path.sep}`))
    ) {
      continue;
    }

    const schema = loadJson(schemaFile);
    if (typeof schema.$id !== 'string') continue;
    const previous = schemasById.get(schema.$id);
    if (previous) {
      if (!isDeepStrictEqual(previous, schema)) {
        throw new ConfigurationError('Canonical validation requires unambiguous schema identities', 'schemaRoot');
      }
      continue;
    }
    schemasById.set(schema.$id, schema);
  }

  if (schemasById.size > 0) ajv.addSchema([...schemasById.values()]);
  state.canonicalAjv = ajv;
  return ajv;
}

function normalizeSchemaRef(schemaRef: string): string | undefined {
  const trimmed = schemaRef.replace(/^\/+/, '');
  if (trimmed.length === 0) return undefined;
  const normalized = path.normalize(trimmed);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return undefined;
  return normalized;
}

/**
 * Strip `$id` from every subschema of a bundled response file, preserving
 * the root `$id`. Bundled files are fully inlined (no internal `$ref`s),
 * so the nested `$id`s are vestigial metadata — Ajv only cares about the
 * root `$id` for validator lookup. Without this strip, Ajv's
 * `checkAmbiguousRef` throws when an inlined nested `$id` matches one
 * already registered standalone via `ensureCoreLoaded`.
 *
 * Returns a deep-copied tree; the input is not mutated.
 */
function stripNestedIds(schema: LoadedSchema): LoadedSchema {
  const root = JSON.parse(JSON.stringify(schema)) as LoadedSchema;
  const rootId = typeof root.$id === 'string' ? root.$id : undefined;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$id === 'string' && obj.$id !== rootId) {
      delete obj.$id;
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(root);
  return root;
}

/** List of (toolName, direction) pairs that have schemas. Used by tests. */
export function listValidatorKeys(version: string = ADCP_VERSION): string[] {
  const s = ensureInit(version);
  return [...s.fileIndex.keys()].sort();
}

/**
 * `$id`s of every schema currently registered with the AdCP validator's AJV
 * instance for `version`. Used by the schema-validator to extract the
 * rejecting sub-schema's `$id` from an Ajv error's `schemaPath`: when a
 * `$ref` is followed, Ajv prefixes the schemaPath with the target schema's
 * `$id`, so the longest registered `$id` that prefixes a schemaPath is the
 * sub-schema responsible for the failure.
 *
 * The set grows as `getValidator` calls trigger `ensureCoreLoaded` and
 * compile new tool roots — callers should read it AFTER the validate call
 * they're projecting errors from.
 */
export function getRegisteredSchemaIds(version: string = ADCP_VERSION): readonly string[] {
  const s = ensureInit(version);
  // Ajv 8 keeps registered schemas at `ajv.schemas` (URI → SchemaEnv). Returning
  // the keys is enough for prefix matching; we don't expose the SchemaEnv values.
  const registry = (s.ajv as unknown as { schemas?: Record<string, unknown> }).schemas;
  const bundledRegistry = (s.bundledAjv as unknown as { schemas?: Record<string, unknown> }).schemas;
  return [...new Set([...Object.keys(registry ?? {}), ...Object.keys(bundledRegistry ?? {})])];
}

/** Keep new invalidation reasons isolated to explicitly enabled draft references. */
function identity33ReferenceSchema(schema: LoadedSchema, version: string): LoadedSchema {
  if (!isIdentity33SchemaScope() || resolveBundleKey(version) !== '3.3') return schema;
  const clone = structuredClone(schema);
  const pending: unknown[] = [clone];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const object = node as Record<string, unknown>;
    if (Array.isArray(object.enum) && object.enum.includes('destination_state_changed'))
      object.enum = [...new Set([...object.enum, 'relationship_changed', 'relationship_expiring'])];
    for (const value of Object.values(object)) if (typeof value === 'object') pending.push(value);
  }
  return clone;
}

/** Suffix used in the suffix table — exported for testing. */
export { SCHEMA_FILENAME_SUFFIX };

/**
 * Returns true when the schema bundle for `version` is reachable from the
 * dist build or the source-tree fallback. Cheap synchronous check; safe
 * to call at construction time of clients/servers to fail fast on a pin
 * we don't have schemas for.
 */
export function hasSchemaBundle(version: string): boolean {
  try {
    resolveSchemaRoot(version);
    return true;
  } catch {
    return false;
  }
}

/**
 * A caller-supplied schema root for a release an agent may echo in a
 * `get_adcp_capabilities` response. `aliases` is the validated alias set
 * (computed once per process per `version`/`root` pair).
 */
interface ServedReleaseSchemaRoot {
  readonly version: string;
  readonly root: string;
  readonly aliases: ReadonlySet<string>;
}

const servedReleaseSchemaRootScope = new AsyncLocalStorage<readonly ServedReleaseSchemaRoot[]>();
/**
 * Validated alias sets for served-release roots, keyed by `version\0root`.
 * Checking a root walks every schema file in it (about a second for a full
 * release), so a hosted caller that passes the same roots on every run pays
 * that once per process. Roots are treated as immutable artifacts, and
 * neither this memo nor the compiled validators for a root are evicted, so
 * pass stable root paths rather than a fresh extraction per run.
 */
const servedReleaseRootAliases = new Map<string, ReadonlySet<string>>();

/**
 * Run `fn` with schema roots for the releases an agent may echo in its
 * `get_adcp_capabilities` response.
 *
 * Keys are AdCP versions in any form the SDK accepts for a pin (`'3.2'`,
 * `'3.2.5'`, `'3.3.0-beta.1'`); values are schema-data roots in the same
 * shape as `schemaRoot` (a directory holding `bundled/`, e.g. a hosted
 * `dist/schemas/3.2.5`). Each root is checked against its key the same way
 * `withExternalSchemaRoot` checks one, and a malformed map throws before `fn`
 * runs.
 *
 * The roots are consulted only when validating a `get_adcp_capabilities`
 * response against the release the agent echoed (see
 * {@link resolveServedValidationVersion}): discovery's capability notices,
 * `getAdcpCapabilities()` response validation and storyboard
 * `response_schema` checks on that task. They are not activated for any other
 * task, so every other response, storyboard selection and grading stay on the
 * pin. A supplied root takes precedence over an external root registered for
 * the same release and over the SDK's bundled schemas for it.
 *
 * Scoped to the current async execution chain; nested calls add to the
 * enclosing scope, with the innermost entry for a release winning.
 * `comply()` and `runStoryboard()` accept the same map as
 * `servedReleaseSchemaRoots` and call this for you.
 */
export function withServedReleaseSchemaRoots<T>(roots: Readonly<Record<string, string>> | undefined, fn: () => T): T {
  if (roots === undefined) return fn();
  if (roots === null || typeof roots !== 'object' || Array.isArray(roots)) {
    throw new TypeError('servedReleaseSchemaRoots must be an object mapping AdCP versions to schema roots');
  }
  const entries: ServedReleaseSchemaRoot[] = [];
  for (const [version, root] of Object.entries(roots)) {
    resolveBundleKey(version);
    if (typeof root !== 'string' || root.length === 0) {
      throw new TypeError(`servedReleaseSchemaRoots["${version}"] must be a non-empty schema root path`);
    }
    const memoKey = `${version}\0${root}`;
    let aliases = servedReleaseRootAliases.get(memoKey);
    if (!aliases) {
      if (!hasSchemaRootShape(root)) {
        throw new Error(`Served-release AdCP schema root for version "${version}" not found or empty at ${root}`);
      }
      aliases = assertSchemaRootMatchesVersion(version, root);
      servedReleaseRootAliases.set(memoKey, aliases);
    }
    const conflict = entries.find(entry => entry.root !== root && [...aliases].some(alias => entry.aliases.has(alias)));
    if (conflict) {
      throw new Error(
        `servedReleaseSchemaRoots["${version}"] and servedReleaseSchemaRoots["${conflict.version}"] name the same ` +
          `release with different schema roots (${root}, ${conflict.root})`
      );
    }
    entries.push({ version, root, aliases });
  }
  if (entries.length === 0) return fn();
  const parent = servedReleaseSchemaRootScope.getStore() ?? [];
  return servedReleaseSchemaRootScope.run([...entries, ...parent], fn);
}

function findServedReleaseSchemaRoot(release: string): ServedReleaseSchemaRoot | undefined {
  const entries = servedReleaseSchemaRootScope.getStore();
  if (!entries?.length) return undefined;
  let key: string;
  try {
    key = resolveBundleKey(release);
  } catch {
    return undefined;
  }
  return entries.find(entry => entry.aliases.has(key) || entry.aliases.has(release));
}

/** Major of an echoed release-precision `adcp_version` (`core/version-envelope.json` wire pattern). */
const SERVED_RELEASE_MAJOR = /^(\d+)\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
/** Major of a numeric pin: `'3.0'`, `'3.0.25'`, `'3.1-beta'`, `'3.1.0-beta.1'`. */
const NUMERIC_PIN_MAJOR = /^(\d+)\.\d+/;

/** Whether the response's own `adcp.supported_versions` lists `release`. */
function listsSupportedRelease(response: object, release: string): boolean {
  const adcp = (response as { adcp?: unknown }).adcp;
  if (adcp === null || typeof adcp !== 'object') return false;
  const supported = (adcp as { supported_versions?: unknown }).supported_versions;
  if (!Array.isArray(supported)) return false;
  return supported.some(entry => {
    if (typeof entry !== 'string') return false;
    if (entry === release) return true;
    try {
      return toReleasePrecisionWire(entry) === release;
    } catch {
      return false;
    }
  });
}

interface ServedValidationSelection {
  /** Version to validate against: the echoed release, or the pin. */
  version: string;
  /** Caller-supplied root for the echoed release, when one applies. */
  served?: ServedReleaseSchemaRoot;
}

function selectServedValidationVersion(response: unknown, pinnedVersion: string): ServedValidationSelection {
  const pin: ServedValidationSelection = { version: pinnedVersion };
  const pinMajor = NUMERIC_PIN_MAJOR.exec(pinnedVersion)?.[1];
  // Legacy aliases ('v2.5', 'v3') have their own adapter paths; leave them alone.
  if (pinMajor === undefined) return pin;
  if (response === null || typeof response !== 'object') return pin;

  const echoed = (response as { adcp_version?: unknown }).adcp_version;
  if (typeof echoed !== 'string') return pin;
  const echoMajor = SERVED_RELEASE_MAJOR.exec(echoed)?.[1];
  if (echoMajor === undefined || echoMajor !== pinMajor) return pin;

  let pinnedRelease: string;
  try {
    pinnedRelease = toReleasePrecisionWire(pinnedVersion);
  } catch {
    return pin;
  }
  // The pinned release itself: keep the exact pin so a patch-precise pin and
  // any external root bound to it still apply.
  if (echoed === pinnedRelease) return pin;
  // An agent may only serve a release it advertises.
  if (!listsSupportedRelease(response, echoed)) return pin;

  const served = findServedReleaseSchemaRoot(echoed);
  if (served) return { version: echoed, served };
  // Covers an external root registered (or scoped) for the echo and the
  // SDK's bundled schemas.
  return hasSchemaBundle(echoed) ? { version: echoed } : pin;
}

/**
 * Select the AdCP release a `get_adcp_capabilities` response is validated
 * against.
 *
 * The versioning spec (`docs/reference/versioning.mdx`, "Server echoes") says
 * the seller echoes the release it actually served in `adcp_version`, and
 * buyers SHOULD validate against that release's schema, not their pin; with
 * no echo, against the pin. This matters most under a 3.0 pin: the 3.0
 * bundle has no `adcp_version` request field, so the SDK sends only
 * `adcp_major_version: 3` and the seller serves (and echoes) its highest 3.x
 * release.
 *
 * Returns the echoed `adcp_version` when all of these hold, otherwise
 * `pinnedVersion`:
 * - it is a release-precision string in the same major as the pin;
 * - the response's own `adcp.supported_versions` lists it;
 * - a schema root for it is available: one supplied through
 *   {@link withServedReleaseSchemaRoots} (`servedReleaseSchemaRoots` on
 *   `comply()` / `runStoryboard()`), an external root registered or scoped
 *   for it, or the SDK's bundled schemas.
 *
 * This holds whether or not an external schema root is active for the pin.
 * Hosted compliance always runs with one, and the capabilities response is
 * negotiated before any pin applies, so the pin's root must not override the
 * release the agent actually served.
 *
 * Validation stays strict either way: an echo from another major, a malformed
 * or unlisted echo, or one with no schema available falls back to the pin
 * rather than skipping validation. When the echo names the pinned release
 * itself, the exact pin is returned so a patch-precise pin (and any external
 * schema root bound to it) still applies. An echo older than the pin (pin
 * 3.2, served 3.0) is validated against the older release; that is the spec's
 * downshift rule, not a loosening bug.
 *
 * Callers apply this to `get_adcp_capabilities` only. Use
 * {@link withServedValidationVersion} to also activate a supplied root.
 *
 * @internal — not part of the public API surface; may change without a major bump.
 */
export function resolveServedValidationVersion(response: unknown, pinnedVersion: string): string {
  try {
    return selectServedValidationVersion(response, pinnedVersion).version;
  } catch {
    return pinnedVersion;
  }
}

/**
 * Run `fn` with the release {@link resolveServedValidationVersion} selects.
 * When that release has a root supplied through
 * {@link withServedReleaseSchemaRoots}, the root is active for the duration
 * of `fn` only, so it never leaks into validation of any other response.
 *
 * @internal — not part of the public API surface; may change without a major bump.
 */
export function withServedValidationVersion<T>(
  response: unknown,
  pinnedVersion: string,
  fn: (version: string) => T
): T {
  let selection: ServedValidationSelection;
  try {
    selection = selectServedValidationVersion(response, pinnedVersion);
  } catch {
    selection = { version: pinnedVersion };
  }
  const { version, served } = selection;
  if (!served) return fn(version);
  const next = new Map(scopedExternalSchemaRoots.getStore());
  for (const alias of served.aliases) next.set(alias, served.root);
  return scopedExternalSchemaRoots.run(next, () => fn(version));
}

const mcpToolSchemaCache = new Map<string, Readonly<Record<string, unknown>> | null>();
const mcpToolSummaryCache = new Map<string, string | null>();

function boundedMcpToolSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const summary = value.trim();
  if (!summary) return undefined;

  const words = summary.split(/\s+/);
  return words.length < 100 ? summary : `${words.slice(0, 99).join(' ')}…`;
}

/** Load an exact self-contained tool projection from an MCP manifest. @internal */
export function getMcpToolSchema(
  toolName: string,
  direction: 'input' | 'output',
  options: { profile?: string; protocolVersion?: string } = {},
  version: string = ADCP_VERSION
): Readonly<Record<string, unknown>> | undefined {
  const root = resolveSchemaRoot(version);
  const profile = options.profile ?? 'all';
  const cacheKey = `${root}\u001f${options.protocolVersion ?? 'latest'}\u001f${profile}\u001f${direction}\u001f${toolName}`;
  const cached = mcpToolSchemaCache.get(cacheKey);
  if (cached !== undefined) return cached ?? undefined;

  const mcpRoot = path.join(root, 'mcp');
  if (!existsSync(mcpRoot)) {
    mcpToolSchemaCache.set(cacheKey, null);
    return undefined;
  }
  const protocolVersions = options.protocolVersion
    ? [options.protocolVersion]
    : readdirSync(mcpRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
        .reverse();
  for (const protocolVersion of protocolVersions) {
    const manifestRoot =
      profile === 'all'
        ? path.resolve(mcpRoot, protocolVersion)
        : path.resolve(mcpRoot, protocolVersion, 'profiles', profile);
    if (!manifestRoot.startsWith(`${mcpRoot}${path.sep}`)) continue;
    const manifestFile = path.join(manifestRoot, 'manifest.json');
    if (!existsSync(manifestFile)) continue;
    const manifest = loadJson(manifestFile) as {
      tools?: Record<string, { inputSchema?: unknown; outputSchema?: unknown }>;
    };
    const schemaRef = manifest.tools?.[toolName]?.[direction === 'input' ? 'inputSchema' : 'outputSchema'];
    if (typeof schemaRef !== 'string') continue;
    const schemaFile = path.resolve(manifestRoot, schemaRef);
    if (!schemaFile.startsWith(`${manifestRoot}${path.sep}`) || !existsSync(schemaFile)) continue;
    const schema = Object.freeze(loadJson(schemaFile));
    mcpToolSchemaCache.set(cacheKey, schema);
    return schema;
  }
  mcpToolSchemaCache.set(cacheKey, null);
  return undefined;
}

/** Load the concise tool summary published by an exact MCP manifest. @internal */
export function getMcpToolSummary(
  toolName: string,
  options: { profile?: string; protocolVersion?: string } = {},
  version: string = ADCP_VERSION
): string | undefined {
  const root = resolveSchemaRoot(version);
  const profile = options.profile ?? 'all';
  const cacheKey = `${root}\u001f${options.protocolVersion ?? 'latest'}\u001f${profile}\u001f${toolName}`;
  const cached = mcpToolSummaryCache.get(cacheKey);
  if (cached !== undefined) return cached ?? undefined;

  const mcpRoot = path.join(root, 'mcp');
  if (!existsSync(mcpRoot)) {
    mcpToolSummaryCache.set(cacheKey, null);
    return undefined;
  }
  const protocolVersions = options.protocolVersion
    ? [options.protocolVersion]
    : readdirSync(mcpRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
        .reverse();
  for (const protocolVersion of protocolVersions) {
    const manifestRoot =
      profile === 'all'
        ? path.resolve(mcpRoot, protocolVersion)
        : path.resolve(mcpRoot, protocolVersion, 'profiles', profile);
    if (!manifestRoot.startsWith(`${mcpRoot}${path.sep}`)) continue;
    const manifestFile = path.join(manifestRoot, 'manifest.json');
    if (!existsSync(manifestFile)) continue;
    const manifest = loadJson(manifestFile) as {
      tools?: Record<string, { summary?: unknown }>;
    };
    const summary = boundedMcpToolSummary(manifest.tools?.[toolName]?.summary);
    if (summary === undefined) continue;
    mcpToolSummaryCache.set(cacheKey, summary);
    return summary;
  }
  mcpToolSummaryCache.set(cacheKey, null);
  return undefined;
}

/** Load the exact self-contained request projection from an MCP role profile. */
export function getMcpProfileInputSchema(
  toolName: string,
  profile: string,
  version: string = ADCP_VERSION
): Readonly<Record<string, unknown>> | undefined {
  return getMcpToolSchema(toolName, 'input', { profile }, version);
}

/**
 * Test hook: reset cached state. With no argument, clears every version's
 * loader state; with a version, clears only the bundle that version
 * resolves to (so passing `'3.0.0'` and `'3.0.1'` both clear the `'3.0'`
 * bundle).
 */
export function _resetValidationLoader(version?: string): void {
  mcpToolSchemaCache.clear();
  mcpToolSummaryCache.clear();
  if (version === undefined) {
    states.clear();
    schemaRefValidators.clear();
    keywordCacheGeneration++;
  } else {
    clearStatesForBundle(resolveBundleKey(version));
  }
}

/**
 * Returns true when `field` is **explicitly declared** as a top-level property
 * in the request schema for `toolName`, or when no schema is available
 * (fail-open). Used by the storyboard runner to decide whether to inject
 * envelope fields that aren't universally present across tools (e.g. `brand`,
 * `account`, `ext`).
 *
 * Reads the raw JSON schema file without compiling — avoids coupling to AJV
 * internals. Only inspects the top-level `properties` map; nested sub-schemas
 * are not traversed. Results are memoized in `LoaderState.rawSchemas` so
 * multi-step storyboard runs don't re-read the same file on each step.
 *
 * **Semantic note**: AdCP 3.1.0-beta.3 set `additionalProperties: true` on
 * mutating request schemas (vendor-extension friendly). Before that flip, the
 * helper used `additionalProperties: false` as the gate — "if the schema is
 * strict, only `properties` keys are allowed." Now requests are universally
 * permissive at the schema level, so that gate would say `true` for any field
 * on any request — defeating the storyboard runner's intent ("only inject
 * envelope fields the tool's schema declares it expects to see"). The helper
 * now checks `field in properties` directly: the question we actually care
 * about is **"does the schema declare this field at top level?"**, not
 * "does the schema permit this field at top level?" (it permits everything).
 *
 * Fails open (returns `true`) when:
 * - No schema file is indexed for the tool (custom tool, schema not synced)
 * - The schema root is not reachable (schemas not built/synced yet)
 * - Any I/O / parse error during the read
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
    const props = schema.properties as Record<string, unknown> | undefined;
    return props !== undefined && field in props;
  } catch {
    return true;
  }
}

export interface SchemaEntityPath {
  /** Property path from the tool request root. `*` addresses every array item. */
  path: string[];
  /** AdCP `x-entity` annotation found on the identity-bearing leaf. */
  xEntity: string;
}

/**
 * Return every request field carrying an `x-entity` annotation. Unlike the
 * server hydration map this walks nested arrays/objects, because storyboard
 * fixture handles commonly live at `packages[*].product_id` and
 * `packages[*].pricing_option_id`.
 *
 * Missing schemas fail closed with an empty list: handle substitution must
 * never guess from a field name alone.
 */
export function getRequestSchemaEntityPaths(
  toolName: string,
  version: string = ADCP_VERSION
): readonly SchemaEntityPath[] {
  try {
    const s = ensureInit(version);
    const cacheKey = `${toolName}::request`;
    const cached = s.entityPaths.get(cacheKey);
    if (cached) return cached;
    const file = s.fileIndex.get(cacheKey);
    if (!file) return [];

    const root = loadJson(file) as Record<string, unknown>;
    const found = new Map<string, SchemaEntityPath>();
    const stack = new Set<string>();

    const resolvePointer = (document: unknown, fragment: string): unknown => {
      if (!fragment || fragment === '#') return document;
      if (!fragment.startsWith('#/')) return undefined;
      let current = document;
      for (const encoded of fragment.slice(2).split('/')) {
        if (!current || typeof current !== 'object') return undefined;
        const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
        current = (current as Record<string, unknown>)[key];
      }
      return current;
    };

    const resolveRef = (
      ref: string,
      currentFile: string,
      currentDocument: Record<string, unknown>
    ): { node: unknown; file: string; document: Record<string, unknown>; key: string } | undefined => {
      const hash = ref.indexOf('#');
      const refPath = hash >= 0 ? ref.slice(0, hash) : ref;
      const fragment = hash >= 0 ? ref.slice(hash) : '';
      if (!refPath) {
        return {
          node: resolvePointer(currentDocument, fragment),
          file: currentFile,
          document: currentDocument,
          key: `${currentFile}${fragment}`,
        };
      }

      const schemaRelative = refPath.match(/\/schemas\/[^/]+\/(.+)$/)?.[1];
      const candidates = [
        schemaRelative ? path.join(s.root, schemaRelative) : undefined,
        path.resolve(path.dirname(currentFile), refPath),
      ].filter((candidate): candidate is string => candidate !== undefined);
      let targetFile = candidates.find(candidate => existsSync(candidate));
      // Standard AdCP refs encode their schema-root-relative file path, so
      // they resolve without parsing every JSON file in the bundle. Build the
      // expensive $id index only for an unusual ref that cannot be resolved
      // by path.
      if (!targetFile) {
        if (!s.schemaIdFiles) {
          const idToFile = new Map<string, string>();
          for (const schemaFile of walkJsonFiles(s.root)) {
            try {
              const schema = loadJson(schemaFile);
              if (typeof schema.$id === 'string') idToFile.set(schema.$id, schemaFile);
            } catch {
              // A malformed unrelated schema is not a usable ref target.
            }
          }
          s.schemaIdFiles = idToFile;
        }
        targetFile = s.schemaIdFiles.get(refPath);
      }
      if (!targetFile) return undefined;
      const document = loadJson(targetFile) as Record<string, unknown>;
      return {
        node: resolvePointer(document, fragment),
        file: targetFile,
        document,
        key: `${targetFile}${fragment}`,
      };
    };

    const walk = (
      node: unknown,
      propertyPath: string[],
      currentFile: string,
      currentDocument: Record<string, unknown>,
      depth: number
    ): void => {
      if (!node || typeof node !== 'object' || depth > 48) return;
      const obj = node as Record<string, unknown>;
      if (typeof obj['x-entity'] === 'string' && propertyPath.length > 0) {
        const entityPath = { path: [...propertyPath], xEntity: obj['x-entity'] as string };
        found.set(`${entityPath.path.join('.')}\0${entityPath.xEntity}`, entityPath);
      }

      if (typeof obj.$ref === 'string') {
        const target = resolveRef(obj.$ref, currentFile, currentDocument);
        if (target && target.node !== undefined) {
          const guard = `${target.key}\0${propertyPath.join('.')}`;
          if (!stack.has(guard)) {
            stack.add(guard);
            walk(target.node, propertyPath, target.file, target.document, depth + 1);
            stack.delete(guard);
          }
        }
      }

      const properties = obj.properties;
      if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
          walk(child, [...propertyPath, key], currentFile, currentDocument, depth + 1);
        }
      }
      if (obj.items !== undefined) {
        walk(obj.items, [...propertyPath, '*'], currentFile, currentDocument, depth + 1);
      }
      for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
        const branches = obj[keyword];
        if (Array.isArray(branches)) {
          for (const branch of branches) walk(branch, propertyPath, currentFile, currentDocument, depth + 1);
        }
      }
      for (const keyword of ['if', 'then', 'else', 'not'] as const) {
        if (obj[keyword] !== undefined) {
          walk(obj[keyword], propertyPath, currentFile, currentDocument, depth + 1);
        }
      }
    };

    walk(root, [], file, root, 0);
    const result = [...found.values()].sort((a, b) => {
      const byPath = a.path.join('.').localeCompare(b.path.join('.'));
      return byPath || a.xEntity.localeCompare(b.xEntity);
    });
    s.entityPaths.set(cacheKey, result);
    return result;
  } catch {
    return [];
  }
}

/**
 * Resolve a JSON Schema `default` value by walking a dot-separated property
 * path through a schema's nested `properties` maps.
 *
 * This intentionally does not instantiate AJV's `useDefaults` mutation mode.
 * Callers decide when a schema default is semantically meaningful for their
 * runtime object; this helper only reports what the bundled schema declares.
 *
 * Fails closed (`undefined`) when the schema is unavailable, the path is not a
 * concrete properties path, or the target schema node has no `default`.
 *
 * @internal — not part of the public API surface; may change without a major bump.
 */
export function getSchemaDefaultByPath(schemaRef: string, dottedPath: string, version: string = ADCP_VERSION): unknown {
  try {
    const s = ensureInit(version);
    const normalized = normalizeSchemaRef(schemaRef);
    if (!normalized) return undefined;

    const cacheKey = `schema-ref::${normalized}`;
    const file = path.join(s.root, normalized);
    if (!existsSync(file)) return undefined;

    let schema = s.rawSchemas.get(cacheKey);
    if (!schema) {
      schema = loadJson(file) as Record<string, unknown>;
      s.rawSchemas.set(cacheKey, schema);
    }

    const node = resolveSchemaPropertyPath(schema, dottedPath);
    if (!node || !Object.prototype.hasOwnProperty.call(node, 'default')) return undefined;
    return cloneJsonValue((node as { default: unknown }).default);
  } catch {
    return undefined;
  }
}

function resolveSchemaPropertyPath(
  schema: Record<string, unknown>,
  dottedPath: string
): Record<string, unknown> | undefined {
  let current: unknown = schema;
  for (const key of dottedPath.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    const props = (current as Record<string, unknown>).properties;
    if (!props || typeof props !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(props, key)) return undefined;
    current = (props as Record<string, unknown>)[key];
  }
  return current && typeof current === 'object' ? (current as Record<string, unknown>) : undefined;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
