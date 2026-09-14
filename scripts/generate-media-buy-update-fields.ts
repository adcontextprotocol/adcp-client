#!/usr/bin/env tsx
//
// Reads the normative action -> `update_media_buy` field binding
// (`enumMetadata`) off the upstream schemas and emits a TypeScript constant
// the preflight helpers consume.
//
// Two schemas carry the binding and MUST be merged (upstream `$comment` on
// `media-buy-valid-action.json#/enumMetadata`; adcontextprotocol/adcp#7449):
//
//   - `enums/media-buy-valid-action.json` — the deprecated flat
//     `valid_actions[]` vocabulary. Still authoritative for its own values.
//   - `core/media-buy-available-action-id.json` — the structured
//     `available_actions[].action` id: an `anyOf` of the legacy enum plus
//     structured-only consts (e.g. `update_media_buy_frequency_cap`, AdCP 3.2)
//     whose bindings live ONLY in this schema's `enumMetadata`.
//
// Merge rules: rows follow the legacy enum order, then structured-only ids in
// `anyOf` order. Legacy metadata wins on shared keys, but a key that appears in
// both blocks with different metadata aborts generation (that is upstream
// drift, not something to paper over). Schema caches that predate the id
// schema (AdCP <= 3.2.0-rc.2) emit the legacy-only table so older pins keep
// regenerating.
//
// Run when the schema cache version moves forward or when upstream touches
// the action -> field mapping. The output file is checked in so consumers
// don't pay a schema-load cost at runtime.
//
// Usage:
//   npx tsx scripts/generate-media-buy-update-fields.ts
//
// Default source: ADCP_VERSION pinned schema cache in schemas/cache/<version>.
// Overrides:
//   SCHEMA_DIR   root of a schema tree (contains enums/ and core/)
//   SCHEMA_PATH  legacy: path to a media-buy-valid-action.json; the id schema
//                is resolved as ../core/media-buy-available-action-id.json
//   OUT_PATH     write the generated module somewhere other than src/lib.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

export interface EnumMetadataEntry {
  update_fields?: string[];
  rollup?: string[];
}

/** `enumMetadata` blocks carry a `$comment` sibling; everything else is keyed by action id. */
type EnumMetadataBlock = Record<string, EnumMetadataEntry | string | undefined>;

interface ValidActionSchema {
  enum: string[];
  enumMetadata?: EnumMetadataBlock;
  'x-deprecated-enum-values'?: string[];
}

interface AvailableActionIdSchema {
  anyOf?: Array<{ $ref?: string; const?: unknown; enum?: unknown[] }>;
  enumMetadata?: EnumMetadataBlock;
}

export interface UpdateFieldRow {
  action: string;
  update_fields: string[];
  rollup: string[] | null;
  deprecated: boolean;
  /** True when the id is absent from the legacy flat enum. */
  structuredOnly: boolean;
}

export interface MergedActionMetadata {
  rows: UpdateFieldRow[];
  structuredOnlyActions: string[];
  /** False when the cache predates `core/media-buy-available-action-id.json`. */
  mergedAvailableActionIds: boolean;
}

const REPO_ROOT = path.join(__dirname, '..');
const LEGACY_ENUM_RELATIVE_PATH = 'enums/media-buy-valid-action.json';
const AVAILABLE_ACTION_ID_RELATIVE_PATH = 'core/media-buy-available-action-id.json';
const DEFAULT_OUT_PATH = path.join(REPO_ROOT, 'src/lib/media-buy/update-fields.generated.ts');

export function resolveSchemaDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SCHEMA_DIR) return env.SCHEMA_DIR;
  if (env.SCHEMA_PATH) {
    // Legacy override pointed at the enum file itself; the id schema lives
    // alongside it under core/.
    return path.dirname(path.dirname(env.SCHEMA_PATH));
  }
  const adcpVersion = readFileSync(path.join(REPO_ROOT, 'ADCP_VERSION'), 'utf8').trim();
  return path.join(REPO_ROOT, 'schemas/cache', adcpVersion);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function metadataEntries(block: EnumMetadataBlock | undefined): Map<string, EnumMetadataEntry> {
  const entries = new Map<string, EnumMetadataEntry>();
  for (const [key, value] of Object.entries(block ?? {})) {
    if (key.startsWith('$')) continue; // `$comment` and friends
    if (!value || typeof value !== 'object') continue;
    entries.set(key, value);
  }
  return entries;
}

function sameStringList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMetadata(a: EnumMetadataEntry, b: EnumMetadataEntry): boolean {
  return sameStringList(a.update_fields, b.update_fields) && sameStringList(a.rollup, b.rollup);
}

/** Structured-only ids declared inline on the id schema (`const` / `enum` branches; `$ref` branches are the legacy enum). */
function inlineActionIds(schema: AvailableActionIdSchema): string[] {
  const ids: string[] = [];
  for (const branch of schema.anyOf ?? []) {
    if (branch.$ref) continue;
    if (typeof branch.const === 'string') ids.push(branch.const);
    for (const value of branch.enum ?? []) {
      if (typeof value === 'string') ids.push(value);
    }
  }
  return ids;
}

/**
 * Load both `enumMetadata` blocks from `schemaDir` and merge them into one
 * ordered row list. Pure (no output); `main()` renders the result.
 */
export function loadMergedActionMetadata(schemaDir: string): MergedActionMetadata {
  const legacyPath = path.join(schemaDir, LEGACY_ENUM_RELATIVE_PATH);
  if (!existsSync(legacyPath)) {
    throw new Error(`Schema not found at ${legacyPath}. Run \`npm run sync-schemas\` or set SCHEMA_DIR / SCHEMA_PATH.`);
  }
  const legacy = readJson<ValidActionSchema>(legacyPath);
  const legacyMeta = metadataEntries(legacy.enumMetadata);
  const deprecated = new Set(legacy['x-deprecated-enum-values'] ?? []);

  if (legacyMeta.size === 0) {
    throw new Error(
      `Schema at ${legacyPath} has no enumMetadata block - likely a pre-3.1 cache. ` +
        `Bump the schema cache (npm run sync-schemas) before regenerating; AdCP 3.2+ caches also ship ` +
        `${AVAILABLE_ACTION_ID_RELATIVE_PATH}, whose enumMetadata is merged into this table.`
    );
  }

  const legacyIds = new Set(legacy.enum);
  const rows: UpdateFieldRow[] = legacy.enum.map(action => {
    const entry = legacyMeta.get(action) ?? {};
    return {
      action,
      update_fields: entry.update_fields ?? [],
      rollup: entry.rollup ?? null,
      deprecated: deprecated.has(action),
      structuredOnly: false,
    };
  });

  const idPath = path.join(schemaDir, AVAILABLE_ACTION_ID_RELATIVE_PATH);
  if (!existsSync(idPath)) {
    return { rows, structuredOnlyActions: [], mergedAvailableActionIds: false };
  }

  const idSchema = readJson<AvailableActionIdSchema>(idPath);
  const idMeta = metadataEntries(idSchema.enumMetadata);
  const structuredOnlyActions: string[] = [];
  const seen = new Set<string>();
  for (const action of inlineActionIds(idSchema)) {
    if (seen.has(action)) continue;
    seen.add(action);
    if (legacyIds.has(action)) continue; // Redundant restatement of a legacy value; the legacy row already covers it.
    structuredOnlyActions.push(action);
  }

  // Conflict check: a key present in both blocks must agree. Legacy wins on
  // agreement; disagreement is upstream drift and must not be silently merged.
  for (const [action, entry] of idMeta) {
    const legacyEntry = legacyMeta.get(action);
    if (legacyEntry) {
      if (!sameMetadata(legacyEntry, entry)) {
        throw new Error(
          `enumMetadata conflict for "${action}": ${LEGACY_ENUM_RELATIVE_PATH} declares ` +
            `${JSON.stringify(legacyEntry)} but ${AVAILABLE_ACTION_ID_RELATIVE_PATH} declares ${JSON.stringify(entry)}. ` +
            `Upstream schemas disagree; refusing to merge.`
        );
      }
      continue;
    }
    if (!seen.has(action)) {
      throw new Error(
        `${AVAILABLE_ACTION_ID_RELATIVE_PATH} carries enumMetadata for "${action}", which is neither a ` +
          `${LEGACY_ENUM_RELATIVE_PATH} value nor an inline anyOf const of the id schema.`
      );
    }
  }

  for (const action of structuredOnlyActions) {
    const entry = idMeta.get(action);
    if (!entry?.update_fields?.length) {
      throw new Error(
        `Structured-only action "${action}" in ${AVAILABLE_ACTION_ID_RELATIVE_PATH} has no ` +
          `enumMetadata.update_fields binding; the preflight resolver cannot dispatch it.`
      );
    }
    rows.push({
      action,
      update_fields: entry.update_fields,
      rollup: entry.rollup ?? null,
      deprecated: false,
      structuredOnly: true,
    });
  }

  return { rows, structuredOnlyActions, mergedAvailableActionIds: true };
}

export function renderUpdateFieldsModule(merged: MergedActionMetadata): string {
  const { rows, structuredOnlyActions } = merged;

  const banner =
    '// Generated by scripts/generate-media-buy-update-fields.ts.\n' +
    '// Sources (enumMetadata, merged; legacy block wins on shared keys):\n' +
    '//   schemas/cache/<adcp_version>/enums/media-buy-valid-action.json\n' +
    '//   schemas/cache/<adcp_version>/core/media-buy-available-action-id.json' +
    (merged.mergedAvailableActionIds ? '\n' : ' (absent from this cache; legacy-only table)\n') +
    '// Do not hand-edit - regenerate after a schema bump.\n\n';

  const tsImports = "import type { MediaBuyValidAction } from './types';\n\n";

  const structuredOnlyLiteral = structuredOnlyActions.map(action => JSON.stringify(action)).join(', ');
  const tsStructuredOnly =
    '/**\n' +
    ' * Actions that exist only on the structured `available_actions[].action`\n' +
    ' * surface (absent from the deprecated flat `valid_actions[]` enum). Their\n' +
    ' * field bindings come from `core/media-buy-available-action-id.json`.\n' +
    ' * Empty when the schema cache predates that file.\n' +
    ' */\n' +
    `export const STRUCTURED_ONLY_MEDIA_BUY_ACTIONS = [${structuredOnlyLiteral}] as const;\n\n` +
    'export type StructuredOnlyMediaBuyAction = (typeof STRUCTURED_ONLY_MEDIA_BUY_ACTIONS)[number];\n\n' +
    '/**\n' +
    ' * Every action id with an `update_media_buy` field binding: the legacy\n' +
    ' * flat enum plus structured-only ids. Keys of `UPDATE_FIELDS_BY_ACTION`.\n' +
    ' */\n' +
    'export type MediaBuyUpdateFieldAction = MediaBuyValidAction | StructuredOnlyMediaBuyAction;\n\n';

  const tsEntry =
    'export interface UpdateFieldEntry {\n' +
    '  /** Dotted paths into the update_media_buy request body this action covers. */\n' +
    '  readonly update_fields: readonly string[];\n' +
    '  /** Fine-grained values this action rolls up to (legacy coarse actions only). */\n' +
    '  readonly rollup: readonly MediaBuyValidAction[] | null;\n' +
    '  /** True for `x-deprecated-enum-values` (legacy coarse vocabulary). */\n' +
    '  readonly deprecated: boolean;\n' +
    '}\n\n';

  const tableLines = rows
    .map(row => {
      const fields = row.update_fields.map(f => JSON.stringify(f)).join(', ');
      const rollup = row.rollup === null ? 'null' : `[${row.rollup.map(r => JSON.stringify(r)).join(', ')}] as const`;
      return (
        `  ${JSON.stringify(row.action)}: {\n` +
        `    update_fields: [${fields}] as const,\n` +
        `    rollup: ${rollup},\n` +
        `    deprecated: ${row.deprecated},\n` +
        `  },`
      );
    })
    .join('\n');

  const tableConst =
    'export const UPDATE_FIELDS_BY_ACTION: Readonly<\n' +
    '  Record<MediaBuyUpdateFieldAction, UpdateFieldEntry>\n' +
    '> = {\n' +
    tableLines +
    '\n} as const;\n\n';

  // Inverse index: dotted path -> actions that touch it. Used by the
  // resolver to map a request diff back to actions.
  const inverse: Record<string, string[]> = {};
  for (const row of rows) {
    if (row.deprecated) continue;
    for (const field of row.update_fields) {
      if (!inverse[field]) inverse[field] = [];
      inverse[field].push(row.action);
    }
  }
  const inverseLines = Object.entries(inverse)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([field, actions]) => `  ${JSON.stringify(field)}: [${actions.map(a => JSON.stringify(a)).join(', ')}] as const,`
    )
    .join('\n');

  const inverseConst =
    'export const ACTIONS_BY_FIELD: Readonly<\n' +
    '  Record<string, readonly MediaBuyUpdateFieldAction[]>\n' +
    '> = {\n' +
    inverseLines +
    '\n} as const;\n\n';

  const legacyExport =
    "export { LEGACY_COARSE_ACTIONS } from './types';\n" + "export type { LegacyCoarseAction } from './types';\n";

  return banner + tsImports + tsStructuredOnly + tsEntry + tableConst + inverseConst + legacyExport;
}

function main(): void {
  const schemaDir = resolveSchemaDir();
  const merged = loadMergedActionMetadata(schemaDir);
  if (!merged.mergedAvailableActionIds) {
    process.stdout.write(
      `ℹ️  ${path.join(schemaDir, AVAILABLE_ACTION_ID_RELATIVE_PATH)} not present; ` +
        `emitting legacy-only table (cache predates AdCP 3.2 structured-only actions).\n`
    );
  }
  const outPath = process.env.OUT_PATH ? path.resolve(process.cwd(), process.env.OUT_PATH) : DEFAULT_OUT_PATH;
  writeFileSync(outPath, renderUpdateFieldsModule(merged), 'utf8');
  process.stdout.write(
    `Wrote ${outPath} (${merged.rows.length} actions` +
      (merged.structuredOnlyActions.length > 0
        ? `, ${merged.structuredOnlyActions.length} structured-only: ${merged.structuredOnlyActions.join(', ')})\n`
        : ')\n')
  );
}

if (require.main === module) {
  main();
}
