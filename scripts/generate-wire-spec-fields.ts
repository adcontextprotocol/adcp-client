#!/usr/bin/env tsx
/**
 * Codegen — emits `src/lib/server/wire-spec-fields.generated.ts`.
 *
 * Walks `schemas/cache/{ADCP_VERSION}/**\/*-request.json` and extracts
 * the top-level `properties` keys for every request schema. The
 * resulting constant maps each request's PascalCase TS name to its
 * wire-spec field allowlist — used by `pickWireSpecFields(req,
 * schemaName)` to strip buyer-controlled args to schema-spec fields
 * only at the operational fan-out boundary.
 *
 * Replaces the hand-rolled allowlist that adopters built in
 * scope3data/agentic-adapters#248 (`scrubRequestForFanout`,
 * `synthesizeArgsForFanout`). The codegen-derived list is the schema —
 * drift is structurally impossible.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const ADCP_VERSION_FILE = path.join(REPO_ROOT, 'ADCP_VERSION');
const SCHEMA_CACHE_DIR = path.join(REPO_ROOT, 'schemas/cache');
const OUTPUT_FILE = path.join(REPO_ROOT, 'src/lib/server/wire-spec-fields.generated.ts');

function getAdcpVersion(): string {
  return readFileSync(ADCP_VERSION_FILE, 'utf8').trim();
}

// Subdirectories under `schemas/cache/{version}/` to skip:
// - `bundled/` is a compose layer that re-shapes schemas for cross-protocol
//   convenience. Field sets diverge from the canonical schemas, which
//   would produce false-positive collisions.
// - underscore-prefixed dirs are codegen scratch.
const SKIP_DIRS = new Set(['bundled']);

/**
 * Allowlist of fan-out-relevant request basenames. Restricts codegen to
 * the request shapes that actually flow through operational fan-out
 * paths (mutating tools + delivery polling). Read-only tools like
 * `list_creative_formats` are excluded — they aren't fan-out targets,
 * and some have cross-protocol shape divergence in the schema cache
 * that would block codegen if included.
 *
 * Source: derived from `MUTATING_TASKS` (see `src/lib/utils/idempotency.ts`)
 * plus `get_media_buy_delivery` (the canonical poller read).
 */
const FAN_OUT_REQUEST_BASENAMES = new Set([
  // Media-buy mutating
  'create-media-buy-request',
  'update-media-buy-request',
  'sync-accounts-request',
  'sync-creatives-request',
  'sync-audiences-request',
  'sync-catalogs-request',
  'sync-event-sources-request',
  'sync-plans-request',
  'sync-governance-request',
  'provide-performance-feedback-request',
  'log-event-request',
  'report-usage-request',
  'report-plan-outcome-request',
  // Brand rights mutating
  'acquire-rights-request',
  'update-rights-request',
  // Signals mutating
  'activate-signal-request',
  // Creative mutating
  'build-creative-request',
  // Property / collection / content-standards mutating
  'create-property-list-request',
  'update-property-list-request',
  'delete-property-list-request',
  'create-collection-list-request',
  'update-collection-list-request',
  'delete-collection-list-request',
  'create-content-standards-request',
  'update-content-standards-request',
  'calibrate-content-request',
  // Sponsored intelligence mutating
  'si-initiate-session-request',
  'si-send-message-request',
  // Read paths fan-out callers also need
  'get-media-buy-delivery-request',
]);

function walk(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('_')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, suffix));
    } else if (entry.endsWith(suffix)) {
      const basename = path.basename(entry, '.json');
      if (FAN_OUT_REQUEST_BASENAMES.has(basename)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Convert a kebab-case file basename like `update-media-buy-request` to
 * the PascalCase TypeScript type name `UpdateMediaBuyRequest`. Matches
 * the convention `json-schema-to-typescript` uses in
 * `core.generated.ts`.
 */
function toTypeName(basename: string): string {
  return basename
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

interface SchemaEntry {
  typeName: string;
  fields: string[];
  source: string;
}

function loadSchema(file: string): SchemaEntry | null {
  const json = JSON.parse(readFileSync(file, 'utf8')) as { properties?: Record<string, unknown> };
  const properties = json.properties;
  if (!properties || typeof properties !== 'object') return null;
  const fields = Object.keys(properties).sort();
  if (fields.length === 0) return null;
  const basename = path.basename(file, '.json');
  const typeName = toTypeName(basename);
  return { typeName, fields, source: path.relative(REPO_ROOT, file) };
}

function main(): void {
  const version = getAdcpVersion();
  const schemaDir = path.join(SCHEMA_CACHE_DIR, version);
  if (!existsSync(schemaDir)) {
    throw new Error(`generate-wire-spec-fields: schema cache not found at ${schemaDir}`);
  }
  const requestFiles = walk(schemaDir, '-request.json').sort();
  const entries: SchemaEntry[] = [];
  for (const file of requestFiles) {
    const entry = loadSchema(file);
    if (entry) entries.push(entry);
  }

  // Dedupe by typeName — schemas may appear in multiple subdirectories
  // for cross-cutting tools (rare but possible). Keep the first
  // occurrence; flag duplicates to surface drift.
  const seen = new Map<string, SchemaEntry>();
  for (const entry of entries) {
    const existing = seen.get(entry.typeName);
    if (existing) {
      const sameFields =
        existing.fields.length === entry.fields.length && existing.fields.every((f, i) => f === entry.fields[i]);
      if (!sameFields) {
        throw new Error(
          `generate-wire-spec-fields: schema ${entry.typeName} appears in multiple files with DIFFERENT field sets:\n` +
            `  ${existing.source}: ${existing.fields.join(', ')}\n` +
            `  ${entry.source}: ${entry.fields.join(', ')}`
        );
      }
      continue;
    }
    seen.set(entry.typeName, entry);
  }

  const sorted = [...seen.values()].sort((a, b) => a.typeName.localeCompare(b.typeName));

  const lines: string[] = [
    '// AUTO-GENERATED by scripts/generate-wire-spec-fields.ts. DO NOT EDIT.',
    `// Source: schemas/cache/${version}/**/*-request.json`,
    `// Generated at: ${new Date().toISOString()}`,
    '',
    '/**',
    ' * Wire-spec field allowlists per request type. The values are exact',
    ' * top-level property names from the AdCP request JSON schemas;',
    ' * `pickWireSpecFields(req, schemaName)` uses them to strip buyer-',
    ' * controlled args to schema-spec fields at the operational fan-out',
    ' * boundary. Drift between this map and the schemas is impossible by',
    ' * construction — both are emitted from the same codegen pass.',
    ' */',
    'export const WIRE_SPEC_FIELDS = {',
  ];
  for (const entry of sorted) {
    lines.push(`  /** ${entry.source} */`);
    lines.push(`  ${entry.typeName}: ${JSON.stringify(entry.fields)},`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('export type WireSpecRequestName = keyof typeof WIRE_SPEC_FIELDS;');
  lines.push('');

  const content = lines.join('\n');
  // Idempotent write — skip if unchanged sans timestamp.
  if (existsSync(OUTPUT_FILE)) {
    const existing = readFileSync(OUTPUT_FILE, 'utf8');
    const stripTs = (s: string) => s.replace(/\/\/ Generated at: .*?\n/, '');
    if (stripTs(existing) === stripTs(content)) {
      console.log(`[generate-wire-spec-fields] up to date: ${path.relative(REPO_ROOT, OUTPUT_FILE)}`);
      return;
    }
  }
  writeFileSync(OUTPUT_FILE, content);
  console.log(
    `[generate-wire-spec-fields] wrote ${sorted.length} request schemas to ${path.relative(REPO_ROOT, OUTPUT_FILE)}`
  );
}

main();
