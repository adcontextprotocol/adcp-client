/**
 * JSON Schema loader for AdCP tool request/response validation.
 *
 * Loads the bundled per-tool schemas shipped with the SDK plus the
 * `core/` schemas that async response variants `$ref`, then compiles
 * AJV validators lazily by `(toolName, direction)`.
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
 * Resolve the directory that holds the bundled + core schemas copied into
 * the package at build time. Source layout (dev):
 *   schemas/cache/<ver>/{bundled,core}
 * Built layout (dist):
 *   dist/lib/schemas-data/<ver>/{bundled,core}
 */
function resolveSchemaRoot(): string {
  const distCandidate = path.join(__dirname, '..', 'schemas-data', ADCP_VERSION);
  if (existsSync(distCandidate)) return distCandidate;

  const srcCandidate = path.join(__dirname, '..', '..', '..', 'schemas', 'cache', ADCP_VERSION);
  if (existsSync(srcCandidate)) return srcCandidate;

  throw new Error(
    `AdCP schema data not found. Looked in ${distCandidate} and ${srcCandidate}. ` +
      `Run \`npm run sync-schemas\` and \`npm run build:lib\`.`
  );
}

interface LoaderState {
  ajv: Ajv;
  fileIndex: Map<string, string>;
  validators: Map<string, ValidateFunction>;
  root: string;
  coreLoaded: boolean;
}

let state: LoaderState | undefined;

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
 * tools (the property-list family), which rejects `replayed: false`.
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

  // Async variants aren't bundled upstream — they live in the flat per-domain
  // directory with $refs to core/context.json and core/ext.json.
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
      }
    }
  }

  return index;
}

function ensureInit(): LoaderState {
  if (state) return state;

  const root = resolveSchemaRoot();
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  state = {
    ajv,
    fileIndex: buildFileIndex(root),
    validators: new Map(),
    root,
    coreLoaded: false,
  };
  return state;
}

/**
 * Lazily load `core/` schemas on first compile of an async response variant.
 * Deferring keeps cold-start cheap for the common case (sync request/response).
 */
function ensureCoreLoaded(s: LoaderState): void {
  if (s.coreLoaded) return;
  const coreDir = path.join(s.root, 'core');
  for (const file of walkJsonFiles(coreDir)) {
    const schema = loadJson(file);
    if (typeof schema.$id === 'string' && !s.ajv.getSchema(schema.$id)) {
      s.ajv.addSchema(schema);
    }
  }
  s.coreLoaded = true;
}

/**
 * Look up the compiled AJV validator for a given tool + direction.
 * Returns `undefined` when no schema exists for the pair — callers can
 * skip validation cleanly (e.g., custom tools outside the AdCP spec).
 */
export function getValidator(toolName: string, direction: Direction): ValidateFunction | undefined {
  const s = ensureInit();
  const cacheKey = `${toolName}::${direction}`;
  const cached = s.validators.get(cacheKey);
  if (cached) return cached;

  const file = s.fileIndex.get(cacheKey);
  if (!file) return undefined;

  // Async response variants $ref into core/ — only pay that load cost when
  // we're actually about to compile one.
  if (direction !== 'request' && direction !== 'sync') {
    ensureCoreLoaded(s);
  }

  const rawSchema = loadJson(file);
  const schema = direction === 'request' ? rawSchema : relaxResponseRoot(rawSchema);
  const existing = typeof schema.$id === 'string' ? s.ajv.getSchema(schema.$id) : undefined;
  const compiled = existing ?? s.ajv.compile(schema);
  s.validators.set(cacheKey, compiled);
  return compiled;
}

/** List of (toolName, direction) pairs that have schemas. Used by tests. */
export function listValidatorKeys(): string[] {
  const s = ensureInit();
  return [...s.fileIndex.keys()].sort();
}

/** Suffix used in the suffix table — exported for testing. */
export { SCHEMA_FILENAME_SUFFIX };

/** Test hook: reset cached state so a fresh init runs. */
export function _resetValidationLoader(): void {
  state = undefined;
}
