/**
 * Per-AdCP-version registry of tool names whose response schema declares
 * a typed Error arm — i.e. an arm of the top-level `oneOf` / `anyOf`
 * whose `required` includes `"errors"`.
 *
 * The dispatcher uses this set to decide whether to auto-emit the
 * payload-layer `errors[]` array alongside the envelope-layer
 * `{adcp_error}` block on the failure path. Tools NOT in this set keep
 * the envelope-only shape — surfacing `errors[]` on a tool whose
 * response schema doesn't define it would add a key the schema
 * doesn't expect.
 *
 * Built lazily at first use from the bundled schema cache (the same
 * tree `schema-loader.ts` reads). The set is computed once per bundle
 * key (`resolveBundleKey('3.0.0')` → `'3.0'`) and memoised — the schema
 * tree is read-only at runtime, so a single scan is sufficient.
 *
 * Spec basis: `error-code.json#GOVERNANCE_DENIED` and
 * `#GOVERNANCE_UNAVAILABLE` both prescribe "populate `errors[].code` in
 * the payload AND `adcp_error.code` on the envelope per the two-layer
 * model" for tasks whose response defines a typed Error arm but no
 * structured rejection arm. RFC: `docs/proposals/adcperror-two-layer-emission.md`.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { ADCP_VERSION } from '../version';
import { resolveBundleKey } from '../validation/schema-loader';
import { getSchemaDataRoots } from '../internal/schema-data-roots';

/**
 * Resolve the schema-cache root for a given AdCP version.
 *
 * Mirrors `schema-loader.ts:resolveSchemaRoot` so the two-layer scan
 * reads from the same directory the AJV validators compile against.
 * Kept as a private duplicate (rather than exporting from schema-loader)
 * to keep the schema-loader's public surface narrow — that module is
 * about validators, not generic cache traversal.
 *
 * Returns `undefined` when no bundle exists for the version. The
 * dispatcher gates on a non-empty set, so a missing bundle silently
 * disables the auto-wrap (callers without schemas can't have tools to
 * wrap anyway).
 */
function resolveBundledRoot(version: string): string | undefined {
  const key = resolveBundleKey(version);
  const { builtSchemasDataRoot, sourceSchemasCacheRoot } = getSchemaDataRoots();
  // Built layout (dist): dist/lib/schemas-data/<bundle-key>/bundled
  const distCandidate = path.join(builtSchemasDataRoot, key, 'bundled');
  if (existsSync(distCandidate)) return distCandidate;

  // Source-tree layout (dev): schemas/cache/<exact-version>/bundled
  const cacheRoot = sourceSchemasCacheRoot;
  const exactCandidate = path.join(cacheRoot, version, 'bundled');
  if (existsSync(exactCandidate)) return exactCandidate;

  // Latest-patch fallback for stable minor pins (matches schema-loader).
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
      .map(e => ({ name: e.name, patch: parseInt(e.name.slice(prefix.length), 10) }))
      .filter(c => Number.isFinite(c.patch))
      .sort((a, b) => b.patch - a.patch);
    if (cached.length > 0) {
      return path.join(cacheRoot, cached[0]!.name, 'bundled');
    }
  }
  return undefined;
}

/**
 * Per-tool descriptor for two-layer auto-emission.
 *
 * `extraRequired` carries any `oneOf`-discriminator constants the error
 * arm requires beyond `errors[]` itself — e.g. `update_content_standards`
 * declares `required: ["success", "errors"]` with `success: { const: false }`.
 * The dispatcher applies these as constants when synthesising the error
 * arm so the resulting payload satisfies its own response schema.
 *
 * The vast majority of Error-arm tools have `required: ["errors"]` only
 * (no discriminator), so `extraRequired` is empty and the wrap is a
 * trivial `{errors: [...]}` projection.
 */
export interface ErrorArmDescriptor {
  /** `{[fieldName]: constValue}` for each `const`-typed required field. */
  extraRequired: Readonly<Record<string, unknown>>;
}

/**
 * Resolve a `oneOf`/`anyOf` arm one level of `$ref` indirection. Bundled
 * schemas inline most refs but a few domains keep an extra hop into
 * `$defs`/`definitions`.
 */
function resolveBranch(branch: unknown, rootSchema: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!branch || typeof branch !== 'object') return undefined;
  const obj = branch as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === 'string') {
    const match = ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
    if (match && match[1] && match[2]) {
      const root = rootSchema[match[1]] as Record<string, unknown> | undefined;
      const target = root?.[match[2]];
      if (target && typeof target === 'object') return target as Record<string, unknown>;
    }
    return undefined;
  }
  return obj;
}

/**
 * Inspect a branch and, if it declares `required: [..., "errors", ...]`,
 * return its descriptor (capturing any sibling `const`-typed required
 * fields). Returns undefined for branches that don't require `errors[]`
 * or for rejection arms (`AcquireRightsRejected` / `CreativeRejected`)
 * which declare `not: { required: ["errors"] }` and explicitly forbid
 * the two-layer wire (RFC § 1.2).
 */
function describeErrorArm(branch: unknown, rootSchema: Record<string, unknown>): ErrorArmDescriptor | undefined {
  const resolved = resolveBranch(branch, rootSchema);
  if (!resolved) return undefined;
  const required = resolved.required;
  if (!Array.isArray(required) || !required.includes('errors')) return undefined;

  const extraRequired: Record<string, unknown> = {};
  const properties = resolved.properties as Record<string, unknown> | undefined;
  if (properties) {
    for (const fieldName of required) {
      if (typeof fieldName !== 'string' || fieldName === 'errors') continue;
      const propSchema = properties[fieldName] as Record<string, unknown> | undefined;
      if (propSchema && 'const' in propSchema) {
        extraRequired[fieldName] = propSchema.const;
      }
      // Required fields without a `const` discriminator (e.g. dynamic
      // values) can't be auto-synthesised. The spec convention for
      // Error arms is `errors[]` plus optional `success`/`response_type`
      // constants — so far no tool requires anything else.
    }
  }
  return { extraRequired: Object.freeze(extraRequired) };
}

/**
 * Read every `*-response.json` under the bundled cache root and return
 * a tool-name → descriptor map for tools whose top-level `oneOf`/`anyOf`
 * declares an Error arm.
 *
 * Tool names are derived from the filename stem (`create-media-buy` →
 * `create_media_buy`) to match the dispatcher's `toolName` key.
 */
function scanForErrorArmTools(bundledRoot: string): Map<string, ErrorArmDescriptor> {
  const map = new Map<string, ErrorArmDescriptor>();
  const files: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('-response.json')) {
        files.push(full);
      }
    }
  }
  walk(bundledRoot);

  for (const file of files) {
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const branches = (schema.oneOf ?? schema.anyOf) as unknown[] | undefined;
    if (!Array.isArray(branches)) continue;
    let descriptor: ErrorArmDescriptor | undefined;
    for (const branch of branches) {
      const candidate = describeErrorArm(branch, schema);
      if (candidate) {
        descriptor = candidate;
        break;
      }
    }
    if (!descriptor) continue;
    const base = path.basename(file, '-response.json');
    const toolName = base.replace(/-/g, '_');
    map.set(toolName, descriptor);
  }
  return map;
}

/** Memoised per-bundle-key result. Empty map when the bundle is missing. */
const cachedMaps = new Map<string, ReadonlyMap<string, ErrorArmDescriptor>>();

/**
 * Per-tool descriptors for tools whose response schema (at `version`)
 * declares a top-level Error arm requiring `errors[]`. Dispatcher-side
 * gate for two-layer auto-emission, plus the per-arm constants the
 * dispatcher needs to set when synthesising the wrap.
 *
 * Scans the bundled schema cache lazily on first call per bundle key
 * (one read per minor version per process). Returns a frozen, empty map
 * when no schema bundle is reachable — the dispatcher early-returns on
 * `map.size === 0`, so a missing bundle silently disables the wrap
 * rather than breaking server startup.
 */
export function getToolsWithErrorArm(version: string = ADCP_VERSION): ReadonlyMap<string, ErrorArmDescriptor> {
  const key = resolveBundleKey(version);
  const cached = cachedMaps.get(key);
  if (cached) return cached;
  const root = resolveBundledRoot(version);
  if (!root) {
    const empty: ReadonlyMap<string, ErrorArmDescriptor> = new Map();
    cachedMaps.set(key, empty);
    return empty;
  }
  const map = scanForErrorArmTools(root);
  cachedMaps.set(key, map);
  return map;
}

/** Test hook: clear the per-bundle-key cache. */
export function _resetErrorArmToolsCache(): void {
  cachedMaps.clear();
}
