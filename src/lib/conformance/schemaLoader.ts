import * as fs from 'fs';
import * as path from 'path';
import type { ConformanceToolName } from './types';
import { ADCP_VERSION } from '../version';

type JsonSchema = Record<string, unknown>;

interface ToolSchemaLocation {
  domain: string;
  fileBase: string;
}

const TOOL_SCHEMA_LOCATIONS: Record<ConformanceToolName, ToolSchemaLocation> = {
  // Tier 1
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
  // Tier 2 (referential)
  get_media_buy_delivery: { domain: 'media-buy', fileBase: 'get-media-buy-delivery' },
  get_property_list: { domain: 'property', fileBase: 'get-property-list' },
  get_content_standards: { domain: 'content-standards', fileBase: 'get-content-standards' },
  get_creative_delivery: { domain: 'creative', fileBase: 'get-creative-delivery' },
  tasks_get: { domain: 'core', fileBase: 'tasks-get' },
  preview_creative: { domain: 'creative', fileBase: 'preview-creative' },
  // Tier 3 (mutating updates)
  update_media_buy: { domain: 'media-buy', fileBase: 'update-media-buy' },
  update_property_list: { domain: 'property', fileBase: 'update-property-list' },
  update_content_standards: { domain: 'content-standards', fileBase: 'update-content-standards' },
};

/**
 * Resolve the bundled-schemas directory. Mirrors the validator's loader
 * in `src/lib/validation/schema-loader.ts`: prefer the built tree where
 * `scripts/copy-schemas-to-dist.ts` stages schemas at build time, and
 * fall back to the source cache for local development.
 *
 * - Built:  <pkg>/dist/lib/schemas-data/<ver>/bundled
 * - Source: <pkg>/schemas/cache/<ver>/bundled
 */
function findBundledDir(): string {
  const distCandidate = path.resolve(__dirname, '..', 'schemas-data', ADCP_VERSION, 'bundled');
  if (fs.existsSync(distCandidate)) return distCandidate;

  const srcCandidate = path.resolve(__dirname, '..', '..', '..', 'schemas', 'cache', ADCP_VERSION, 'bundled');
  if (fs.existsSync(srcCandidate)) return srcCandidate;

  throw new Error(
    `Conformance schema bundle not found. Looked in ${distCandidate} and ${srcCandidate}. ` +
      `Run \`npm run sync-schemas && npm run build:lib\`, or reinstall @adcp/client.`
  );
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
 * The AdCP schema version the fuzzer loaded. Surfaced on the report so
 * a stored seed is replayable only against a matching snapshot.
 */
export function detectSchemaVersion(): string {
  return ADCP_VERSION;
}
