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
import { ConfigurationError } from '../errors';

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
  // `'3.1-beta.0.*'`. Sort newest-first by directory name (lexicographic
  // is a good-enough proxy; proper SemVer §11 prerelease ordering can come
  // later if it bites in practice).
  const releasePrecisionMatch = /^\d+\.\d+-/.test(key);
  if (releasePrecisionMatch && existsSync(cacheRoot)) {
    const cached = readdirSync(cacheRoot, { withFileTypes: true })
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
      .sort((a, b) => b.name.localeCompare(a.name));
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
  // Tool RESPONSE files only — those need lazy compile through `getValidator`
  // so `relaxResponseRoot` can apply. Tool REQUEST files and unclassified
  // fragments are safe to pre-register: requests don't need root-level
  // relaxation, and fragments registered here are exactly what cross-tool
  // `$ref`s expect to find by `$id`.
  //
  // Why this matters: bundles whose source tree doesn't include a `bundled/`
  // pre-resolved subtree (e.g. v2.5, where the spec ships flat schemas with
  // unresolved `$ref`s) classify fragments like `media-buy/package-request.json`
  // as tool `package::request` via the filename-suffix heuristic in
  // `buildFileIndex`. Skipping all tool files would leave that fragment
  // unregistered, so a later compile of `create_media_buy` fails on
  // `MissingRefError: can't resolve /schemas/media-buy/package-request.json`.
  const responseToolFiles = new Set<string>();
  for (const [key, file] of s.fileIndex) {
    if (key.endsWith('::request')) continue;
    responseToolFiles.add(file);
  }
  for (const entry of readdirSync(s.root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'bundled') continue;
    const abs = path.join(s.root, entry.name);
    for (const file of walkJsonFiles(abs)) {
      if (responseToolFiles.has(file)) continue;
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
  // Bundled files inline every referenced subschema with the original
  // canonical `$id` (e.g. `core/version-envelope.json` appears nested
  // inside every bundled tool response). Bundled files carry NO
  // internal `$ref`s — the spec publishes them fully resolved, see
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
  const schema = direction === 'request' ? prepared : relaxResponseRoot(prepared);
  const existing = typeof schema.$id === 'string' ? s.ajv.getSchema(schema.$id) : undefined;
  const compiled = existing ?? s.ajv.compile(schema);
  s.validators.set(cacheKey, compiled);
  return compiled;
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
  return registry ? Object.keys(registry) : [];
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
