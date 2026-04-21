import * as fs from 'fs';
import * as path from 'path';
import type { ConformanceToolName } from './types';

type JsonSchema = Record<string, unknown>;

interface ToolSchemaLocation {
  domain: string;
  fileBase: string;
}

const TOOL_SCHEMA_LOCATIONS: Record<ConformanceToolName, ToolSchemaLocation> = {
  get_products: { domain: 'media-buy', fileBase: 'get-products' },
  list_creative_formats: { domain: 'media-buy', fileBase: 'list-creative-formats' },
  list_creatives: { domain: 'creative', fileBase: 'list-creatives' },
  get_media_buys: { domain: 'media-buy', fileBase: 'get-media-buys' },
  get_signals: { domain: 'signals', fileBase: 'get-signals' },
  si_get_offering: { domain: 'sponsored-intelligence', fileBase: 'si-get-offering' },
  get_adcp_capabilities: { domain: 'protocol', fileBase: 'get-adcp-capabilities' },
  tasks_list: { domain: 'core', fileBase: 'tasks-list' },
  list_property_lists: { domain: 'property', fileBase: 'list-property-lists' },
  list_content_standards: { domain: 'content-standards', fileBase: 'list-content-standards' },
  get_creative_features: { domain: 'creative', fileBase: 'get-creative-features' },
};

/**
 * Find the bundled-schemas directory. Works from source and from the
 * published package layout.
 *
 * - Source tree: <pkg>/src/lib/conformance/schemaLoader.ts → <pkg>/schemas/cache/latest/bundled
 * - Published: <pkg>/dist/lib/conformance/schemaLoader.js → <pkg>/schemas/cache/latest/bundled
 *
 * Both resolve three directories up.
 */
function findBundledDir(): string {
  const candidate = path.resolve(__dirname, '..', '..', '..', 'schemas', 'cache', 'latest', 'bundled');
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Conformance schema bundle not found at ${candidate}. ` +
        `Run \`npm run sync-schemas\` in the repo, or reinstall @adcp/client.`
    );
  }
  return candidate;
}

const schemaCache = new Map<string, JsonSchema>();

function loadSchema(relativePath: string): JsonSchema {
  const cached = schemaCache.get(relativePath);
  if (cached) return cached;
  const full = path.join(findBundledDir(), relativePath);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as JsonSchema;
  schemaCache.set(relativePath, parsed);
  return parsed;
}

export function loadRequestSchema(tool: ConformanceToolName): JsonSchema {
  const loc = TOOL_SCHEMA_LOCATIONS[tool];
  return loadSchema(`${loc.domain}/${loc.fileBase}-request.json`);
}

export function loadResponseSchema(tool: ConformanceToolName): JsonSchema {
  const loc = TOOL_SCHEMA_LOCATIONS[tool];
  return loadSchema(`${loc.domain}/${loc.fileBase}-response.json`);
}

export function hasSchemas(tool: ConformanceToolName): boolean {
  try {
    loadRequestSchema(tool);
    loadResponseSchema(tool);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort schema-version detection. Reads `ADCP_VERSION` at the
 * package root, falling back to `'unknown'`. Surfaced in the report so a
 * stored seed is replayable only against a matching schema snapshot.
 */
export function detectSchemaVersion(): string {
  const adcpVersionFile = path.resolve(__dirname, '..', '..', '..', 'ADCP_VERSION');
  try {
    return fs.readFileSync(adcpVersionFile, 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
