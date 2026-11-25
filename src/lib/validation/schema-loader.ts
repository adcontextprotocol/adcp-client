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
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ADCP_VERSION, LIBRARY_VERSION } from '../version';
import { ConfigurationError } from '../errors';
import { bindEnvelopeSchemaLoader } from '../utils/envelope-status-compat';
import {
  clearBundledSchemaStoreCache,
  expandBundledSchemaDocument,
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
  /** The root's parsed documents, shared with its schema-ref validators (see {@link documentStore}). */
  documents: DocumentStore;
  entityPaths: Map<string, SchemaEntityPath[]>;
  schemaIdFiles?: Map<string, string>;
  root: string;
  coreLoaded: boolean;
  /** Set when registering the core documents threw; see {@link ensureCoreLoaded}. */
  coreLoadFailed?: boolean;
  version: string;
  /** Present only when ADCP_VALIDATOR_CACHE_DIR enabled the bundled-validator cache for this state. */
  bundledCache?: BundledValidatorCacheState;
  /** Request validators {@link definesToolRequest} found recorded as compiling, by `tool::request`. */
  cachedCompiles?: Set<string>;
  /**
   * The same validators, in call order, until they are compiled before the
   * state's diagnostics are read (see {@link flushDeferredCompiles}).
   */
  deferredCompiles?: Set<string>;
  /** {@link stateContentDigest}: the digest, or `null` when the state cannot use the cache. */
  contentDigest?: string | null;
  /** Whether {@link contentUnchangedSinceDigest} has checked the digest. */
  contentDigestChecked?: boolean;
  /** With the cache enabled: sources of the functions `ajv` compiled (see {@link CompiledSources}). */
  modularSources?: CompiledSources;
  /** With the cache enabled: the modular validator this state returned for each root $id. */
  modularById?: Map<string, ValidateFunction>;
  /** With the cache enabled: sources of the functions `canonicalAjv` compiled. */
  canonicalSources?: CompiledSources;
  /** With the cache enabled: the canonical validator this state returned for each root $id. */
  canonicalById?: Map<string, ValidateFunction>;
  /** With the cache enabled: the modular registry's functions in the cache. */
  modularFunctions?: CachedFunctions;
  /** With the cache enabled: the canonical registry's functions in the cache. */
  canonicalFunctions?: CachedFunctions;
  /** {@link registrationInputsDigest}, once computed. */
  registrationInputs?: string;
  /** The documents canonical registration registers, by $id, once its scan has succeeded. */
  canonicalDocuments?: Map<string, LoadedSchema>;
}

/** Ajv's standalone source of one compiled function (its `source` with `code.source` on). */
interface AjvFunctionSource {
  validateName?: unknown;
  validateCode: string;
  evaluated?: unknown;
  scopeValues?: Record<string, Iterable<{ prefix?: string; value?: { ref?: unknown } }>>;
}

/**
 * Standalone sources of the functions an Ajv instance compiled, held off the
 * functions (stock validators carry no `source`), so the cache can store a
 * function whichever validator's compile produced it.
 */
interface CompiledSources {
  /** code.process input and output per compiled schema environment, until drained. */
  pending: Array<{ env: { validate?: SourcedValidateFunction }; source: string; output: string }>;
  /** Each drained function's source, its body as code.process returned it. */
  byFunction: WeakMap<object, AjvFunctionSource>;
  /**
   * The registry entries each schema environment looked up while it was
   * compiled (see {@link recordRegistryLookups}); absent when they cannot be
   * observed, and then nothing is stored.
   */
  lookups?: WeakMap<object, Set<object>>;
}

/**
 * Record, for each schema environment Ajv compiles, the registered schema
 * environments it looks up while resolving its references. Ajv compiles each
 * one it finds (a document's root when the reference points into it, every
 * document a chain of `$ref`-only definitions passes through), and those
 * compiles register diagnostic origins, so a cached validator must bring
 * them along. Lookups are attributed to the innermost environment being
 * compiled, so the record depends on the schemas, not on compile order.
 */
function recordRegistryLookups(ajv: Ajv, sources: CompiledSources): void {
  const internals = ajv as unknown as {
    schemas: Record<string, unknown>;
    refs: Record<string, unknown>;
    _compilations?: unknown;
  };
  const compiling = internals._compilations;
  if (!(compiling instanceof Set)) return;
  const lookups = new WeakMap<object, Set<object>>();
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key === 'string' && value && typeof value === 'object' && compiling.size > 0) {
        let current: object | undefined;
        for (const env of compiling as Set<object>) current = env;
        let found = lookups.get(current!);
        if (!found) lookups.set(current!, (found = new Set()));
        found.add(value);
      }
      return value;
    },
  };
  internals.schemas = new Proxy(internals.schemas, handler);
  internals.refs = new Proxy(internals.refs, handler);
  sources.lookups = lookups;
}

/** A code.process hook that applies `process` (if any) and records input and output in `sources`. */
function recordingCodeProcess(
  sources: CompiledSources,
  process?: SchemaDiagnosticOrigins['process']
): (source: string, environment?: unknown) => string {
  return (source, environment) => {
    const output = process ? process(source, environment as Parameters<SchemaDiagnosticOrigins['process']>[1]) : source;
    sources.pending.push({ env: environment as CompiledSources['pending'][number]['env'], source, output });
    return output;
  };
}

/**
 * Move the `source` Ajv attached to each function compiled since the last
 * drain into `sources`, with the processed body. A function whose processed
 * code is not the plain source with rewritten literals is not kept, so no
 * module containing it is stored.
 */
function drainCompiledSources(sources: CompiledSources): void {
  const pending = sources.pending;
  sources.pending = [];
  for (const entry of pending) {
    const fn = entry.env?.validate as (SourcedValidateFunction & { source?: AjvFunctionSource }) | undefined;
    if (!fn) continue;
    const src = fn.source;
    delete fn.source;
    if (!src || typeof src.validateCode !== 'string' || !entry.source.endsWith(src.validateCode)) continue;
    // Ajv emits `<scope refs>return <validateCode>`; code.process rewrites
    // only schemaPath literals inside the function body.
    const prefixLength = entry.source.length - src.validateCode.length;
    if (
      !entry.source.slice(0, prefixLength).endsWith('return ') ||
      entry.output.slice(0, prefixLength) !== entry.source.slice(0, prefixLength)
    ) {
      continue;
    }
    src.validateCode = entry.output.slice(prefixLength);
    sources.byFunction.set(fn, src);
  }
}

/**
 * The functions `root`'s code reaches, as Ajv's standalone code generation
 * walks them, or `undefined` when one has no source.
 */
function compiledClosure(
  root: ValidateFunction,
  sourceOf: (fn: object) => AjvFunctionSource | undefined
): ValidateFunction[] | undefined {
  const closure: ValidateFunction[] = [];
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const fn = pending.pop();
    if (typeof fn !== 'function' || seen.has(fn)) continue;
    seen.add(fn);
    const src = sourceOf(fn);
    if (!src) return undefined;
    closure.push(fn as ValidateFunction);
    for (const names of Object.values(src.scopeValues ?? {})) {
      for (const name of names) {
        const ref = name.value?.ref;
        if (name.prefix === 'validate') pending.push(ref);
        else if ((name.prefix === 'root' || name.prefix === 'wrapper') && ref && typeof ref === 'object') {
          pending.push((ref as { validate?: unknown }).validate);
        }
      }
    }
  }
  return closure;
}

/**
 * A registry's compiled functions in the cross-process cache, one entry per
 * function, so a function many validators share is stored and loaded once, as
 * the registry compiles it once. An entry is the function's code as a factory
 * that takes what the code refers to (the functions it calls, Ajv's recursion
 * wrappers, its own schema object) in order; its metadata says where each
 * comes from, which registered documents' roots Ajv also compiles when it
 * resolves the function's references, and the diagnostic origin the function
 * registered.
 */
interface CachedFunctions {
  cache: import('./validator-cache').ValidatorCache;
  /** Key parts before the function id. */
  keyParts: readonly unknown[];
  /** The functions loaded in this state, by id. */
  loaded: Map<string, ValidateFunction>;
  /** Ids this state found or wrote in the cache. */
  stored: Set<string>;
}

/** A factory slot: `['f', id]` that function, `['h', id]` an object whose `validate` is it, `['s']` the function's schema. */
type StoredRef = ['f', string] | ['h', string] | ['s'];

interface StoredFunctionMeta {
  refs: StoredRef[];
  /**
   * Ids of functions Ajv compiles beside this one: the roots of the documents
   * it lives in and what it looked up while resolving its references.
   */
  also: string[];
  origin?: StoredOrigin;
}

/**
 * The id of a compiled function: the registry key of its root document, where
 * its schema sits (a pointer inside the root, or another registered document
 * as a whole) and its base URI, with the registry keys of those documents.
 * `undefined` for a function this scheme cannot name.
 */
function functionLocation(
  ajv: Ajv,
  env: { schema?: unknown; root?: { schema?: unknown }; baseId?: unknown } | undefined
): { id: string; documents: string[] } | undefined {
  const root = env?.root?.schema;
  const schema = env?.schema;
  if (!root || typeof root !== 'object' || !schema || typeof schema !== 'object') return undefined;
  if (typeof env?.baseId !== 'string') return undefined;
  const rootKey = registryKeyOf(ajv, root);
  if (rootKey === undefined) return undefined;
  const { schemaPointerIn } = require('./schema-diagnostic-origins') as typeof import('./schema-diagnostic-origins');
  const pointer = schemaPointerIn(root, schema);
  if (pointer !== undefined) return { id: JSON.stringify([rootKey, pointer, env.baseId]), documents: [rootKey] };
  // A whole document referenced from another root. Its base URI must not
  // depend on that root, so every function at its origin prefix agrees.
  const documentKey = registryKeyOf(ajv, schema);
  if (documentKey === undefined || registeredSchemaEnv(ajv, documentKey)?.baseId !== env.baseId) return undefined;
  return { id: JSON.stringify([rootKey, `doc:${documentKey}`, env.baseId]), documents: [rootKey, documentKey] };
}

/** The id {@link functionLocation} gives the function of a registered document's own environment. */
function documentRootFunctionId(key: string, baseId: string): string {
  return JSON.stringify([key, '#', baseId]);
}

/** The schema object at a function id's location, through `documentFor` (registry key -> document). */
function schemaAtFunctionLocation(id: string, documentFor: (key: string) => object | undefined): object | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return undefined;
  const [rootKey, location] = parsed as [string, string];
  if (location.startsWith('doc:')) return documentFor(location.slice('doc:'.length));
  const { schemaAtOriginPointer } =
    require('./schema-diagnostic-origins') as typeof import('./schema-diagnostic-origins');
  return schemaAtOriginPointer(documentFor(rootKey), location);
}

function cachedFunctionKey(cf: CachedFunctions, id: string): string {
  const { validatorCacheKey } = require('./validator-cache') as typeof import('./validator-cache');
  return validatorCacheKey([...cf.keyParts, id]);
}

/**
 * Store the functions `root` reaches that the cache does not hold yet: the
 * functions its code calls, the registry entries Ajv looked up and compiled
 * while resolving their references, and the roots of the documents they live
 * in, transitively. Nothing is stored when one of them cannot be named, has
 * no recorded source, or (with `origins`) registered an origin whose
 * document `ajv` does not hold; nor when `mayStore` says no. Never throws.
 */
function storeCompiledFunctions(
  cf: CachedFunctions,
  ajv: Ajv,
  sources: CompiledSources,
  root: ValidateFunction,
  origins: SchemaDiagnosticOrigins | undefined,
  mayStore: () => boolean
): void {
  try {
    storeCompiledFunctionsOrThrow(cf, ajv, sources, root, origins, mayStore);
  } catch {
    // An entry the cache cannot build costs the next process a compile.
  }
}

function storeCompiledFunctionsOrThrow(
  cf: CachedFunctions,
  ajv: Ajv,
  sources: CompiledSources,
  root: ValidateFunction,
  origins: SchemaDiagnosticOrigins | undefined,
  mayStore: () => boolean
): void {
  const lookups = sources.lookups;
  if (!lookups) return;
  const located = new Map<object, { id: string; documents: string[]; looked: ValidateFunction[] }>();
  const order: ValidateFunction[] = [];
  const visit: unknown[] = [root];
  while (visit.length > 0) {
    const fn = visit.pop();
    if (typeof fn !== 'function' || located.has(fn)) continue;
    const src = sources.byFunction.get(fn);
    const env = (fn as { schemaEnv?: Parameters<typeof functionLocation>[1] }).schemaEnv;
    const location = functionLocation(ajv, env);
    if (!src || !location || src.evaluated !== undefined || (fn as { $async?: unknown }).$async) return;
    const looked: ValidateFunction[] = [];
    for (const entry of lookups.get(env!) ?? []) {
      // Ajv compiles every environment it finds while resolving a reference.
      const lookedFn = (entry as { validate?: unknown }).validate;
      if (typeof lookedFn !== 'function') return;
      looked.push(lookedFn as ValidateFunction);
      visit.push(lookedFn);
    }
    located.set(fn, { ...location, looked });
    order.push(fn as ValidateFunction);
    for (const names of Object.values(src.scopeValues ?? {})) {
      for (const name of names) {
        const ref = name.value?.ref;
        if (name.prefix === 'validate') visit.push(ref);
        else if ((name.prefix === 'root' || name.prefix === 'wrapper') && ref && typeof ref === 'object') {
          visit.push((ref as { validate?: unknown }).validate);
        }
      }
    }
    for (const key of location.documents) {
      const documentFn = registeredSchemaEnv(ajv, key)?.validate;
      if (!documentFn) return;
      visit.push(documentFn);
    }
  }

  const entries: Array<[id: string, code: string, meta: StoredFunctionMeta]> = [];
  for (const fn of order) {
    const { id, documents, looked } = located.get(fn)!;
    if (cf.stored.has(id)) continue;
    const src = sources.byFunction.get(fn)!;
    const env = (fn as { schemaEnv?: { schema?: unknown } }).schemaEnv!;
    const refs: StoredRef[] = [];
    const slot = (ref: StoredRef): string => `refs[${refs.push(ref) - 1}]`;
    let declarations = '';
    for (const [prefix, names] of Object.entries(src.scopeValues ?? {})) {
      for (const name of names) {
        const ref = name.value?.ref;
        let value: string | undefined;
        if (prefix === 'schema') {
          value = ref === env.schema ? slot(['s']) : undefined;
        } else if (prefix === 'validate') {
          const target = typeof ref === 'function' ? located.get(ref)?.id : undefined;
          value = target !== undefined ? slot(['f', target]) : undefined;
        } else if (prefix === 'root' || prefix === 'wrapper') {
          const target =
            ref && typeof ref === 'object' ? located.get((ref as { validate?: object }).validate ?? {})?.id : undefined;
          value = target !== undefined ? slot(['h', target]) : undefined;
        } else {
          const code = (name.value as { code?: unknown } | undefined)?.code;
          value = code !== undefined ? String(code) : undefined;
        }
        if (value === undefined) return;
        declarations += `const ${String(name)} = ${value};\n`;
      }
    }
    // Sloppy mode, as Ajv compiles a live function.
    const code = `module.exports = function (refs) {\n${declarations}${src.validateCode}\nreturn ${String(src.validateName)};\n};\n`;
    // Anonymous origin ids are numbered by compile order within a state.
    if (code.includes('urn:adcp:schema-origin:')) return;
    let origin: StoredOrigin | undefined;
    const registered = origins?.registered(env);
    if (registered) {
      const key = registryKeyOf(ajv, registered.document);
      const { schemaAtOriginPointer } =
        require('./schema-diagnostic-origins') as typeof import('./schema-diagnostic-origins');
      if (key === undefined || schemaAtOriginPointer(registered.document, registered.pointer) !== env.schema) return;
      origin = {
        prefix: registered.prefix,
        key,
        pointer: registered.pointer,
        ...(registered.schemaId !== undefined && { schemaId: registered.schemaId }),
      };
    }
    const also = [
      ...new Set([
        ...documents.map(key => documentRootFunctionId(key, registeredSchemaEnv(ajv, key)!.baseId as string)),
        ...looked.map(other => located.get(other)!.id),
      ]),
    ].filter(other => other !== id);
    entries.push([id, code, { refs, also, ...(origin && { origin }) }]);
  }
  if (entries.length === 0 || !mayStore()) return;
  // Callees first, so a concurrent reader rarely finds a caller without them.
  for (const [id, code, meta] of entries.reverse()) {
    cf.cache.write(cachedFunctionKey(cf, id), code, undefined, meta);
    cf.stored.add(id);
  }
}

/**
 * Load the function `rootId` names and everything its entry needs from the
 * cache. `documentFor` gives this state's document for a registry key; with
 * `withOrigins`, each function's stored origin is located too. Returns the
 * function and the located origins of the functions loaded by this call, or
 * `undefined` when any entry is missing or does not fit this state; then
 * nothing is kept.
 */
function loadCachedFunctions(
  cf: CachedFunctions,
  rootId: string,
  documentFor: (key: string) => object | undefined,
  withOrigins: boolean
):
  | { fn: ValidateFunction; origins: Array<[prefix: string, schema: object, schemaId: string | undefined]> }
  | undefined {
  try {
    return loadCachedFunctionsOrThrow(cf, rootId, documentFor, withOrigins);
  } catch {
    return undefined;
  }
}

function loadCachedFunctionsOrThrow(
  cf: CachedFunctions,
  rootId: string,
  documentFor: (key: string) => object | undefined,
  withOrigins: boolean
):
  | { fn: ValidateFunction; origins: Array<[prefix: string, schema: object, schemaId: string | undefined]> }
  | undefined {
  const fresh = new Map<string, ValidateFunction>();
  const holders: Array<[holder: { validate?: unknown }, id: string]> = [];
  const pendingAlso: string[] = [];
  const origins: Array<[string, object, string | undefined]> = [];
  const started = new Set<string>();
  const load = (id: string): ValidateFunction | undefined => {
    const known = cf.loaded.get(id) ?? fresh.get(id);
    if (known) return known;
    // Ajv compiles a callee before its caller, so a cycle means a damaged entry.
    if (started.has(id)) return undefined;
    started.add(id);
    const entry = cf.cache.read(cachedFunctionKey(cf, id));
    const meta = entry?.meta as Partial<StoredFunctionMeta> | undefined;
    if (!entry || !meta || !Array.isArray(meta.refs) || !Array.isArray(meta.also)) return undefined;
    const args: unknown[] = [];
    for (const ref of meta.refs as unknown[]) {
      if (!Array.isArray(ref)) return undefined;
      if (ref[0] === 's' && ref.length === 1) {
        const schema = schemaAtFunctionLocation(id, documentFor);
        if (!schema) return undefined;
        args.push(schema);
      } else if (ref[0] === 'f' && typeof ref[1] === 'string') {
        const callee = load(ref[1]);
        if (!callee) return undefined;
        args.push(callee);
      } else if (ref[0] === 'h' && typeof ref[1] === 'string') {
        const holder: { validate?: unknown } = { validate: undefined };
        holders.push([holder, ref[1]]);
        args.push(holder);
      } else {
        return undefined;
      }
    }
    for (const other of meta.also as unknown[]) {
      if (typeof other !== 'string') return undefined;
      pendingAlso.push(other);
    }
    if (meta.origin !== undefined) {
      if (!withOrigins) return undefined;
      const located = locateStoredOrigins({ origins: [meta.origin] }, key =>
        key === undefined ? undefined : documentFor(key)
      );
      if (!located) return undefined;
      origins.push(located[0]!);
    }
    let fn: unknown;
    try {
      fn = (entry.validate as unknown as (refs: unknown[]) => unknown)(args);
    } catch {
      return undefined;
    }
    if (typeof fn !== 'function') return undefined;
    (fn as { errors?: unknown }).errors = null;
    fresh.set(id, fn as ValidateFunction);
    return fn as ValidateFunction;
  };
  const root = load(rootId);
  if (!root) return undefined;
  for (let i = 0; i < holders.length || pendingAlso.length > 0; ) {
    if (pendingAlso.length > 0) {
      if (!load(pendingAlso.pop()!)) return undefined;
      continue;
    }
    const [holder, id] = holders[i++]!;
    const target = load(id);
    if (!target) return undefined;
    holder.validate = target;
  }
  for (const [id, fn] of fresh) {
    cf.loaded.set(id, fn);
    cf.stored.add(id);
  }
  return { fn: root, origins };
}

/** An origin a stored module's compile registered: `key` names its document (absent: the module's own root). */
interface StoredOrigin {
  prefix: string;
  key?: string;
  pointer: string;
  schemaId?: string;
}

/**
 * The origins `origins` registered for the functions of `closure`, with each
 * document named by `documentKey` (`null`: the module's own root;
 * `undefined`: not storable), or `undefined` when one cannot be named or its
 * pointer does not lead back to the function's schema.
 */
function closureOrigins(
  origins: SchemaDiagnosticOrigins,
  closure: readonly ValidateFunction[],
  documentKey: (document: object) => string | null | undefined
): StoredOrigin[] | undefined {
  const { schemaAtOriginPointer } =
    require('./schema-diagnostic-origins') as typeof import('./schema-diagnostic-origins');
  const out: StoredOrigin[] = [];
  for (const fn of closure) {
    const env = (fn as { schemaEnv?: { schema?: unknown } }).schemaEnv;
    if (!env) return undefined;
    const registered = origins.registered(env);
    if (!registered) continue;
    const key = documentKey(registered.document);
    if (key === undefined || schemaAtOriginPointer(registered.document, registered.pointer) !== env.schema) {
      return undefined;
    }
    out.push({
      prefix: registered.prefix,
      ...(key !== null && { key }),
      pointer: registered.pointer,
      ...(registered.schemaId !== undefined && { schemaId: registered.schemaId }),
    });
  }
  return out;
}

/**
 * Stored origins located in this process: each document from `documentFor`
 * (by key, `undefined` for the module's own root) and the schema at its
 * pointer. `undefined` when the value is malformed or any origin is not found.
 */
function locateStoredOrigins(
  meta: unknown,
  documentFor: (key: string | undefined) => object | undefined
): Array<[prefix: string, schema: object, schemaId: string | undefined]> | undefined {
  const stored = (meta as { origins?: unknown } | undefined)?.origins;
  if (!Array.isArray(stored)) return undefined;
  const { schemaAtOriginPointer } =
    require('./schema-diagnostic-origins') as typeof import('./schema-diagnostic-origins');
  const located: Array<[string, object, string | undefined]> = [];
  for (const origin of stored as Array<Partial<StoredOrigin> | null>) {
    if (
      !origin ||
      typeof origin.prefix !== 'string' ||
      typeof origin.pointer !== 'string' ||
      (origin.key !== undefined && typeof origin.key !== 'string') ||
      (origin.schemaId !== undefined && typeof origin.schemaId !== 'string')
    ) {
      return undefined;
    }
    const schema = schemaAtOriginPointer(documentFor(origin.key), origin.pointer);
    if (!schema) return undefined;
    located.push([origin.prefix, schema, origin.schemaId]);
  }
  return located;
}

/** Ajv's registered (addSchema) environment for `key`, without compiling it. */
function registeredSchemaEnv(
  ajv: Ajv,
  key: string
): { schema: unknown; baseId?: unknown; validate?: ValidateFunction } | undefined {
  const env = (ajv as unknown as { schemas: Record<string, unknown> }).schemas[key];
  return env && typeof env === 'object' && 'schema' in env
    ? (env as { schema: unknown; baseId?: unknown; validate?: ValidateFunction })
    : undefined;
}

/** The key `document` is registered under in `ajv` (by its $id), or `undefined`. */
function registryKeyOf(ajv: Ajv, document: object): string | undefined {
  const id = (document as { $id?: unknown }).$id;
  if (typeof id !== 'string') return undefined;
  for (const key of new Set([id, id.replace(/#\/?$/, '')])) {
    if (registeredSchemaEnv(ajv, key)?.schema === document) return key;
  }
  return undefined;
}

/** Per-state bookkeeping for the opt-in cross-process cache of bundled validators. */
interface BundledValidatorCacheState {
  cache: import('./validator-cache').ValidatorCache;
  /** code.process input and output per SchemaEnv while a compile is being recorded. */
  compileLog:
    | Array<{
        env: { validate?: ValidateFunction & { source?: { validateCode: string } } };
        source: string;
        output: string;
      }>
    | undefined;
  /** The bundled validator this state resolved for each root $id (stock: bundledAjv.getSchema). */
  byId: Map<string, ValidateFunction>;
}

const states: Map<string, LoaderState> = new Map();
const validatorDiagnosticOrigins = new WeakMap<ValidateFunction, SchemaDiagnosticOrigins>();
/**
 * Validators loaded from the cache register their diagnostic origins only
 * when a lookup needs them, by compiling their retained schema live into the
 * same Ajv instance. Bundled origin prefixes start with the root's own $id,
 * so registering them later does not change any other validator's lookups.
 */
const pendingDiagnosticOrigins = new WeakMap<ValidateFunction, () => void>();
const cachedValidatorRootSchemaIds = new WeakMap<ValidateFunction, string | undefined>();
/** The loader state whose modular Ajv registers origins into each modular origin map. */
const modularOriginStates = new WeakMap<SchemaDiagnosticOrigins, LoaderState>();

/** The validator's origins, after its state compiled every deferred request validator. */
function diagnosticOriginsFor(validator: ValidateFunction): SchemaDiagnosticOrigins | undefined {
  pendingDiagnosticOrigins.get(validator)?.();
  const origins = validatorDiagnosticOrigins.get(validator);
  const state = origins && modularOriginStates.get(origins);
  if (state) flushDeferredCompiles(state);
  return origins;
}

/** @internal Resolve the exact function origin retained during compilation. */
export function resolveValidatorDiagnosticPath(validator: ValidateFunction, schemaPath: string): unknown {
  return diagnosticOriginsFor(validator)?.resolve(schemaPath);
}
/** @internal Resource identity and the original public AJV path for a failure. */
export function getValidatorDiagnosticOrigin(
  validator: ValidateFunction,
  schemaPath: string
): SchemaDiagnosticOrigin | undefined {
  return diagnosticOriginsFor(validator)?.origin(schemaPath);
}
/**
 * @internal The string root `$id` of a validator's schema, as
 * `validator.schema.$id` would give it, without building the schema object of
 * a validator loaded from the cross-process cache.
 */
export function getValidatorRootSchemaId(validator: ValidateFunction): string | undefined {
  if (cachedValidatorRootSchemaIds.has(validator)) return cachedValidatorRootSchemaIds.get(validator);
  const root = (validator as { schema?: unknown }).schema;
  return root && typeof root === 'object' && typeof (root as { $id?: unknown }).$id === 'string'
    ? (root as { $id: string }).$id
    : undefined;
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

/**
 * Fingerprints of the external roots entered for each bundle key since its
 * loader states were last cleared (see {@link rootFingerprint}).
 */
const epochRootFingerprints: Map<string, Map<string, string>> = new Map();

function clearStatesForBundle(bundleKey: string): void {
  keywordCacheGeneration++;
  epochRootFingerprints.delete(bundleKey);
  for (const [stateKey, state] of states) {
    if (state.version === bundleKey) states.delete(stateKey);
  }
  for (const cacheKey of schemaRefValidators.keys()) {
    if (cacheKey.startsWith(`${bundleKey}\0`)) schemaRefValidators.delete(cacheKey);
  }
  for (const [root, entry] of documentStores) {
    if (entry.bundleKeys.has(bundleKey)) documentStores.delete(root);
  }
}

/**
 * Start a new loader epoch for each alias of `root`, unless `root` was already
 * entered for that alias in the current epoch with the same fingerprint.
 *
 * A changed, unsettled or unfingerprinted root clears the alias's loader states
 * and bumps the generation, as every entry did before. An unchanged root keeps
 * them, so the validators compiled from it are reused instead of recompiled on
 * every `withExternalSchemaRoot` or `registerExternalSchemaRoot` call.
 */
function enterSchemaRootEpoch(aliases: Iterable<string>, root: string, fingerprint: string | undefined): void {
  for (const alias of aliases) {
    if (fingerprint !== undefined && epochRootFingerprints.get(alias)?.get(root) === fingerprint) continue;
    clearStatesForBundle(alias);
    if (fingerprint !== undefined) epochRootFingerprints.set(alias, new Map([[root, fingerprint]]));
  }
}

/** The top-level fields a schema-root check reads from one document. */
type RootDocumentIdentity = { $id?: string; $schema?: string } | null;

/** What one schema-root check read. */
interface RootCheckReads {
  /** Identity (or read error) per document, so the check reads each document once. */
  identities: Map<string, RootDocumentIdentity | Error>;
  /**
   * Settled stat key and identity per on-disk document, by absolute path: the
   * document's inode, size, mtime and ctime are older than the settle margin.
   * `undefined` once the check read a document it cannot record this way: an
   * archive entry, or a missing or unsettled file.
   */
  stats: Map<string, CachedRootDocumentIdentity> | undefined;
  /** The root being checked; keys the persisted identities. */
  root: string;
  /**
   * Identities a previous process persisted for this root (opt-in, see
   * {@link persistRootCheck}), by document path. `undefined` until first
   * needed, `null` when the cache is off or holds nothing for the root.
   */
  persisted?: Map<string, CachedRootDocumentIdentity> | null;
}

function newRootCheckReads(root: string): RootCheckReads {
  return { identities: new Map(), stats: new Map(), root };
}

/** Persisted identity records: [document path, stat key, kind, $id, $schema]. */
type PersistedRootIdentity = [string, string, 'object' | 'null' | 'unparseable', string | null, string | null];

function persistedRootIdentityKey(root: string): string {
  const { validatorCacheKey } = require('./validator-cache') as typeof import('./validator-cache');
  return validatorCacheKey(['schema-root-identities', ...bundledValidatorCacheStaticKey(), path.resolve(root)]);
}

/**
 * Identities persisted for the check's root by an earlier process, loaded on
 * the first document the in-process cache does not know. Only with
 * ADCP_VALIDATOR_CACHE_DIR set.
 */
function persistedRootIdentities(reads: RootCheckReads): Map<string, CachedRootDocumentIdentity> | null {
  if (reads.persisted !== undefined) return reads.persisted;
  reads.persisted = null;
  const cache = openLoaderDataCache();
  if (!cache) return null;
  const value = cache.readData(persistedRootIdentityKey(reads.root)) as
    | { root?: unknown; documents?: unknown }
    | undefined;
  if (!value || value.root !== path.resolve(reads.root) || !Array.isArray(value.documents)) return null;
  const identities = new Map<string, CachedRootDocumentIdentity>();
  for (const record of value.documents as PersistedRootIdentity[]) {
    if (!Array.isArray(record) || typeof record[0] !== 'string' || typeof record[1] !== 'string') return null;
    const [file, stat, kind, $id, $schema] = record;
    const identity: RootDocumentIdentity | undefined =
      kind === 'null'
        ? null
        : kind === 'object'
          ? {
              ...(typeof $id === 'string' && { $id }),
              ...(typeof $schema === 'string' && { $schema }),
            }
          : undefined;
    identities.set(file, { stat, identity });
  }
  reads.persisted = identities;
  return identities;
}

/**
 * Persist what a successful root check learned, so the next process skips
 * parsing every document: one record per document, written only when every
 * document had a settled stat and the stored records differ. A later process
 * uses a record only while the document's stat key is unchanged, the same
 * rule as the in-process cache. Only with ADCP_VALIDATOR_CACHE_DIR set.
 */
function persistRootCheck(reads: RootCheckReads): void {
  if (!reads.stats || reads.stats.size === 0) return;
  const cache = openLoaderDataCache();
  if (!cache) return;
  const stored = persistedRootIdentities(reads);
  let changed = stored === null || stored.size !== reads.stats.size;
  const documents: PersistedRootIdentity[] = [];
  for (const [file, { stat, identity }] of reads.stats) {
    documents.push([
      file,
      stat,
      identity === undefined ? 'unparseable' : identity === null ? 'null' : 'object',
      identity?.$id ?? null,
      identity?.$schema ?? null,
    ]);
    const previous = stored?.get(file);
    if (!changed && (previous?.stat !== stat || !isDeepStrictEqual(previous.identity, identity))) changed = true;
  }
  if (changed) cache.writeData(persistedRootIdentityKey(reads.root), { root: path.resolve(reads.root), documents });
}

/**
 * A digest of every document a root check read, by path and settled stat key,
 * or `undefined` when one of them has no settled stat. Equal fingerprints mean
 * the same document set with unchanged files, which is everything the loader
 * reads from a raw root. Roots named `bundled` also read the parent's
 * index.json, which the walk does not cover, so they get no fingerprint.
 */
function rootFingerprint(root: string, reads: RootCheckReads): string | undefined {
  if (!reads.stats || reads.stats.size === 0 || path.basename(root) === 'bundled') return undefined;
  const hash = createHash('sha256');
  for (const [file, { stat }] of [...reads.stats].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(file).update('\0').update(stat).update('\0');
  }
  return hash.digest('hex');
}

interface CachedRootDocumentIdentity {
  stat: string;
  /** `undefined` when the document does not parse. */
  identity: RootDocumentIdentity | undefined;
}

/** Files whose timestamps are this close to now may still change within one timestamp tick. */
const ROOT_DOCUMENT_SETTLE_NS = 3_000_000_000n;
const ROOT_DOCUMENT_CACHE_LIMIT = 50_000;

/**
 * Identities of unchanged schema-root documents, shared by the ESM and CommonJS
 * builds (consumers that load both register the same roots through each).
 * Root checks walk every document of a root on every registration and scope;
 * a full release is about 1,600 files and 150 MB of JSON.
 */
function rootDocumentIdentityCache(): Map<string, CachedRootDocumentIdentity> {
  const key = Symbol.for(`@adcp/sdk.schema-root-document-identities.${LIBRARY_VERSION}`);
  const registry = globalThis as unknown as Record<symbol, Map<string, CachedRootDocumentIdentity> | undefined>;
  return (registry[key] ??= new Map());
}

function rootDocumentIdentity(schema: unknown): RootDocumentIdentity {
  if (schema === null) return null;
  const record = schema as { $id?: unknown; $schema?: unknown };
  return {
    ...(typeof record.$id === 'string' && { $id: record.$id }),
    ...(typeof record.$schema === 'string' && { $schema: record.$schema }),
  };
}

/**
 * Read what a root check needs from one document: the same bytes and parser
 * as `loadJson`, without its reporting-dimension rewrite, which edits only
 * `enum`, `type` and `pattern` below the top level of a freshly parsed object.
 *
 * Archive entries (bundled paths not on disk) still go through `loadJson`,
 * because that rewrite mutates the shared archive cache that other readers
 * see, and are never cached. On-disk documents are cached by path while their
 * inode, size, mtime and ctime are unchanged and older than the settle margin.
 *
 * One residual difference from `loadJson`: a document nested deeply enough to
 * overflow the stack in the recursive rewrite is skipped by `loadJson` and
 * read here.
 */
function readRootDocument(file: string, reads: RootCheckReads): RootDocumentIdentity {
  let identity = reads.identities.get(file);
  if (identity === undefined) {
    try {
      identity = readRootDocumentUncached(file, reads);
    } catch (error) {
      identity = error instanceof Error ? error : new Error(String(error));
    }
    reads.identities.set(file, identity);
  }
  if (identity instanceof Error) throw identity;
  return identity;
}

function rememberRootDocumentIdentity(
  cache: Map<string, CachedRootDocumentIdentity>,
  file: string,
  entry: CachedRootDocumentIdentity
): void {
  cache.delete(file);
  cache.set(file, entry);
  if (cache.size > ROOT_DOCUMENT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function readRootDocumentUncached(file: string, reads: RootCheckReads): RootDocumentIdentity {
  const bundled = file.includes(`${path.sep}bundled${path.sep}`);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  let stat;
  try {
    stat = statSync(file, { bigint: true });
  } catch {
    stat = undefined;
  }
  if (!stat?.isFile()) {
    reads.stats = undefined;
    return rootDocumentIdentity(loadJson(file));
  }

  const cache = rootDocumentIdentityCache();
  const cacheKey = path.resolve(file);
  const statKey = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  // Only settled stats are cached or persisted, so an unchanged one is still settled.
  let known = cache.get(cacheKey);
  if (known?.stat !== statKey) {
    const persisted = persistedRootIdentities(reads)?.get(cacheKey);
    known = persisted?.stat === statKey ? persisted : undefined;
    if (known) rememberRootDocumentIdentity(cache, cacheKey, known);
  }
  if (known) {
    reads.stats?.set(cacheKey, known);
    if (known.identity === undefined) throw new Error(`Schema document does not parse: ${file}`);
    return known.identity;
  }

  let identity: RootDocumentIdentity | undefined;
  try {
    const schema = (bundled ? loadBundledSchemaFile(file) : undefined) ?? JSON.parse(readFileSync(file, 'utf-8'));
    identity = rootDocumentIdentity(schema);
  } catch {
    identity = undefined;
  }
  const settled = stat.mtimeNs < nowNs - ROOT_DOCUMENT_SETTLE_NS && stat.ctimeNs < nowNs - ROOT_DOCUMENT_SETTLE_NS;
  if (settled) {
    const entry = { stat: statKey, identity };
    reads.stats?.set(cacheKey, entry);
    rememberRootDocumentIdentity(cache, cacheKey, entry);
  } else {
    reads.stats = undefined;
  }
  if (identity === undefined) throw new Error(`Schema document does not parse: ${file}`);
  return identity;
}

function hasSchemaRootShape(root: string, reads: RootCheckReads = newRootCheckReads(root)): boolean {
  if (!existsSync(root)) return false;
  const bundledRoot = path.join(root, 'bundled');
  const files = hasBundledSchemaStore(bundledRoot) ? walkJsonFiles(bundledRoot) : walkJsonFiles(root);
  return files.some(file => {
    try {
      const schema = readRootDocument(file, reads);
      return typeof schema!.$id === 'string' || typeof schema!.$schema === 'string';
    } catch {
      return false;
    }
  });
}

function schemaIdVersionHint(schemaId: string): string | undefined {
  return schemaId.match(/\/schemas\/([^/]+)\//)?.[1];
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

function collectSchemaRootVersionAliasGroups(
  root: string,
  reads: RootCheckReads
): Array<{ hint: string; aliases: Set<string> }> {
  const groups: Array<{ hint: string; aliases: Set<string> }> = [];
  // A release root has a handful of distinct hints across ~1,700 documents,
  // and alias resolution throws (with a stack) for hints such as `latest`.
  const aliasesByHint = new Map<string, Set<string>>();
  for (const file of walkJsonFiles(root)) {
    let schema: RootDocumentIdentity;
    try {
      schema = readRootDocument(file, reads);
    } catch {
      continue;
    }
    // Outside the guard: a document that parsed to `null` fails the check.
    if (typeof schema!.$id !== 'string') continue;
    const hint = schemaIdVersionHint(schema!.$id);
    if (!hint) continue;
    let aliases = aliasesByHint.get(hint);
    if (!aliases) {
      aliases = schemaRootVersionAliases(hint);
      aliasesByHint.set(hint, aliases);
    }
    groups.push({ hint, aliases });
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

function assertSchemaRootMatchesVersion(
  version: string,
  root: string,
  reads: RootCheckReads = newRootCheckReads(root)
): Set<string> {
  const expectedAliases = schemaRootVersionAliases(version);
  const rootGroups = collectSchemaRootVersionAliasGroups(root, reads);
  const rootAliases = new Set(rootGroups.flatMap(group => [...group.aliases]));
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
  const reads = newRootCheckReads(root);
  if (!hasSchemaRootShape(root, reads)) {
    throw new Error(`External AdCP schema root for version "${version}" not found or empty at ${root}`);
  }
  const aliases = assertSchemaRootMatchesVersion(version, root, reads);
  persistRootCheck(reads);
  externalSchemaRootAliases.set(key, aliases);
  for (const alias of aliases) externalSchemaRoots.set(alias, root);
  enterSchemaRootEpoch(aliases, root, rootFingerprint(root, reads));
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
  const reads = newRootCheckReads(root);
  if (!hasSchemaRootShape(root, reads)) {
    throw new Error(`External AdCP schema root for version "${version}" not found or empty at ${root}`);
  }
  const aliases = assertSchemaRootMatchesVersion(version, root, reads);
  persistRootCheck(reads);
  const parent = scopedExternalSchemaRoots.getStore();
  const next = new Map(parent);
  for (const alias of aliases) next.set(alias, root);
  enterSchemaRootEpoch(aliases, root, rootFingerprint(root, reads));
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
    if (bundled) return openExtensibleReportingDimensions(bundled);
  }
  return openExtensibleReportingDimensions(JSON.parse(readFileSync(file, 'utf-8')) as LoadedSchema);
}

/** One document of a {@link DocumentStore}: what {@link loadJson} returns or throws, read once. */
interface StoredDocument {
  /** The parsed document, deep-frozen; absent when reading or parsing threw. */
  schema?: LoadedSchema;
  /** What reading or parsing threw. */
  error?: unknown;
  /**
   * The document's content for {@link rootContentDigest}: a hash of the text
   * read, of an archive entry, or the read error's code. Only recorded while
   * ADCP_VALIDATOR_CACHE_DIR is enabled, the only time a digest is taken.
   */
  content?: string;
}

type DocumentStore = Map<string, StoredDocument>;

/**
 * Parsed documents per schema root. Every reader of a root in the same epoch
 * (core registration, the tool and canonical validators, schema-ref
 * validators, the content digest and the document getters) shares one read
 * and one parse of each file, instead of each reading the whole root again,
 * whichever bundle key (`3.3.0-rc.3`, `3.3-rc.3`, ...) selected the root.
 * Cleared when the loader states of any bundle key that used the root are,
 * so a new epoch reads the files again; a state keeps the store it started
 * with, which holds the documents its validators compiled.
 *
 * Documents are deep-frozen: one caller's mutation cannot reach another, and
 * an attempt throws in strict-mode code. Callers that need a modified schema
 * copy it first, as the envelope widening, nested-$id strip, compaction and
 * draft overlays already do.
 */
const documentStores: Map<string, { store: DocumentStore; bundleKeys: Set<string> }> = new Map();

function documentStore(bundleKey: string, root: string): DocumentStore {
  let entry = documentStores.get(root);
  if (!entry) {
    entry = { store: new Map(), bundleKeys: new Set() };
    documentStores.set(root, entry);
  }
  entry.bundleKeys.add(bundleKey);
  return entry.store;
}

/** {@link loadJson} through `store`: the file is read and parsed at most once per store. */
function readStoredDocument(store: DocumentStore, file: string): LoadedSchema {
  let entry = store.get(file);
  if (!entry) {
    entry = loadStoredDocument(file);
    store.set(file, entry);
  }
  if ('error' in entry) throw entry.error;
  return entry.schema!;
}

/** Documents a store has deep-frozen: their content never changes. */
const storedDocuments = new WeakSet<object>();

/**
 * Stored documents that passed Ajv's draft-07 meta-validation in a registry
 * with the SDK's plain options (strict off, union types, ajv-formats, no custom
 * keywords). Every registry below that adds them has those options, and the
 * outcome depends only on the document, so each is validated once per process
 * instead of once per registry. A document that fails is never recorded, so it
 * fails again wherever it is added.
 */
const metaValidatedDocuments = new WeakSet<object>();

/**
 * `ajv.addSchema(schema)`, skipping meta-validation of a stored document that
 * passed it before. Only for registries with the SDK's plain options.
 */
function addPlainRegistryDocument(ajv: Ajv, schema: LoadedSchema): void {
  const validated = metaValidatedDocuments.has(schema);
  ajv.addSchema(schema, undefined, undefined, validated ? false : undefined);
  if (!validated && storedDocuments.has(schema)) metaValidatedDocuments.add(schema);
}

function frozenStoredDocument(schema: LoadedSchema): LoadedSchema {
  deepFreeze(schema);
  storedDocuments.add(schema);
  return schema;
}

function loadStoredDocument(file: string): StoredDocument {
  const recordContent = validatorCacheDir() !== undefined;
  const bundled = file.includes(`${path.sep}bundled${path.sep}`);
  let text: string;
  try {
    // The utf-8 read is one native call; a Buffer read costs several.
    text = readFileSync(file, 'utf-8');
  } catch (readError) {
    // Bundled paths not on disk are entries of the root's compact archive.
    let entry: LoadedSchema | undefined;
    if (bundled) {
      try {
        entry = loadBundledSchemaFile(file);
      } catch {
        entry = undefined;
      }
    }
    if (!entry) {
      return {
        error: readError,
        ...(recordContent && { content: `unreadable\0${(readError as NodeJS.ErrnoException).code ?? ''}` }),
      };
    }
    const content = recordContent ? `archive\0${contentHash(JSON.stringify(entry))}` : undefined;
    return { schema: frozenStoredDocument(openExtensibleReportingDimensions(entry)), ...(content && { content }) };
  }
  const content = recordContent ? `file\0${contentHash(text)}` : undefined;
  try {
    const parsed = JSON.parse(text) as LoadedSchema;
    const schema = bundled ? (expandBundledSchemaDocument(parsed) as LoadedSchema) : parsed;
    return { schema: frozenStoredDocument(openExtensibleReportingDimensions(schema)), ...(content && { content }) };
  } catch (error) {
    return { error, ...(content && { content }) };
  }
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node && typeof node === 'object') {
      Object.freeze(node);
      for (const child of Object.values(node)) pending.push(child);
    }
  }
  return value;
}

const REPORTING_DIMENSION_PATTERN = '^[a-z][a-z0-9_]*$';

/**
 * `enums/reporting-dimension.json` is an extensible vocabulary: "Receivers MUST accept
 * unknown values; a selector naming a value the seller does not map matches no offering."
 * Its JSON Schema `enum` is closed, so validate it against its declared `x-pattern`
 * instead, wherever a copy is inlined. Other extensible enums are unchanged.
 */
function openExtensibleReportingDimensions<T>(schema: T): T {
  const visit = (node: unknown, key: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, undefined);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const id = typeof record.$id === 'string' ? record.$id : '';
    if (
      Array.isArray(record.enum) &&
      (id.endsWith('/enums/reporting-dimension.json') ||
        record.title === 'Reporting Dimension' ||
        key?.endsWith('enums/reporting-dimension.json'))
    ) {
      delete record.enum;
      record.type = 'string';
      record.pattern = typeof record['x-pattern'] === 'string' ? record['x-pattern'] : REPORTING_DIMENSION_PATTERN;
    }
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(schema, undefined);
  return schema;
}

/**
 * Envelope fields a task response carries next to its body on MCP and REST
 * (`core/protocol-envelope.json` plus the `adcp_version` echo). Types are
 * deliberately shallow: this table only lets a closed pre-composition root
 * accept the field, and the body fields keep their published schemas.
 */
const ENVELOPE_FIELD_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  context_id: { type: 'string' },
  context: { type: 'object' },
  task_id: { type: 'string' },
  message: { type: 'string' },
  timestamp: { type: 'string', format: 'date-time' },
  replayed: { type: 'boolean' },
  adcp_error: { type: 'object' },
  push_notification_config: { type: 'object' },
  governance_context: { type: 'string' },
  adcp_version: { type: 'string' },
  adcp_major_version: { type: 'integer' },
};

interface ReleaseEnvelopeFields {
  /** Envelope field name -> schema, as this release's bundle defines them. */
  fields: ReadonlyMap<string, Record<string, unknown>>;
}

const releaseEnvelopeFields = new Map<string, ReleaseEnvelopeFields>();

/**
 * Envelope fields the bundle at `root` defines, read from that release's own
 * `core/protocol-envelope.json` (and its `enums/task-status.json` for the
 * `status` values), so a closed root is only widened by what its release
 * published. `adcp_version` / `adcp_major_version` are always included: they
 * are the version echo, accepted on every response.
 */
function envelopeFieldsForRelease(root: string, documents?: DocumentStore): ReleaseEnvelopeFields {
  const cached = releaseEnvelopeFields.get(root);
  if (cached) return cached;
  const read = (file: string): LoadedSchema => (documents ? readStoredDocument(documents, file) : loadJson(file));
  const fields = new Map<string, Record<string, unknown>>();
  const envelopeFile = path.join(root, 'core', 'protocol-envelope.json');
  const declared = existsSync(envelopeFile)
    ? Object.keys((read(envelopeFile).properties ?? {}) as Record<string, unknown>)
    : [...Object.keys(ENVELOPE_FIELD_SCHEMAS), 'status'];
  for (const name of new Set([...declared, 'adcp_version', 'adcp_major_version'])) {
    // `payload` is the conceptual grouping of the body on the abstract
    // envelope; flat MCP/REST responses never carry it.
    if (name === 'payload') continue;
    if (name === 'status') {
      const statusFile = path.join(root, 'enums', 'task-status.json');
      const values = existsSync(statusFile) ? (read(statusFile).enum as unknown) : undefined;
      fields.set('status', Array.isArray(values) ? { type: 'string', enum: values } : { type: 'string' });
    } else if (ENVELOPE_FIELD_SCHEMAS[name]) {
      fields.set(name, ENVELOPE_FIELD_SCHEMAS[name]);
    }
  }
  const entry = { fields };
  releaseEnvelopeFields.set(root, entry);
  return entry;
}

/** True when the response root composes `core/protocol-envelope.json` through `allOf`. */
function composesProtocolEnvelope(schema: LoadedSchema): boolean {
  const members = schema.allOf;
  if (!Array.isArray(members)) return false;
  return members.some(member => {
    if (!member || typeof member !== 'object') return false;
    const node = member as Record<string, unknown>;
    return (
      (typeof node.$ref === 'string' && node.$ref.endsWith('protocol-envelope.json')) ||
      (typeof node.$id === 'string' && node.$id.endsWith('protocol-envelope.json')) ||
      node.title === 'Protocol Envelope'
    );
  });
}

/**
 * Let a closed response root accept the envelope fields its release defines.
 *
 * Releases that compose `protocol-envelope` into every response root (3.3
 * and the 3.2.x backport) publish closed roots that already declare those
 * fields, so their schemas are returned untouched and validated exactly as
 * published. Earlier releases (3.2.7 and before) shipped some roots closed
 * (`additionalProperties: false`) without composing the envelope, so a
 * conforming response carrying `status`, `task_id`, `replayed` or the
 * `adcp_version` echo would fail on the field alone. For those bundles only,
 * each closed node of the root composition (root and its
 * `oneOf` / `anyOf` / `allOf` branches) gains the envelope fields that
 * release's `protocol-envelope.json` defines and that the node does not
 * already declare. Body fields stay closed, so a typo in the body is still
 * rejected, and no envelope field is ever added, removed or filled in on the
 * response itself. A field a node declares locally is left as authored.
 * Applied only to response variants.
 */
/** @internal Shared by opt-in overlays that retain response-envelope compatibility. */
export function acceptEnvelopeOnClosedResponseRoot(schema: LoadedSchema, root: string): LoadedSchema {
  return acceptEnvelopeFromRelease(schema, root);
}

/** {@link acceptEnvelopeOnClosedResponseRoot}, reading the release's envelope through `documents`. */
function acceptEnvelopeFromRelease(schema: LoadedSchema, root: string, documents?: DocumentStore): LoadedSchema {
  if (composesProtocolEnvelope(schema)) return schema;
  const { fields } = envelopeFieldsForRelease(root, documents);
  const widen = (node: Record<string, unknown>): Record<string, unknown> => {
    const clone = { ...node };
    if (clone.additionalProperties === false) {
      const declared = (clone.properties ?? {}) as Record<string, unknown>;
      const missing = [...fields].filter(([name]) => !(name in declared));
      if (missing.length > 0) clone.properties = { ...Object.fromEntries(missing), ...declared };
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const branches = clone[key];
      if (Array.isArray(branches)) {
        clone[key] = branches.map(branch =>
          branch && typeof branch === 'object' ? widen(branch as Record<string, unknown>) : branch
        );
      }
    }
    return clone;
  };

  return widen(schema) as LoadedSchema;
}

/**
 * Whether the release's published synchronous response schema for `toolName`
 * composes `core/protocol-envelope.json`, and so carries (and requires) the
 * task-envelope `status`. Releases that predate the composition publish some
 * compact arms closed with no `status` (3.2.x `list_products`, whose
 * `decline_proposals` success arm even says `not: required status`).
 *
 * Returns `undefined` when the release has no such schema, so callers keep
 * their default instead of guessing from a version number.
 *
 * @internal
 */
export function responseSchemaComposesEnvelope(toolName: string, version: string = ADCP_VERSION): boolean | undefined {
  let document: ResolvedToolSchemaDocument | undefined;
  try {
    document = getToolSchemaDocument(toolName, 'sync', version);
  } catch {
    return undefined;
  }
  return document ? composesProtocolEnvelope(document.schema as LoadedSchema) : undefined;
}

/** @internal Same widening for a caller that holds only the requested version. */
export function acceptEnvelopeOnClosedResponseRootForVersion(
  schema: LoadedSchema,
  version: string = ADCP_VERSION
): LoadedSchema {
  const state = ensureInit(version);
  return acceptEnvelopeFromRelease(schema, state.root, state.documents);
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
  const bundledCache = openBundledValidatorCache();
  // With the cache enabled, the modular registry keeps each function's
  // source (off the function) so its compiled functions can be stored.
  const modularSources: CompiledSources | undefined = bundledCache
    ? { pending: [], byFunction: new WeakMap() }
    : undefined;
  const ajv = new Ajv({
    inlineRefs: false,
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    code: modularSources
      ? { source: true, process: recordingCodeProcess(modularSources, diagnosticOrigins.process) }
      : { process: diagnosticOrigins.process },
  });
  addFormats(ajv);
  if (modularSources) recordRegistryLookups(ajv, modularSources);
  // Bundled tool roots can intentionally share their canonical `$id` with
  // modular documents registered in `ajv`. Keep them in a separate registry
  // so getValidator compiles the file selected by fileIndex rather than
  // accidentally reusing a modular validator with the same public id.
  const bundledAjv = new Ajv({
    inlineRefs: false,
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    code: bundledCache
      ? {
          // Ajv keeps the code from before code.process; the cache records
          // the processed code so stored modules carry the origin rewrite.
          source: true,
          process: (source: string, environment?: unknown) => {
            const output = bundledDiagnosticOrigins.process(
              source,
              environment as Parameters<SchemaDiagnosticOrigins['process']>[1]
            );
            bundledCache.compileLog?.push({
              env: environment as NonNullable<BundledValidatorCacheState['compileLog']>[number]['env'],
              source,
              output,
            });
            return output;
          },
        }
      : { process: bundledDiagnosticOrigins.process },
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
    documents: documentStore(key, root),
    entityPaths: new Map(),
    root,
    coreLoaded: false,
    version: key,
    ...(bundledCache && { bundledCache }),
    ...(modularSources && { modularSources, modularById: new Map() }),
  };
  modularOriginStates.set(diagnosticOrigins, state);
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
 * canonical `$id`. Responses also receive `acceptEnvelopeOnClosedResponseRoot`,
 * matching `getValidator`.
 * These checks are stricter than a filename-suffix match:
 * building-block fragments like `core/pagination-response.json` end in
 * `-response.json` but aren't tools, so suffix-matching would wrongly treat
 * them as response roots.
 */
function ensureCoreLoaded(s: LoaderState): void {
  if (s.coreLoaded) return;
  try {
    registerCoreDocuments(s);
  } catch (error) {
    if (s.modularSources) drainCompiledSources(s.modularSources);
    // Ajv keeps a document it then rejects, so a later attempt can succeed
    // where this one failed: outcomes in this state depend on call order.
    s.coreLoadFailed = true;
    throw error;
  }
  // Registration compiled the meta-schema; its function keeps no source either.
  if (s.modularSources) drainCompiledSources(s.modularSources);
  s.coreLoaded = true;
}

function registerCoreDocuments(s: LoaderState): void {
  // Tool response files are pre-registered with the same response-root
  // envelope handling `getValidator` would apply. This matters for the async response
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
    const schema = readStoredDocument(s.documents, file);
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
      const schema = readStoredDocument(s.documents, file);
      const selected = typeof schema.$id === 'string' ? selectedToolsById.get(schema.$id) : undefined;
      const selectedShadowsModular = selected !== undefined && selected.file !== file;
      const selectedSchema = selectedShadowsModular ? readStoredDocument(s.documents, selected.file) : schema;
      const prepared =
        selectedShadowsModular && selected.file.includes(`${path.sep}bundled${path.sep}`)
          ? stripNestedIds(selectedSchema)
          : selectedSchema;
      const isResponseTool = selected?.response ?? responseToolFiles.has(file);
      const schemaToRegister = isResponseTool ? acceptEnvelopeFromRelease(prepared, s.root, s.documents) : prepared;
      if (typeof schemaToRegister.$id === 'string' && !registeredIds.has(schemaToRegister.$id)) {
        addPlainRegistryDocument(s.ajv, schemaToRegister);
        registeredIds.add(schemaToRegister.$id);
      }
    }
  }
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
  return validatorForState(ensureInit(version), toolName, direction);
}

/** {@link getValidator} against one loader state. */
function validatorForState(s: LoaderState, toolName: string, direction: Direction): ValidateFunction | undefined {
  const cacheKey = `${toolName}::${direction}`;
  const cached = s.validators.get(cacheKey);
  if (cached) return cached;

  const indexedFile = s.fileIndex.get(cacheKey);
  if (!indexedFile) return undefined;
  // Prefer a context-safe authored ref graph; retain paired bundled response
  // compositions when the envelope step cannot safely traverse shared refs.
  const file = runtimeToolSchemaFile(s, indexedFile, direction);

  // Flat-tree schemas `$ref` into separately published documents and need
  // those trees registered before compile. Bundled schemas contain only
  // root-local refs and compile independently.
  const fromBundled = file.includes(`${path.sep}bundled${path.sep}`);
  // The root's content keys cached modular validators; like definesToolRequest,
  // take it before the documents are registered.
  const digest = !fromBundled && s.modularSources ? cacheContentDigest(s) : undefined;
  if (!fromBundled) ensureCoreLoaded(s);

  const rawSchema = readStoredDocument(s.documents, file);
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
  // behind a private ref. Canonical validators deliberately skip it.
  const envelope = direction === 'request' ? prepared : acceptEnvelopeFromRelease(prepared, s.root, s.documents);
  if (fromBundled && s.bundledCache) {
    const resolved = resolveBundledValidatorWithCache(s, s.bundledCache, cacheKey, envelope);
    s.validators.set(cacheKey, resolved);
    validatorDiagnosticOrigins.set(resolved, s.bundledDiagnosticOrigins);
    return resolved;
  }
  const schema = fromBundled ? compactSchemaForValidation(envelope) : envelope;
  if (!fromBundled && s.bundledCache && s.modularSources) {
    const resolved = resolveModularValidatorWithCache(s, s.bundledCache, s.modularSources, schema, digest);
    s.validators.set(cacheKey, resolved);
    validatorDiagnosticOrigins.set(resolved, s.diagnosticOrigins);
    return resolved;
  }
  const ajv = fromBundled ? s.bundledAjv : s.ajv;
  const existing = typeof schema.$id === 'string' ? ajv.getSchema(schema.$id) : undefined;
  const compiled = existing ?? ajv.compile(schema);
  s.validators.set(cacheKey, compiled);
  validatorDiagnosticOrigins.set(compiled, fromBundled ? s.bundledDiagnosticOrigins : s.diagnosticOrigins);
  return compiled;
}

/**
 * @internal Whether the version's request schema for the tool compiles:
 * `getValidator(toolName, 'request', version) !== undefined`, and `false`
 * where that compile throws. Throws when the version has no schema data, as
 * {@link getValidator} does.
 *
 * With ADCP_VALIDATOR_CACHE_DIR set, a modular request schema that compiled
 * is recorded under a key over the root's content (see
 * {@link rootContentDigest}), the loader code, the Ajv and JS engine versions
 * and the tool, and later processes read that instead of compiling. The state
 * compiles those validators before its diagnostics are read (see
 * {@link flushDeferredCompiles}), so validation issues are the same as if this
 * call had compiled them. A schema that fails is never recorded and compiles
 * here every time, as do bundled request schemas and every schema with the
 * cache off.
 */
export function definesToolRequest(toolName: string, version: string = ADCP_VERSION): boolean {
  const s = ensureInit(version);
  const key = `${toolName}::request`;
  if (s.validators.has(key) || s.cachedCompiles?.has(key)) return true;
  const indexedFile = s.fileIndex.get(key);
  if (!indexedFile) return false;
  const modular = !runtimeToolSchemaFile(s, indexedFile, 'request').includes(`${path.sep}bundled${path.sep}`);
  const cache = modular ? openLoaderDataCache() : undefined;
  const digest = cache ? stateContentDigest(s) : undefined;
  // Records come only from states whose first registration succeeded, where
  // a compile's outcome depends on the root's content alone.
  if (!cache || digest === undefined || s.coreLoadFailed) return compilesForState(s, toolName, 'request');

  const { validatorCacheKey } = require('./validator-cache') as typeof import('./validator-cache');
  const outcomeKey = validatorCacheKey([
    'modular-request-compiles',
    ...bundledValidatorCacheStaticKey(),
    process.versions.v8,
    process.versions.unicode ?? null,
    s.version,
    digest,
    toolName,
  ]);
  if ((cache.readData(outcomeKey) as { compiles?: unknown } | undefined)?.compiles === true) {
    (s.cachedCompiles ??= new Set()).add(key);
    (s.deferredCompiles ??= new Set()).add(key);
    return true;
  }
  const compiles = compilesForState(s, toolName, 'request');
  if (compiles && !s.coreLoadFailed && contentUnchangedSinceDigest(s)) {
    cache.writeData(outcomeKey, { compiles: true });
  }
  return compiles;
}

function compilesForState(s: LoaderState, toolName: string, direction: Direction): boolean {
  try {
    return validatorForState(s, toolName, direction) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Compile the request validators whose compile {@link definesToolRequest}
 * answered from the cache, against `s` itself and in call order. Compiling
 * adds the origins and registered ids that request and response diagnostics
 * read, so the state's compiled set is what it would have been.
 */
function flushDeferredCompiles(s: LoaderState): void {
  const deferred = s.deferredCompiles;
  if (!deferred) return;
  s.deferredCompiles = undefined;
  for (const key of deferred) {
    if (!s.validators.has(key)) compilesForState(s, key.slice(0, -'::request'.length), 'request');
  }
}

/**
 * The state's root content digest, computed once, or `undefined` when the
 * state registered its documents before the digest was taken, or when a
 * document it covers was read without its content recorded.
 */
function stateContentDigest(s: LoaderState): string | undefined {
  if (s.contentDigest === undefined) s.contentDigest = s.coreLoaded ? null : rootContentDigest(s);
  return s.contentDigest ?? undefined;
}

/**
 * Whether the root still has the content the state's digest was taken from,
 * checked once, at the first outcome the state records; by then the state has
 * registered its documents. A changed root stops the state using the cache.
 */
function contentUnchangedSinceDigest(s: LoaderState): boolean {
  if (!s.contentDigestChecked) {
    s.contentDigestChecked = true;
    if (rootContentDigest(s) !== s.contentDigest) s.contentDigest = null;
  }
  return typeof s.contentDigest === 'string';
}

/**
 * SHA-256 over every document a modular compile in `s` can read, by
 * root-relative path and content: JSON files at the root and in its runtime
 * directories (what ensureCoreLoaded registers and getValidator reads), the
 * index entries, and each indexed file the loader reads in place of a missing
 * authored one. Content, not stat: a byte-identical copy of a root has the
 * same digest.
 *
 * Each document's content comes from the state's document store, the same
 * read the compile uses, so a document is read once whether it is digested,
 * compiled or both. A later digest walks the directories again, so a document
 * added or removed since the first one changes it. `null` when a document was
 * read without its content recorded (the cache was enabled after that read).
 */
function rootContentDigest(s: LoaderState): string | null {
  const files = new Set<string>();
  for (const entry of readdirSync(s.root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (isRuntimeSchemaDirectory(entry.name)) {
        for (const file of walkJsonFiles(path.join(s.root, entry.name))) files.add(file);
      }
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.add(path.join(s.root, entry.name));
    }
  }
  for (const indexedFile of s.fileIndex.values()) files.add(authoredToolSchemaFile(s, indexedFile));
  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const hash = createHash('sha256');
  for (const [key, file] of [...s.fileIndex].sort(([a], [b]) => byPath(a, b))) {
    hash.update(`index\0${key}\0${path.relative(s.root, file)}\0`);
  }
  for (const file of [...files].sort(byPath)) {
    const content = storedDocumentContent(s.documents, file);
    if (content === undefined) return null;
    hash.update(`file\0${path.relative(s.root, file)}\0${content}\0`);
  }
  return hash.digest('hex');
}

/** The content {@link loadStoredDocument} recorded for `file`, reading it into `store` if needed. */
function storedDocumentContent(store: DocumentStore, file: string): string | undefined {
  try {
    readStoredDocument(store, file);
  } catch {
    // Unparseable and unreadable documents still record their content.
  }
  return store.get(file)?.content;
}

/** Loader modules whose code shapes a compiled bundled validator. */
const VALIDATOR_CACHE_CODE_FILES = [
  'schema-loader',
  'compact-schema',
  'schema-diagnostic-origins',
  'bundled-schema-store',
  'validator-cache',
] as const;
/** The bundledAjv options and plugins, as the cache key records them. */
const BUNDLED_AJV_KEY = {
  inlineRefs: false,
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
  formats: 'ajv-formats',
};

let validatorCacheStaticKey: unknown[] | undefined;

/**
 * The bundled-validator cache for a new loader state, or `undefined` when
 * ADCP_VALIDATOR_CACHE_DIR is unset, empty or relative, or the directory is
 * unsafe. Only an enabled cache loads the cache module.
 */
function openBundledValidatorCache(): BundledValidatorCacheState | undefined {
  const dir = validatorCacheDir();
  if (dir === undefined) return undefined;
  const { openValidatorCache } = require('./validator-cache') as typeof import('./validator-cache');
  const cache = openValidatorCache(dir, path.join(__dirname, 'schema-loader.js'));
  return cache ? { cache, compileLog: undefined, byId: new Map() } : undefined;
}

/** ADCP_VALIDATOR_CACHE_DIR when it is a non-empty absolute path; otherwise the cache is off. */
function validatorCacheDir(): string | undefined {
  const dir = process.env.ADCP_VALIDATOR_CACHE_DIR;
  return dir && path.isAbsolute(dir) ? dir : undefined;
}

let loaderDataCache: { dir: string; cache: import('./validator-cache').ValidatorCache | undefined } | undefined;

/**
 * The cache for the loader's data entries (schema-root document identities,
 * modular request compile outcomes), opened once per directory.
 */
function openLoaderDataCache(): import('./validator-cache').ValidatorCache | undefined {
  const dir = validatorCacheDir();
  if (dir === undefined) return undefined;
  if (loaderDataCache?.dir !== dir) {
    const { openValidatorCache } = require('./validator-cache') as typeof import('./validator-cache');
    loaderDataCache = { dir, cache: openValidatorCache(dir, path.join(__dirname, 'schema-loader.js')) };
  }
  return loaderDataCache.cache;
}

/**
 * Inputs that change generated validator code without changing the prepared
 * schema: this SDK build's loader code, Ajv, ajv-formats and the libraries
 * Ajv compiles with, resolved the way this loader resolves them.
 */
function bundledValidatorCacheStaticKey(): unknown[] {
  if (validatorCacheStaticKey) return validatorCacheStaticKey;
  const { filesDigest } = require('./validator-cache') as typeof import('./validator-cache');
  const loaderRequire = createRequire(path.join(__dirname, 'schema-loader.js'));
  const packageVersion = (name: string, from: NodeRequire): string | null => {
    try {
      return (from(`${name}/package.json`) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  };
  let ajvRequire: NodeRequire = loaderRequire;
  try {
    ajvRequire = createRequire(loaderRequire.resolve('ajv'));
  } catch {
    // Versions below then come from the loader's own resolution.
  }
  validatorCacheStaticKey = [
    LIBRARY_VERSION,
    filesDigest(
      VALIDATOR_CACHE_CODE_FILES.flatMap(name => [`${name}.js`, `${name}.mjs`]).map(file => path.join(__dirname, file))
    ),
    packageVersion('ajv', loaderRequire),
    packageVersion('ajv-formats', loaderRequire),
    packageVersion('fast-uri', ajvRequire),
    packageVersion('json-schema-traverse', ajvRequire),
    packageVersion('fast-deep-equal', ajvRequire),
    BUNDLED_AJV_KEY,
  ];
  return validatorCacheStaticKey;
}

type SourcedValidateFunction = ValidateFunction & { source?: { validateCode: string } };

/**
 * Compile `schema` into the state's bundledAjv while recording code.process
 * output, then drop the per-function `.source` that code.source adds (stock
 * validators carry none). Returns the compiled validator and, when it can be
 * stored exactly, its standalone module code and the diagnostic origins its
 * functions registered (all relative to `schema`, the module's own root).
 */
function compileBundledRecorded(
  s: LoaderState,
  bc: BundledValidatorCacheState,
  schema: LoadedSchema,
  wantModule: boolean
): { compiled: ValidateFunction; moduleCode?: string; origins?: StoredOrigin[] } {
  const log: NonNullable<BundledValidatorCacheState['compileLog']> = [];
  bc.compileLog = log;
  let compiled: ValidateFunction;
  try {
    compiled = s.bundledAjv.compile(schema);
  } finally {
    bc.compileLog = undefined;
  }
  let moduleCode: string | undefined;
  let origins: StoredOrigin[] | undefined;
  try {
    let exact = wantModule && !(compiled as { $async?: unknown }).$async && log.length > 0;
    for (const entry of log) {
      const fn = entry.env.validate as SourcedValidateFunction | undefined;
      const validateCode = fn?.source?.validateCode;
      if (!fn || typeof validateCode !== 'string' || !entry.source.endsWith(validateCode)) {
        exact = false;
        continue;
      }
      // Ajv emits `<scope refs>return <validateCode>`; code.process rewrites
      // only schemaPath literals inside the function body.
      const prefixLength = entry.source.length - validateCode.length;
      if (
        !entry.source.slice(0, prefixLength).endsWith('return ') ||
        entry.output.slice(0, prefixLength) !== entry.source.slice(0, prefixLength)
      ) {
        exact = false;
        continue;
      }
      fn.source!.validateCode = entry.output.slice(prefixLength);
    }
    if (exact) {
      const standaloneCode = (require('ajv/dist/standalone') as typeof import('ajv/dist/standalone')).default;
      const code = standaloneCode(s.bundledAjv, compiled);
      // Anonymous origin ids are numbered by compile order within a state.
      if (!code.includes('urn:adcp:schema-origin:')) moduleCode = code;
      const closure =
        moduleCode !== undefined
          ? compiledClosure(compiled, fn => (fn as { source?: AjvFunctionSource }).source)
          : undefined;
      origins =
        closure &&
        closureOrigins(s.bundledDiagnosticOrigins, closure, document => (document === schema ? null : undefined));
    }
  } catch {
    moduleCode = undefined;
    origins = undefined;
  } finally {
    for (const entry of log) delete (entry.env.validate as SourcedValidateFunction | undefined)?.source;
  }
  return { compiled, ...(moduleCode !== undefined && { moduleCode }), ...(origins !== undefined && { origins }) };
}

/**
 * getValidator's bundled branch with the cache enabled. A cache hit returns
 * the stored validator without compacting or compiling; its `.schema` and
 * `.schemaEnv` resolve on first read, and a diagnostic-origin lookup compiles
 * the retained schema live once. A miss compiles exactly as stock and stores
 * the result.
 */
function resolveBundledValidatorWithCache(
  s: LoaderState,
  bc: BundledValidatorCacheState,
  toolKey: string,
  envelope: LoadedSchema
): ValidateFunction {
  const id = typeof envelope.$id === 'string' ? envelope.$id : undefined;
  const known = id !== undefined ? bc.byId.get(id) : undefined;
  if (known) return known;

  const { validatorCacheKey } = require('./validator-cache') as typeof import('./validator-cache');
  const key = validatorCacheKey([...bundledValidatorCacheStaticKey(), s.version, toolKey, envelope]);
  const entry = bc.cache.read(key);
  if (entry) {
    const fn = entry.validate as unknown as ValidateFunction;
    let compacted: LoadedSchema | undefined;
    const compactedSchema = (): LoadedSchema => (compacted ??= compactSchemaForValidation(envelope));
    const materialize = (): ValidateFunction | undefined => {
      pendingDiagnosticOrigins.delete(fn);
      try {
        const schema = compactedSchema();
        const existing = typeof schema.$id === 'string' ? s.bundledAjv.getSchema(schema.$id) : undefined;
        return existing ?? compileBundledRecorded(s, bc, schema, false).compiled;
      } catch {
        return undefined;
      }
    };
    // The first diagnostic lookup adds the origins the compile would have
    // added, relative to the compacted schema `.schema` returns; an entry
    // without them, or whose origins this schema lacks, compiles it instead.
    pendingDiagnosticOrigins.set(fn, () => {
      pendingDiagnosticOrigins.delete(fn);
      let located: ReturnType<typeof locateStoredOrigins>;
      try {
        const root = compactedSchema();
        located = locateStoredOrigins(entry.meta, origin => (origin === undefined ? root : undefined));
      } catch {
        located = undefined;
      }
      if (!located) return void materialize();
      for (const [prefix, originSchema, schemaId] of located) {
        s.bundledDiagnosticOrigins.replay(prefix, originSchema, schemaId);
      }
    });
    Object.defineProperty(fn, 'schema', {
      configurable: true,
      enumerable: true,
      get() {
        const value = compactedSchema();
        Object.defineProperty(fn, 'schema', { value, writable: true, enumerable: true, configurable: true });
        return value;
      },
    });
    Object.defineProperty(fn, 'schemaEnv', {
      configurable: true,
      enumerable: true,
      get() {
        const live = materialize();
        const value = live?.schemaEnv;
        Object.defineProperty(fn, 'schemaEnv', { value, writable: true, enumerable: true, configurable: true });
        return value;
      },
    });
    cachedValidatorRootSchemaIds.set(fn, entry.rootSchemaId);
    if (id !== undefined) bc.byId.set(id, fn);
    return fn;
  }

  const schema = compactSchemaForValidation(envelope);
  const existing = typeof schema.$id === 'string' ? s.bundledAjv.getSchema(schema.$id) : undefined;
  let compiled: ValidateFunction;
  if (existing) {
    compiled = existing;
  } else {
    const result = compileBundledRecorded(s, bc, schema, true);
    compiled = result.compiled;
    if (result.moduleCode !== undefined) {
      bc.cache.write(
        key,
        result.moduleCode,
        typeof schema.$id === 'string' ? schema.$id : undefined,
        result.origins !== undefined ? { origins: result.origins } : undefined
      );
    }
  }
  if (id !== undefined) bc.byId.set(id, compiled);
  return compiled;
}

/**
 * {@link stateContentDigest} for keying cached tool validators, `undefined`
 * when the state cannot use the cache. A root the digest cannot read is left
 * to the registration that follows, which fails as it would without the cache.
 */
function cacheContentDigest(s: LoaderState): string | undefined {
  try {
    return stateContentDigest(s);
  } catch {
    s.contentDigest = null;
    return undefined;
  }
}

/**
 * Inputs of a state's registrations that its content digest does not show:
 * the order its directories list their files (the first of several files
 * with one $id wins) and the envelope fields response roots are widened with
 * (derived once per root path and process). Computed once per state.
 */
function registrationInputsDigest(s: LoaderState): string {
  if (s.registrationInputs !== undefined) return s.registrationInputs;
  const hash = createHash('sha256');
  for (const file of walkJsonFiles(s.root)) hash.update(`file\0${path.relative(s.root, file)}\0`);
  for (const [key, file] of s.fileIndex) hash.update(`index\0${key}\0${path.relative(s.root, file)}\0`);
  hash.update(`envelope\0${JSON.stringify([...envelopeFieldsForRelease(s.root, s.documents).fields])}`);
  s.registrationInputs = hash.digest('hex');
  return s.registrationInputs;
}

/**
 * The {@link CachedFunctions} of a state's registry, keyed by everything its
 * compiles read, or `undefined` when a key input cannot be read (the compile
 * then reports what it reports without the cache).
 */
function cachedFunctionsFor(
  s: LoaderState,
  bc: BundledValidatorCacheState,
  kind: 'modular-tool-validator' | 'canonical-tool-validator',
  digest: string
): CachedFunctions | undefined {
  const field = kind === 'modular-tool-validator' ? 'modularFunctions' : 'canonicalFunctions';
  if (s[field]) return s[field];
  let inputs: string;
  try {
    inputs = registrationInputsDigest(s);
  } catch {
    return undefined;
  }
  return (s[field] = {
    cache: bc.cache,
    keyParts: [kind, ...bundledValidatorCacheStaticKey(), s.version, digest, inputs],
    loaded: new Map(),
    stored: new Set(),
  });
}

/** Give a validator loaded from the cache the stock `schema` and a `schemaEnv` that compiles it live when read. */
function adoptCachedValidator(fn: ValidateFunction, schema: unknown, liveSchemaEnv: () => unknown): ValidateFunction {
  (fn as { schema?: unknown }).schema = schema;
  Object.defineProperty(fn, 'schemaEnv', {
    configurable: true,
    enumerable: true,
    get() {
      const value = liveSchemaEnv();
      Object.defineProperty(fn, 'schemaEnv', { value, writable: true, enumerable: true, configurable: true });
      return value;
    },
  });
  return fn;
}

/**
 * getValidator's modular branch with the cache enabled, after the state's
 * documents are registered. A modular validator is the registry's compile of
 * the document registered under the root's $id; with the functions it
 * reaches it is stored per function (see {@link CachedFunctions}). A hit
 * returns the loaded function, its `.schema` the registered document, after
 * replaying the origins the compile would have registered, so the state's
 * diagnostics are what compiling it leaves. A miss, or a root that is not
 * registered under its $id or is already compiled, compiles as stock.
 */
function resolveModularValidatorWithCache(
  s: LoaderState,
  bc: BundledValidatorCacheState,
  sources: CompiledSources,
  schema: LoadedSchema,
  digest: string | undefined
): ValidateFunction {
  const id = typeof schema.$id === 'string' ? schema.$id : undefined;
  const known = id !== undefined ? s.modularById?.get(id) : undefined;
  if (known) return known;
  const registered = id !== undefined ? registeredSchemaEnv(s.ajv, id) : undefined;
  const cf =
    id !== undefined && registered && !registered.validate && digest !== undefined && !s.coreLoadFailed
      ? cachedFunctionsFor(s, bc, 'modular-tool-validator', digest)
      : undefined;
  if (id === undefined || !registered || !cf || typeof registered.baseId !== 'string') {
    try {
      return (id !== undefined ? s.ajv.getSchema(id) : undefined) ?? s.ajv.compile(schema);
    } finally {
      drainCompiledSources(sources);
    }
  }

  const documentFor = (key: string): object | undefined => {
    const document = registeredSchemaEnv(s.ajv, key)?.schema;
    return document && typeof document === 'object' ? document : undefined;
  };
  const hit = loadCachedFunctions(cf, documentRootFunctionId(id, registered.baseId), documentFor, true);
  if (hit) {
    for (const [prefix, originSchema, schemaId] of hit.origins)
      s.diagnosticOrigins.replay(prefix, originSchema, schemaId);
    const fn = adoptCachedValidator(hit.fn, registered.schema, () => {
      try {
        return s.ajv.getSchema(id)?.schemaEnv;
      } finally {
        drainCompiledSources(sources);
      }
    });
    s.modularById?.set(id, fn);
    return fn;
  }

  let compiled: ValidateFunction;
  try {
    compiled = s.ajv.getSchema(id) ?? s.ajv.compile(schema);
  } finally {
    drainCompiledSources(sources);
  }
  if (compiled.schemaEnv === registered) {
    storeCompiledFunctions(
      cf,
      s.ajv,
      sources,
      compiled,
      s.diagnosticOrigins,
      () => !s.coreLoadFailed && contentUnchangedSinceDigest(s)
    );
  }
  s.modularById?.set(id, compiled);
  return compiled;
}

/**
 * getCanonicalToolValidatorForVersion with the cache enabled, for a document
 * the canonical registry registers under its $id; stored per function like a
 * modular validator (the canonical registry rewrites no origins). A hit does
 * the canonical registration's document scan and identity check (the same
 * throw) but adds nothing to an Ajv; the first miss builds the registry.
 */
function resolveCanonicalValidatorWithCache(
  state: LoaderState,
  bc: BundledValidatorCacheState,
  rawSchema: LoadedSchema,
  id: string
): ValidateFunction {
  const byId = (state.canonicalById ??= new Map());
  const known = byId.get(id);
  if (known) return known;
  const digest = cacheContentDigest(state);
  const compiledAlready = state.canonicalAjv ? registeredSchemaEnv(state.canonicalAjv, id)?.validate : undefined;
  const cf = digest !== undefined ? cachedFunctionsFor(state, bc, 'canonical-tool-validator', digest) : undefined;
  if (cf && !compiledAlready) {
    const documents = canonicalRegistryDocuments(state);
    const document = documents?.get(id);
    if (document === rawSchema) {
      const hit = loadCachedFunctions(
        cf,
        documentRootFunctionId(id, id.replace(/#\/?$/, '')),
        key => documents!.get(key),
        false
      );
      if (hit) {
        const fn = adoptCachedValidator(hit.fn, rawSchema, () => {
          try {
            return ensureCanonicalAjv(state).getSchema(id)?.schemaEnv;
          } finally {
            if (state.canonicalSources) drainCompiledSources(state.canonicalSources);
          }
        });
        byId.set(id, fn);
        return fn;
      }
    }
  }

  const ajv = ensureCanonicalAjv(state);
  const sources = state.canonicalSources;
  let existing: ValidateFunction | undefined;
  let compiled: ValidateFunction;
  try {
    existing = ajv.getSchema(id);
    compiled = existing ?? ajv.compile(rawSchema);
  } finally {
    if (sources) drainCompiledSources(sources);
  }
  if (
    cf &&
    sources &&
    existing !== undefined &&
    compiled.schema === rawSchema &&
    compiled.schemaEnv === registeredSchemaEnv(ajv, id)
  ) {
    storeCompiledFunctions(cf, ajv, sources, compiled, undefined, () => contentUnchangedSinceDigest(state));
  }
  byId.set(id, compiled);
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

/** Keep composition-only response envelope handling local to the selected tool. */
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
  // Its paired bundled tree provides a context-local composition to widen.
  return hasCompositionReference(readStoredDocument(state.documents, authoredFile)) ? indexedFile : authoredFile;
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
 * documents never receive envelope widening, so callers can publish
 * the protocol-authored schema verbatim from an on-demand discovery tool.
 * The document is deep-frozen and shared with every other reader of the
 * bundle, as {@link getSchemaDocumentByRef}'s are; copy it to modify it.
 */
export function getToolSchemaDocument(
  toolName: string,
  direction: Direction,
  version: string = ADCP_VERSION
): ResolvedToolSchemaDocument | undefined {
  const state = ensureInit(version);
  const file = state.fileIndex.get(`${toolName}::${direction}`);
  if (!file) return undefined;
  const schema = readStoredDocument(state.documents, file) as Record<string, unknown>;
  let resolvedVersion = state.version;
  try {
    const index = readStoredDocument(state.documents, path.join(state.root, 'index.json')) as Record<string, unknown>;
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
  // just like compiled validators. The store's documents are frozen and
  // shared, so domain audits can memoize by identity without allowing callers
  // to mutate a schema.
  const readDocument = (ref: string): Record<string, unknown> =>
    readStoredDocument(state.documents, path.join(state.root, ref));

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

  const documents = documentStore(bundleKey, root);
  if (!keywords && !projection && isSchemaRefRegistryDocument(file)) {
    const authored = identity33ReferenceSchema(readStoredDocument(documents, file), version);
    if (typeof authored.$id === 'string') {
      const registry = schemaRefRegistry(documents, root, version, allErrors);
      if (registry.ids.has(authored.$id)) {
        // A shallow copy compiles as the caller's own function, so no other
        // validator's internal $ref call writes its `errors`; the sub-schemas it
        // refers to compile once per registry.
        const compiled = registry.ajv.compile({ ...authored });
        cache.set(cacheKey, compiled);
        return compiled;
      }
    }
  }

  // Keep an isolated AJV instance for custom keywords, projected roots and
  // roots outside the documents a registry holds (bundled/, transport
  // projections). Tool response validators widen closed pre-composition
  // roots for SDK back-compat; webhook payload schemas need strict raw JSON
  // Schema behavior without polluting the shared tool-validator registry
  // with widened response schemas.
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
  const authoredSchema = identity33ReferenceSchema(readStoredDocument(documents, file), version);
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
    const schema = identity33ReferenceSchema(readStoredDocument(documents, schemaFile), version);
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
  if (keywords) {
    // A keyword's metaSchema takes part in meta-validation here.
    if (dependencySchemas.length > 0) ajv.addSchema(dependencySchemas);
  } else {
    for (const schema of dependencySchemas) addPlainRegistryDocument(ajv, schema);
  }
  const compiled = ajv.compile(rawSchema);
  cache.set(cacheKey, compiled);
  return compiled;
}

/** One Ajv holding a root's runtime documents for schema-ref validators with one option set. */
interface SchemaRefRegistry {
  ajv: Ajv;
  /** The `$id`s registered in `ajv`. */
  ids: Set<string>;
}

/**
 * Schema-ref registries by the document store they were built from, so a
 * registry is dropped with the store: when any bundle key that used the root
 * is cleared, the next miss builds both again from the files.
 */
const schemaRefRegistries = new WeakMap<DocumentStore, Map<string, SchemaRefRegistry>>();

/** Whether `file` is one of the runtime documents a schema-ref registry holds. */
function isSchemaRefRegistryDocument(file: string): boolean {
  if (file.includes(`${path.sep}bundled${path.sep}`)) return false;
  return ![...TRANSPORT_PROJECTION_DIRECTORIES].some(directory => file.includes(`${path.sep}${directory}${path.sep}`));
}

/**
 * The root's schema-ref registry for `allErrors` and the identity-3.3 scope in
 * effect, built on first use: the documents a per-ref Ajv registered as
 * dependencies (every runtime document with an `$id`, one per `$id`), added
 * one at a time in walk order, with the same ambiguity check. Stored only once
 * it is complete, so a failure is thrown again on the next call.
 * `addUsedSchema: false` keeps compiled roots out of the registry.
 */
function schemaRefRegistry(
  documents: DocumentStore,
  root: string,
  version: string,
  allErrors: boolean
): SchemaRefRegistry {
  const identity33 = isIdentity33SchemaScope() && resolveBundleKey(version) === '3.3';
  const key = `all-errors::${allErrors}\0identity33::${identity33}`;
  let registries = schemaRefRegistries.get(documents);
  if (!registries) {
    registries = new Map();
    schemaRefRegistries.set(documents, registries);
  }
  const existing = registries.get(key);
  if (existing) return existing;

  const byId = new Map<string, LoadedSchema>();
  for (const schemaFile of walkJsonFiles(root)) {
    if (!isSchemaRefRegistryDocument(schemaFile)) continue;
    const schema = identity33ReferenceSchema(readStoredDocument(documents, schemaFile), version);
    if (typeof schema.$id !== 'string') continue;
    const previous = byId.get(schema.$id);
    if (previous) {
      // Bundles intentionally mirror async-response refs. Identical copies
      // are harmless; conflicting definitions must not shadow audited files.
      if (!isDeepStrictEqual(previous, schema)) {
        throw new ConfigurationError('Schema validation requires unambiguous schema identities', 'schemaRoot');
      }
      continue;
    }
    byId.set(schema.$id, schema);
  }
  const ajv = new Ajv({
    inlineRefs: false,
    strict: false,
    // See compileSchemaReference: first-violation by default for remote payloads.
    allErrors,
    allowUnionTypes: true,
    addUsedSchema: false,
  });
  addFormats(ajv);
  for (const schema of byId.values()) addPlainRegistryDocument(ajv, schema);
  const registry = { ajv, ids: new Set(byId.keys()) };
  registries.set(key, registry);
  return registry;
}

/**
 * Compile a tool schema without the per-release envelope widening used by the SDK's
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
  const rawSchema = readStoredDocument(state.documents, file);
  // External/legacy schema roots may contain only self-contained bundled
  // contracts. They have no authored graph to pre-register, so compile the
  // strict bundled fallback lazily after removing nested metadata `$id`s.
  const fromBundled = file.includes(`${path.sep}bundled${path.sep}`);
  if (state.bundledCache && !fromBundled && typeof rawSchema.$id === 'string') {
    const resolved = resolveCanonicalValidatorWithCache(state, state.bundledCache, rawSchema, rawSchema.$id);
    state.canonicalValidators.set(cacheKey, resolved);
    return resolved;
  }
  const ajv = ensureCanonicalAjv(state);
  let compiled: ValidateFunction;
  try {
    const existing = typeof rawSchema.$id === 'string' ? ajv.getSchema(rawSchema.$id) : undefined;
    compiled = existing ?? ajv.compile(fromBundled ? compactSchemaForValidation(stripNestedIds(rawSchema)) : rawSchema);
  } finally {
    // With the cache enabled the registry records sources; returned functions keep none.
    if (state.canonicalSources) drainCompiledSources(state.canonicalSources);
  }
  state.canonicalValidators.set(cacheKey, compiled);
  return compiled;
}

/**
 * The documents canonical registration adds, by $id, in registration order.
 * Throws when two of them share an $id with different content.
 */
function scanCanonicalSchemas(state: LoaderState): Map<string, LoadedSchema> {
  const schemasById = new Map<string, LoadedSchema>();
  for (const schemaFile of walkJsonFiles(state.root)) {
    if (schemaFile.includes(`${path.sep}bundled${path.sep}`)) continue;
    if (
      [...TRANSPORT_PROJECTION_DIRECTORIES].some(directory => schemaFile.includes(`${path.sep}${directory}${path.sep}`))
    ) {
      continue;
    }

    const schema = readStoredDocument(state.documents, schemaFile);
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
  return schemasById;
}

/**
 * {@link scanCanonicalSchemas} for canonical cache hits, kept once it
 * succeeds; a failing scan runs again on the next call, as registration does.
 */
function canonicalSchemasById(state: LoaderState): Map<string, LoadedSchema> {
  return (state.canonicalDocuments ??= scanCanonicalSchemas(state));
}

/**
 * The canonical registry's documents by registry key, without building it, or
 * `undefined` when two $ids share a key (registration then fails in Ajv).
 * Throws what canonical registration throws.
 */
function canonicalRegistryDocuments(state: LoaderState): Map<string, LoadedSchema> | undefined {
  const schemasById = canonicalSchemasById(state);
  if (canonicalRegistryKeys.has(schemasById)) return canonicalRegistryKeys.get(schemasById) ?? undefined;
  let byKey: Map<string, LoadedSchema> | null = new Map();
  for (const [id, schema] of schemasById) {
    const key = id.replace(/#\/?$/, '');
    if (byKey.has(key)) {
      byKey = null;
      break;
    }
    byKey.set(key, schema);
  }
  canonicalRegistryKeys.set(schemasById, byKey);
  return byKey ?? undefined;
}
const canonicalRegistryKeys = new WeakMap<Map<string, LoadedSchema>, Map<string, LoadedSchema> | null>();

function ensureCanonicalAjv(state: LoaderState): Ajv {
  if (state.canonicalAjv) return state.canonicalAjv;

  // With the cache enabled, keep each function's source off the function, as for the modular registry.
  const sources: CompiledSources | undefined = state.bundledCache
    ? { pending: [], byFunction: new WeakMap() }
    : undefined;
  const ajv = new Ajv({
    inlineRefs: false,
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
    ...(sources && { code: { source: true, process: recordingCodeProcess(sources) } }),
  });
  addFormats(ajv);
  if (sources) recordRegistryLookups(ajv, sources);

  const schemasById = scanCanonicalSchemas(state);
  try {
    for (const schema of schemasById.values()) addPlainRegistryDocument(ajv, schema);
  } finally {
    if (sources) drainCompiledSources(sources);
  }
  state.canonicalAjv = ajv;
  if (sources) state.canonicalSources = sources;
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
  flushDeferredCompiles(s);
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
 * `'3.2.5'`, `'3.3.0-rc.3'`); values are schema-data roots in the same
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
      const reads = newRootCheckReads(root);
      if (!hasSchemaRootShape(root, reads)) {
        throw new Error(`Served-release AdCP schema root for version "${version}" not found or empty at ${root}`);
      }
      aliases = assertSchemaRootMatchesVersion(version, root, reads);
      persistRootCheck(reads);
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
    documentStores.clear();
    epochRootFingerprints.clear();
    rootDocumentIdentityCache().clear();
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
 * are not traversed. The document comes from the state's document store, so
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
    const schema = readStoredDocument(s.documents, file);
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

    const root = readStoredDocument(s.documents, file) as Record<string, unknown>;
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
              const schema = readStoredDocument(s.documents, schemaFile);
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
      const document = readStoredDocument(s.documents, targetFile) as Record<string, unknown>;
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

    const file = path.join(s.root, normalized);
    if (!existsSync(file)) return undefined;

    const schema = readStoredDocument(s.documents, file);
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

// Bind this module instance (CJS or ESM build) so envelope-status checks read
// the same root registry as callers of this loader (adcp-client#3529).
bindEnvelopeSchemaLoader({ responseSchemaComposesEnvelope, isExternalSchemaRootActive });
