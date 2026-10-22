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
 * Derived from the active schema-loader authority. Installed bundles are
 * memoised by bundle key and resolved root; caller-supplied roots are
 * rescanned so scoped or re-registered candidate bundles cannot leak.
 * Raw external roots use the loader's response index when no bundled
 * store exists.
 *
 * Spec basis: `error-code.json#GOVERNANCE_DENIED` and
 * `#GOVERNANCE_UNAVAILABLE` both prescribe "populate `errors[].code` in
 * the payload AND `adcp_error.code` on the envelope per the two-layer
 * model" for tasks whose response defines a typed Error arm but no
 * structured rejection arm. RFC: `docs/proposals/adcperror-two-layer-emission.md`.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { ADCP_VERSION } from '../version';
import {
  getToolSchemaDocument,
  isExternalSchemaRootActive,
  listValidatorKeys,
  resolveBundleKey,
  resolveSchemaRoot,
} from '../validation/schema-loader';
import {
  hasBundledSchemaStore,
  listBundledSchemaFiles,
  loadBundledSchemaFile,
} from '../validation/bundled-schema-store';

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
 * Read bundled responses, or indexed responses for raw external roots,
 * and return a tool-name → descriptor map for tools whose top-level
 * `oneOf`/`anyOf` declares an Error arm.
 *
 * Tool names are derived from the filename stem (`create-media-buy` →
 * `create_media_buy`) to match the dispatcher's `toolName` key.
 */
function scanForErrorArmTools(root: string, version: string): Map<string, ErrorArmDescriptor> {
  const bundledRoot = path.join(root, 'bundled');
  const map = new Map<string, ErrorArmDescriptor>();
  let manifestTools: ReadonlySet<string> | undefined;
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf-8')) as {
      tools?: Record<string, unknown>;
    };
    if (manifest.tools) manifestTools = new Set(Object.keys(manifest.tools));
  } catch {
    // Older bundles may not carry a manifest. Preserve the filename-driven
    // fallback for those versions; current bundles always take the stricter
    // manifest path below.
  }
  const bundled = hasBundledSchemaStore(bundledRoot);
  // Preserve the packaged bundle's existing inventory. Raw external roots
  // use the same domain/response selection as runtime validation.
  const responses = bundled
    ? listBundledSchemaFiles(bundledRoot)
        .filter(file => file.endsWith('-response.json'))
        .map(file => ({ toolName: path.basename(file, '-response.json').replace(/-/g, '_'), file }))
    : listValidatorKeys(version)
        .filter(key => key.endsWith('::sync'))
        .map(key => ({ toolName: key.slice(0, -'::sync'.length), file: undefined }));

  for (const { toolName, file } of responses) {
    let schema: Record<string, unknown>;
    try {
      const loaded = file ? loadBundledSchemaFile(file) : getToolSchemaDocument(toolName, 'sync', version)?.schema;
      if (!loaded) continue;
      schema = loaded;
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
    // Bundles contain helper response schemas (for example
    // media-buy-commitment-response.json) that are not dispatchable tools.
    // Only manifest-declared tools belong in the runtime wrapping registry.
    if (manifestTools && !manifestTools.has(toolName)) continue;
    map.set(toolName, descriptor);
  }
  return map;
}

/** Memoised installed bundle results, isolated by version and resolved root. */
const cachedMaps = new Map<string, ReadonlyMap<string, ErrorArmDescriptor>>();

/**
 * Per-tool descriptors for tools whose response schema (at `version`)
 * declares a top-level Error arm requiring `errors[]`. Dispatcher-side
 * gate for two-layer auto-emission, plus the per-arm constants the
 * dispatcher needs to set when synthesising the wrap.
 *
 * Scans the active schema authority lazily. Missing roots return an empty map
 * without caching, so later external registration takes effect. External roots
 * are not memoised: callers may replace a candidate bundle at the same path.
 */
export function getToolsWithErrorArm(version: string = ADCP_VERSION): ReadonlyMap<string, ErrorArmDescriptor> {
  const bundleKey = resolveBundleKey(version);
  let root: string;
  try {
    root = resolveSchemaRoot(version);
  } catch {
    return new Map();
  }
  const external = isExternalSchemaRootActive(version);
  const key = `${bundleKey}\0${path.resolve(root)}`;
  const cached = external ? undefined : cachedMaps.get(key);
  if (cached) return cached;
  const map = scanForErrorArmTools(root, version);
  if (!external) cachedMaps.set(key, map);
  return map;
}

/** Test hook: clear the installed bundle cache. */
export function _resetErrorArmToolsCache(): void {
  cachedMaps.clear();
}
