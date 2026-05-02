#!/usr/bin/env tsx

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Generate the per-tool entity-hydration field map from request schemas.
 *
 * AdCP tags every identifier field with an `x-entity` JSON Schema annotation
 * (e.g. `update_media_buy.media_buy_id` carries `x-entity: "media_buy"`).
 * The annotation is the spec's rename-firewall: if a field gets renamed in
 * a future release, the `x-entity` tag travels with it.
 *
 * Today's framework auto-hydration keys on hardcoded `(field_name,
 * ResourceKind)` pairs at each call site in `from-platform.ts`. That's
 * silent breakage waiting to happen the day the spec renames a field.
 *
 * This script walks `manifest.json` (the canonical tool index since
 * AdCP 3.0.4 / adcp#3738), loads each tool's request schema from
 * `schemas/cache/{version}/`, and emits a static map keyed by tool name
 * with each top-level `x-entity`-tagged string field. The runtime
 * dispatcher consumes this map plus a small `x-entity → ResourceKind`
 * mapping to drive hydration without re-walking the schemas at startup.
 *
 * Tracked: adcp-client#1109.
 */

const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/server/decisioning/runtime/entity-hydration.generated.ts');

interface ManifestTool {
  protocol: string;
  mutating: boolean;
  request_schema?: string;
}

interface AdcpManifest {
  adcp_version: string;
  tools: Record<string, ManifestTool>;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  'x-entity'?: string;
  [key: string]: unknown;
}

interface EntityField {
  /** Top-level property name on the request object. */
  field: string;
  /** Spec entity tag — the renaming-firewall. Maps to ResourceKind via the runtime table. */
  xEntity: string;
}

function loadManifest(): { manifest: AdcpManifest; version: string; cacheDir: string } {
  const adcpVersionPath = path.join(__dirname, '../ADCP_VERSION');
  if (!existsSync(adcpVersionPath)) {
    throw new Error('ADCP_VERSION file not found at repo root.');
  }
  const version = readFileSync(adcpVersionPath, 'utf8').trim();
  if (!version) throw new Error('ADCP_VERSION file is empty.');

  const cacheDir = path.join(SCHEMA_CACHE_DIR, version);
  const manifestPath = path.join(cacheDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `manifest.json not found at ${manifestPath}. Run \`npm run sync-schemas\` first. ` +
        `(AdCP 3.0.4+ ships manifest.json; older bundles do not.)`
    );
  }

  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as AdcpManifest;
  return { manifest, version, cacheDir };
}

/**
 * Walk a request schema's top-level properties for `x-entity`-tagged
 * string fields. Nested object paths are intentionally excluded — every
 * hydration site in the SDK today targets a top-level identifier, and
 * adding nested-walk semantics without a real call site is overreach.
 * If a future hydration site needs nested paths (e.g.
 * `create_media_buy.packages[i].product_id`), extend this walker and
 * the runtime helper together.
 */
function extractTopLevelEntityFields(schema: JsonSchema): EntityField[] {
  if (!schema.properties) return [];
  const fields: EntityField[] = [];
  for (const [field, propSchema] of Object.entries(schema.properties)) {
    if (!propSchema || typeof propSchema !== 'object') continue;
    const xEntity = propSchema['x-entity'];
    if (typeof xEntity !== 'string') continue;
    // Hydration consumes string IDs only; arrays of IDs are a separate
    // (unimplemented) mode handled at the call site if/when needed.
    if (propSchema.type !== 'string') continue;
    fields.push({ field, xEntity });
  }
  // Stable order keeps the generated file diff-noise-free across runs.
  fields.sort((a, b) => a.field.localeCompare(b.field));
  return fields;
}

function loadSchema(cacheDir: string, schemaRef: string): JsonSchema | null {
  const schemaPath = path.join(cacheDir, schemaRef);
  if (!existsSync(schemaPath)) return null;
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchema;
}

/**
 * Tools that are webhook payloads, not MCP/A2A dispatch entries. The
 * runtime hydrator routes through `from-platform.ts` which only handles
 * tool dispatch; webhook receivers are adopter-wired and consume the
 * entity types directly. Entries here would be dead weight in the
 * generated map.
 */
const WEBHOOK_ONLY_TOOLS = new Set<string>(['creative_approval']);

function buildEntityFieldMap(manifest: AdcpManifest, cacheDir: string): Record<string, EntityField[]> {
  const result: Record<string, EntityField[]> = {};
  for (const [toolName, tool] of Object.entries(manifest.tools)) {
    if (!tool.request_schema) continue;
    if (WEBHOOK_ONLY_TOOLS.has(toolName)) continue;
    const schema = loadSchema(cacheDir, tool.request_schema);
    if (!schema) continue;
    const fields = extractTopLevelEntityFields(schema);
    if (fields.length === 0) continue;
    result[toolName] = fields;
  }
  return result;
}

function renderOutput(map: Record<string, EntityField[]>, version: string): string {
  const sortedTools = Object.keys(map).sort();
  const header = `// Generated entity-hydration field map — do NOT edit by hand
//
// Source: \`schemas/cache/${version}/manifest.json\` + per-tool request
// schemas. Every top-level \`x-entity\`-tagged string field on a request
// schema lands here. The runtime hydrator (\`from-platform.ts\` →
// \`hydrateForTool\`) walks this map plus the hand-curated
// \`ENTITY_TO_RESOURCE_KIND\` table to drive auto-hydration without
// re-walking schemas at startup.
//
// Renaming-firewall: if the spec renames \`media_buy_id\` → \`mediabuy_id\`,
// the \`x-entity\` tag travels with it; the next codegen run picks up
// the new field name automatically.
//
// Regenerate with: npm run generate-entity-hydration

`;

  let body = `export interface EntityHydrationField {
  /** Top-level property on the wire request object. */
  readonly field: string;
  /** Spec \`x-entity\` annotation — maps to \`ResourceKind\` at runtime. */
  readonly xEntity: string;
}

export const TOOL_ENTITY_FIELDS: Readonly<Record<string, ReadonlyArray<EntityHydrationField>>> = {
`;
  for (const tool of sortedTools) {
    const fields = map[tool];
    body += `  ${tool}: [\n`;
    for (const f of fields) {
      body += `    { field: ${JSON.stringify(f.field)}, xEntity: ${JSON.stringify(f.xEntity)} },\n`;
    }
    body += `  ],\n`;
  }
  body += `};\n`;
  return header + body;
}

function writeFileIfChanged(filePath: string, newContent: string): boolean {
  if (existsSync(filePath)) {
    if (readFileSync(filePath, 'utf8') === newContent) return false;
  }
  writeFileSync(filePath, newContent);
  return true;
}

function main(): void {
  console.log('🔄 Generating entity-hydration field map...');
  const { manifest, version, cacheDir } = loadManifest();
  const map = buildEntityFieldMap(manifest, cacheDir);
  const toolCount = Object.keys(map).length;

  // Floor guard: 24 tools currently carry `x-entity`-tagged fields after
  // filtering webhook-only payloads. A floor of 20 catches a manifest
  // reorg or schema-cache regression that drops the count materially,
  // while leaving headroom for routine spec churn.
  if (toolCount < 20) {
    throw new Error(
      `generate-entity-hydration: extracted only ${toolCount} tools with x-entity fields — expected at least 20. ` +
        'Either the manifest layout shifted or the schema cache is stale.'
    );
  }

  const output = renderOutput(map, version);
  const changed = writeFileIfChanged(OUTPUT_FILE, output);
  if (changed) {
    console.log(`✅ Generated entity-hydration map: ${OUTPUT_FILE}`);
  } else {
    console.log(`✅ Entity-hydration map is up to date: ${OUTPUT_FILE}`);
  }
  console.log(`📊 Mapped ${toolCount} tools with x-entity fields`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  }
}

export { main as generateEntityHydration };
