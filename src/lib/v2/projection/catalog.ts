/**
 * Loader for the AAO canonical-formats catalog (`reference-formats.json`).
 * Source of truth: `server/src/creative-agent/reference-formats.json` in
 * the adcontextprotocol/adcp repo — published by the AAO with the
 * `canonical` annotation on entries that have a v2 canonical-format
 * equivalent.
 *
 * The catalog is the v1→v2 direction's primary lookup table: each entry
 * is a v1 format definition, and 32 of the 57 entries in 3.1-beta carry
 * a `canonical: <kind>` annotation that names the v2 canonical the v1
 * format projects to. This is the spec's resolution-order step 2 —
 * "seller-asserted on the v1 file" — applied to AAO-published v1 formats.
 *
 * Loader is keyed by `agent_url` (with trailing-slash normalization) +
 * `format_id.id`. Same scope as the v2→v1 registry: AAO catalog only.
 * Seller-specific catalogs (from a publisher's
 * `list_creative_formats`) are out of scope for the prototype — the
 * full 8.0 enablement would fetch them via an `AgentClient` injected
 * by the auto-negotiation surface.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import type { CanonicalFormatKind, V1FormatId } from './types';

/**
 * v1 format definition shape from `reference-formats.json`. Only carries
 * the fields the projection algorithm reads — name/description and the
 * full asset/macro/requirement bodies are passed through opaquely when
 * the caller wants them.
 */
export interface V1FormatDefinition {
  format_id: V1FormatId;
  name?: string;
  description?: string;
  type?: string;
  accepts_parameters?: string[];
  assets?: Array<{
    item_type?: string;
    asset_id?: string;
    required?: boolean;
    asset_type?: string;
    requirements?: Record<string, unknown>;
  }>;
  /**
   * v2 canonical kind this v1 format projects to. Present on 32 of the
   * 57 AAO catalog entries at 3.1-beta GA. Absent entries fall through
   * to the registry / structural-match steps of the resolution order.
   */
  canonical?: CanonicalFormatKind;
  // Pass-through for caller code that wants the rest.
  [k: string]: unknown;
}

interface CatalogIndex {
  /** Keyed by `<normalized-agent-url>::<id>` for O(1) lookup. */
  byKey: Map<string, V1FormatDefinition>;
  entries: V1FormatDefinition[];
}

let cached: CatalogIndex | null = null;

/**
 * Normalize agent_url for indexing. Adds trailing slash when missing.
 * The AAO publishes the canonical form as `https://creative.adcontextprotocol.org/`
 * (with slash); some v2 fixtures use the no-slash form. Both refer to
 * the same agent; this lookup folds them.
 */
function normalizeAgentUrl(u: string): string {
  if (!u) return u;
  return u.endsWith('/') ? u : u + '/';
}

function indexKey(agentUrl: string, id: string): string {
  return `${normalizeAgentUrl(agentUrl)}::${id}`;
}

/**
 * Load the catalog from a known path. Tries the test-fixture location
 * (vendored copy) first, then the workspace `.context/adcp-3307/`
 * checkout if present. Memoized — catalog is small and immutable per
 * spec version.
 *
 * @param explicitPath caller-supplied path; takes precedence over
 *                     fallback resolution.
 */
export function loadCatalog(explicitPath?: string): CatalogIndex {
  if (cached) return cached;

  const candidates = explicitPath
    ? [explicitPath]
    : [
        path.join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          'test',
          'lib',
          'v2-projection-fixtures',
          'aao-reference-formats.json'
        ),
        path.join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          '.context',
          'adcp-3307',
          'server',
          'src',
          'creative-agent',
          'reference-formats.json'
        ),
      ];

  for (const file of candidates) {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as V1FormatDefinition[];
      const byKey = new Map<string, V1FormatDefinition>();
      for (const entry of raw) {
        if (entry?.format_id?.agent_url && entry?.format_id?.id) {
          byKey.set(indexKey(entry.format_id.agent_url, entry.format_id.id), entry);
        }
      }
      cached = { byKey, entries: raw };
      return cached;
    }
  }

  throw new Error(
    `AAO catalog (reference-formats.json) not found. Looked in: ${candidates.join(', ')}. ` +
      `Vendor a copy at test/lib/v2-projection-fixtures/aao-reference-formats.json.`
  );
}

/**
 * Look up a v1 format definition by its format_id. Returns undefined
 * when not in the catalog — caller falls through to registry / structural
 * match per the resolution order.
 */
export function lookupV1Format(formatId: V1FormatId, explicitPath?: string): V1FormatDefinition | undefined {
  const catalog = loadCatalog(explicitPath);
  return catalog.byKey.get(indexKey(formatId.agent_url, formatId.id));
}

/** Test hook: reset the memoized catalog. */
export function _resetCatalogCache(): void {
  cached = null;
}
