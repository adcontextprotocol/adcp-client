#!/usr/bin/env tsx

import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Generate manifest-derived constants from `schemas/cache/{version}/manifest.json`.
 *
 * AdCP 3.0.4 (adcp#3738) published `/schemas/{version}/manifest.json` as a
 * single canonical artifact carrying:
 *  - 51+ tools with `protocol`, `mutating`, request/response schema refs,
 *    async response schemas, and specialism mappings
 *  - 45 error codes with structured `recovery`, `description`, `suggestion`
 *  - `error_code_policy.default_unknown_recovery: "transient"` policy block
 *
 * Before this, the SDK hand-rolled three surfaces that drifted independently:
 *  - tools-by-protocol arrays (`MEDIA_BUY_TOOLS`, `SIGNALS_TOOLS`, …)
 *  - `STANDARD_ERROR_CODES` description + recovery table
 *  - specialism → required-tools mapping
 *
 * This generator reads the bundled manifest and emits a single
 * `src/lib/types/manifest.generated.ts` file as the source of truth. The
 * hand-curated tables in `error-codes.ts` and `capabilities.ts` migrate to
 * importing from here. Drift is impossible by construction — re-running
 * `generate-manifest-derived` regenerates the table from the latest cache.
 *
 * Tracked: adcp-client#1192.
 */

const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/types/manifest.generated.ts');

interface ManifestErrorCode {
  recovery: 'transient' | 'correctable' | 'terminal';
  description: string;
  suggestion?: string;
}

interface ManifestTool {
  protocol: string;
  mutating: boolean;
  specialisms?: string[];
  request_schema?: string;
  response_schema?: string;
  async_response_schemas?: string[];
}

interface ManifestSpecialism {
  protocol?: string;
  status?: 'stable' | 'preview';
  required_tools?: string[];
  optional_tools?: string[];
}

interface AdcpManifest {
  adcp_version: string;
  generated_at: string;
  tools: Record<string, ManifestTool>;
  error_code_policy: { default_unknown_recovery: 'transient' | 'correctable' | 'terminal' };
  error_codes: Record<string, ManifestErrorCode>;
  specialisms: Record<string, ManifestSpecialism>;
}

function loadManifest(): { manifest: AdcpManifest; sourcePath: string } {
  const adcpVersionPath = path.join(__dirname, '../ADCP_VERSION');
  if (!existsSync(adcpVersionPath)) {
    throw new Error('ADCP_VERSION file not found at repo root.');
  }
  const version = readFileSync(adcpVersionPath, 'utf8').trim();
  if (!version) throw new Error('ADCP_VERSION file is empty.');

  const manifestPath = path.join(SCHEMA_CACHE_DIR, version, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `manifest.json not found at ${manifestPath}. Run \`npm run sync-schemas\` first. ` +
        `(AdCP 3.0.4+ ships manifest.json; older bundles do not — bump ADCP_VERSION if needed.)`
    );
  }

  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as AdcpManifest;

  if (!manifest.error_codes || !manifest.tools || !manifest.specialisms) {
    throw new Error(
      `manifest.json at ${manifestPath} is missing required sections. ` +
        `Required: error_codes, tools, specialisms.`
    );
  }
  return { manifest, sourcePath: manifestPath };
}

function jsonStringify(value: unknown): string {
  // 2-space indent; quote keys uniformly so the file diffs predictably.
  return JSON.stringify(value, null, 2);
}

function generateFile(manifest: AdcpManifest, sourcePath: string): string {
  // Sort error codes alphabetically for predictable diffs.
  const sortedErrorCodes: Record<string, ManifestErrorCode> = {};
  for (const code of Object.keys(manifest.error_codes).sort()) {
    sortedErrorCodes[code] = manifest.error_codes[code];
  }

  // Group tools by protocol for the `<PROTOCOL>_TOOLS` arrays.
  // Maintains the same names that `src/lib/utils/capabilities.ts` exports
  // today so consumers' imports keep compiling after migration.
  const toolsByProtocol = new Map<string, string[]>();
  for (const [name, tool] of Object.entries(manifest.tools).sort(([a], [b]) => a.localeCompare(b))) {
    const protocol = tool.protocol ?? 'unknown';
    if (!toolsByProtocol.has(protocol)) toolsByProtocol.set(protocol, []);
    toolsByProtocol.get(protocol)!.push(name);
  }

  // Specialism → required tools (sorted)
  const specialismRequiredTools = new Map<string, string[]>();
  for (const [id, spec] of Object.entries(manifest.specialisms).sort(([a], [b]) => a.localeCompare(b))) {
    if (Array.isArray(spec.required_tools) && spec.required_tools.length > 0) {
      specialismRequiredTools.set(id, [...spec.required_tools].sort());
    }
  }

  const errorCodesEntries = Object.entries(sortedErrorCodes)
    .map(([code, info]) => {
      const description = JSON.stringify(info.description);
      const recovery = JSON.stringify(info.recovery);
      const suggestion = info.suggestion ? `,\n    suggestion: ${JSON.stringify(info.suggestion)}` : '';
      return `  ${code}: {\n    description: ${description},\n    recovery: ${recovery}${suggestion}\n  }`;
    })
    .join(',\n');

  const toolsByProtocolBlock = [...toolsByProtocol.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([protocol, tools]) => {
      const constName = protocolNameToConst(protocol);
      const sorted = [...tools].sort();
      return `export const ${constName} = [\n  ${sorted.map(t => JSON.stringify(t)).join(',\n  ')},\n] as const;`;
    })
    .join('\n\n');

  const specialismRequiredToolsBlock = [...specialismRequiredTools.entries()]
    .map(([id, tools]) => {
      return `  ${JSON.stringify(id)}: [${tools.map(t => JSON.stringify(t)).join(', ')}] as const`;
    })
    .join(',\n');

  const cacheRel = path.relative(path.join(__dirname, '..'), sourcePath);

  return `// AUTO-GENERATED FROM ${cacheRel} — DO NOT EDIT.
// Run \`npm run generate-manifest-derived\` to regenerate.

/**
 * Manifest-derived constants for AdCP ${manifest.adcp_version}.
 *
 * Single source of truth for tool↔protocol grouping, error-code metadata
 * (description + recovery + suggestion), and specialism→required-tools
 * mapping. Replaces the hand-curated tables that previously lived in
 * \`src/lib/utils/capabilities.ts\` and \`src/lib/types/error-codes.ts\`.
 *
 * Source: \`${cacheRel}\` (adcp_version: ${manifest.adcp_version}, generated_at:
 * ${manifest.generated_at}). Re-run \`npm run sync-schemas\` then
 * \`npm run generate-manifest-derived\` to refresh after a spec bump.
 */

export type ErrorRecovery = 'transient' | 'correctable' | 'terminal';

export interface StandardErrorCodeInfo {
  description: string;
  recovery: ErrorRecovery;
  suggestion?: string;
}

/**
 * Default recovery to fall back on for non-standard / unknown error codes.
 * Sourced from \`error_code_policy.default_unknown_recovery\` in the manifest.
 */
export const DEFAULT_UNKNOWN_RECOVERY: ErrorRecovery = ${JSON.stringify(manifest.error_code_policy.default_unknown_recovery)};

/**
 * Standard AdCP error codes with structured \`description\`, \`recovery\`, and
 * (where the spec provides one) \`suggestion\`. Keyed by the wire code.
 *
 * The \`StandardErrorCode\` union is derived from \`ErrorCodeValues\` in
 * \`enums.generated.ts\`. Drift is caught by the \`satisfies Record<…>\`
 * assertion in \`src/lib/types/error-codes.ts\`.
 */
export const STANDARD_ERROR_CODES_FROM_MANIFEST = {
${errorCodesEntries}
} as const satisfies Record<string, StandardErrorCodeInfo>;

// ---------------------------------------------------------------------------
// Tools by protocol — manifest-grouped const arrays.
// ---------------------------------------------------------------------------

${toolsByProtocolBlock}

/**
 * Specialism → required tool list. Adopters claiming a specialism in
 * \`get_adcp_capabilities\` are expected to implement every tool in the
 * matching list per the spec's specialism YAML.
 */
export const SPECIALISM_REQUIRED_TOOLS = {
${specialismRequiredToolsBlock}
} as const;
`;
}

function protocolNameToConst(protocol: string): string {
  // 'media-buy' → 'MEDIA_BUY_TOOLS_FROM_MANIFEST'
  // 'sponsored-intelligence' → 'SPONSORED_INTELLIGENCE_TOOLS_FROM_MANIFEST'
  return `${protocol.replace(/-/g, '_').toUpperCase()}_TOOLS_FROM_MANIFEST`;
}

function main(): void {
  const { manifest, sourcePath } = loadManifest();
  const content = generateFile(manifest, sourcePath);

  const existing = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : '';
  if (existing === content) {
    console.log(`✅ ${path.relative(path.join(__dirname, '..'), OUTPUT_FILE)} is up to date`);
    return;
  }

  writeFileSync(OUTPUT_FILE, content);
  console.log(
    `✅ Generated ${path.relative(path.join(__dirname, '..'), OUTPUT_FILE)} ` +
      `(adcp_version: ${manifest.adcp_version}, ${Object.keys(manifest.error_codes).length} error codes, ` +
      `${Object.keys(manifest.tools).length} tools, ${Object.keys(manifest.specialisms).length} specialisms)`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ Failed to generate manifest-derived constants:', (err as Error).message);
    process.exit(1);
  }
}

export { main as generateManifestDerived };
