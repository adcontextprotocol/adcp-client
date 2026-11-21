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
 * Derived from the active schema-loader authority, one tool at a time: a
 * lookup reads only that tool's response schema, and results are memoised
 * by bundle key and resolved root, with loader-epoch invalidation so scoped
 * or re-registered candidate bundles cannot leak. Raw external roots use the
 * loader's response index when no bundled store exists.
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
  getSchemaLoaderGeneration,
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
 * What one (bundle key, resolved root) offers for Error-arm lookups, built
 * on the first lookup and kept for the loader generation: the manifest's
 * tool set and, for a bundled store, every `*-response.json` grouped by the
 * tool name its filename stem gives (`create-media-buy` → `create_media_buy`),
 * in the store's listing order. Raw external roots without a bundled store
 * read responses through the loader's response index instead.
 */
interface RootIndex {
  root: string;
  version: string;
  manifestTools: ReadonlySet<string> | undefined;
  responseFiles: ReadonlyMap<string, readonly string[]> | undefined;
  descriptors: Map<string, ErrorArmDescriptor | null>;
  inventory?: ReadonlyMap<string, ErrorArmDescriptor>;
}

function readManifestTools(root: string): ReadonlySet<string> | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf-8')) as {
      tools?: Record<string, unknown>;
    };
    return manifest.tools ? new Set(Object.keys(manifest.tools)) : undefined;
  } catch {
    // Older bundles may not carry a manifest. Preserve the filename-driven
    // fallback for those versions; current bundles always take the stricter
    // manifest path.
    return undefined;
  }
}

function listResponseFiles(root: string): ReadonlyMap<string, readonly string[]> | undefined {
  const bundledRoot = path.join(root, 'bundled');
  if (!hasBundledSchemaStore(bundledRoot)) return undefined;
  const byTool = new Map<string, string[]>();
  for (const file of listBundledSchemaFiles(bundledRoot)) {
    if (!file.endsWith('-response.json')) continue;
    const toolName = path.basename(file, '-response.json').replace(/-/g, '_');
    const files = byTool.get(toolName);
    if (files) files.push(file);
    else byTool.set(toolName, [file]);
  }
  return byTool;
}

function describeResponse(schema: Record<string, unknown>): ErrorArmDescriptor | undefined {
  const branches = (schema.oneOf ?? schema.anyOf) as unknown[] | undefined;
  if (!Array.isArray(branches)) return undefined;
  for (const branch of branches) {
    const candidate = describeErrorArm(branch, schema);
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Read only `toolName`'s response schema(s). When a bundle ships two
 * response files for one tool name (`list_creative_formats` lives in both
 * `creative/` and `media-buy/`), the last file in listing order that
 * declares an Error arm wins, as the whole-root inventory always resolved it.
 * Bundles contain helper response schemas (for example
 * media-buy-commitment-response.json) that are not dispatchable tools, so
 * a manifest, when present, must declare the tool.
 */
function resolveDescriptor(index: RootIndex, toolName: string): ErrorArmDescriptor | undefined {
  if (index.manifestTools && !index.manifestTools.has(toolName)) return undefined;
  if (!index.responseFiles) {
    try {
      const schema = getToolSchemaDocument(toolName, 'sync', index.version)?.schema;
      return schema ? describeResponse(schema) : undefined;
    } catch {
      return undefined;
    }
  }
  let descriptor: ErrorArmDescriptor | undefined;
  for (const file of index.responseFiles.get(toolName) ?? []) {
    let schema: Record<string, unknown> | undefined;
    try {
      schema = loadBundledSchemaFile(file);
    } catch {
      continue;
    }
    const candidate = schema ? describeResponse(schema) : undefined;
    if (candidate) descriptor = candidate;
  }
  return descriptor;
}

/** Root indexes of the active schema authority, isolated by version, root and loader epoch. */
let cachedGeneration = -1;
const cachedIndexes = new Map<string, RootIndex>();

function activeRootIndex(version: string): RootIndex | undefined {
  const bundleKey = resolveBundleKey(version);
  let root: string;
  try {
    root = resolveSchemaRoot(version);
  } catch {
    return undefined;
  }
  const generation = getSchemaLoaderGeneration();
  if (cachedGeneration !== generation) {
    cachedIndexes.clear();
    cachedGeneration = generation;
  }
  const key = `${bundleKey}\0${path.resolve(root)}`;
  let index = cachedIndexes.get(key);
  if (!index) {
    index = {
      root,
      version,
      manifestTools: readManifestTools(root),
      responseFiles: listResponseFiles(root),
      descriptors: new Map(),
    };
    cachedIndexes.set(key, index);
  }
  return index;
}

/**
 * Error-arm descriptor of `toolName`'s response schema at `version`, or
 * undefined when the response declares no top-level Error arm requiring
 * `errors[]`. Dispatcher-side gate for two-layer auto-emission, plus the
 * per-arm constants the dispatcher sets when synthesising the wrap.
 *
 * Reads only that tool's response schema, once per loader generation.
 * Missing roots return undefined without caching, so later external
 * registration takes effect. Re-registering or entering another schema
 * scope starts a new generation, including replacements of candidate
 * bundles at the same path.
 */
export function getErrorArmDescriptor(
  toolName: string,
  version: string = ADCP_VERSION
): ErrorArmDescriptor | undefined {
  const index = activeRootIndex(version);
  if (!index) return undefined;
  const cached = index.descriptors.get(toolName);
  if (cached !== undefined) return cached ?? undefined;
  const descriptor = resolveDescriptor(index, toolName);
  index.descriptors.set(toolName, descriptor ?? null);
  return descriptor;
}

/**
 * Every tool at `version` whose response declares an Error arm, built from
 * the same per-tool lookups and cache as {@link getErrorArmDescriptor}. Tool
 * names come from the bundled store's response files, or from the loader's
 * response index for raw external roots. For audits and tests; the
 * dispatcher looks tools up one at a time.
 */
export function getToolsWithErrorArm(version: string = ADCP_VERSION): ReadonlyMap<string, ErrorArmDescriptor> {
  const index = activeRootIndex(version);
  if (!index) return new Map();
  if (index.inventory) return index.inventory;
  const names = index.responseFiles
    ? [...index.responseFiles.keys()]
    : listValidatorKeys(version)
        .filter(key => key.endsWith('::sync'))
        .map(key => key.slice(0, -'::sync'.length));
  const map = new Map<string, ErrorArmDescriptor>();
  for (const toolName of names) {
    const descriptor = getErrorArmDescriptor(toolName, version);
    if (descriptor) map.set(toolName, descriptor);
  }
  index.inventory = map;
  return map;
}

/** Test hook: clear cached error-arm lookups. */
export function _resetErrorArmToolsCache(): void {
  cachedIndexes.clear();
}
