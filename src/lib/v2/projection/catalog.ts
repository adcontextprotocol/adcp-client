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
 * Canonical projection reference (`canonical-projection-ref.json` in the
 * 3.1 spec). Always object-shaped: required `kind` + optional
 * `asset_source` + optional `slots_override`. Carries the v2 canonical-
 * format projection for a v1 catalog entry. Generative-AI v1 entries
 * use the rich form (`asset_source: 'agent_synthesized'` +
 * slots_override) so the v2 declaration produced from them carries the
 * generative contract; standard entries use the minimal form
 * (`{ kind }`) and inherit the canonical's default slots.
 */
export interface CanonicalProjectionRef {
  kind: CanonicalFormatKind;
  /** Narrows how the asset is produced (e.g., agent_synthesized for AI generation, buyer_uploaded for native). */
  asset_source?: 'agent_synthesized' | 'buyer_uploaded' | string;
  /** When set, replaces the canonical's default slots with these specifics. */
  slots_override?: Array<{
    asset_group_id: string;
    asset_type?: string;
    required?: boolean;
    [k: string]: unknown;
  }>;
}

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
   * v2 canonical projection. Always object-shaped per
   * `canonical-projection-ref.json`. Absent on entries that have no
   * v2 mapping yet (none at 3.1.0-beta.1 GA — the AAO catalog is
   * 100% annotated; absence is reserved for future un-blessed entries).
   */
  canonical?: CanonicalProjectionRef;
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
 * Load the catalog from a known path. Resolution order:
 *
 *   1. Caller-supplied `explicitPath` (test hook).
 *   2. Adjacent to the compiled loader — `dist/lib/v2/projection/
 *      aao-reference-formats.json`. This is the path that ships in the
 *      published npm tarball; `scripts/copy-v2-projection-catalog.ts`
 *      vendors the file here during `build:lib`.
 *   3. Source-tree test fixture at
 *      `test/lib/v2-projection-fixtures/aao-reference-formats.json`,
 *      relative to the loader's source location. Used when running from
 *      a source checkout (e.g., `tsx` / vitest) before `build:lib`.
 *
 * Memoized — catalog is small and immutable per spec version.
 *
 * @param explicitPath caller-supplied path; takes precedence over
 *                     fallback resolution.
 */
export function loadCatalog(explicitPath?: string): CatalogIndex {
  if (cached) return cached;

  const candidates = explicitPath
    ? [explicitPath]
    : [
        path.join(__dirname, 'aao-reference-formats.json'),
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
    `AAO catalog (aao-reference-formats.json) not found. Looked in: ${candidates.join(', ')}. ` +
      `This indicates a corrupted @adcp/sdk install or an SDK packaging regression — ` +
      `please file an issue at https://github.com/adcontextprotocol/adcp-client/issues with ` +
      `your install method (npm/yarn/pnpm) and Node version. ` +
      `If you're working from a source checkout, run \`npm run build:lib\` first.`
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

/**
 * Find a catalog entry matching `(canonical, width, height)` at the same
 * publisher domain as `agentUrl`. Used by the v2 → v1 multi-size fan-out:
 * when a v2 declaration says `sizes: [W1×H1, W2×H2, ...]` and the
 * seller-asserted `v1_format_ref` points at the catalog entry for one of
 * those sizes, the SDK can look up the entries for the OTHER sizes and
 * emit additional v1 format_ids — giving v1 buyers full size coverage
 * instead of just the rep.
 *
 * The catalog uses a stable id-pattern convention
 * (`<prefix>_<W>x<H>_<suffix>`) for per-size entries — image, html5, and
 * generative all follow it. This function parses ids matching that
 * pattern and matches on extracted dimensions, so the lookup is
 * dimensionally honest without requiring the spec to add explicit
 * width/height fields to catalog entries.
 *
 * Returns undefined when no matching entry exists at this publisher.
 * Caller falls back to the seller-asserted rep + lossy advisory.
 */
const SIZED_ID_RE = /^([a-z]+)_(\d+)x(\d+)_([a-z]+)$/;

/**
 * Extract the `<prefix>_<W>x<H>_<suffix>` template from a sized catalog
 * id. Used by `findCatalogEntryByCanonicalAndSize` to filter fan-out
 * candidates to siblings of the seller-asserted ref. Multiple catalog
 * entries can share the same `canonical:` annotation but represent
 * different families (e.g., `image` is both `display_*_image` and
 * `display_*_generative`); without a suffix filter, fan-out would
 * collide families.
 */
export function parseSizedIdTemplate(id: string): { prefix: string; suffix: string } | undefined {
  const m = id.match(SIZED_ID_RE);
  if (!m) return undefined;
  return { prefix: m[1]!, suffix: m[4]! };
}

export function findCatalogEntryByCanonicalAndSize(
  canonical: CanonicalFormatKind,
  width: number,
  height: number,
  agentUrl: string,
  options?: { prefix?: string; suffix?: string; explicitPath?: string }
): V1FormatDefinition | undefined {
  const catalog = loadCatalog(options?.explicitPath);
  const normalizedAgentUrl = normalizeAgentUrl(agentUrl);
  for (const entry of catalog.entries) {
    if (entry.canonical?.kind !== canonical) continue;
    if (!entry.format_id?.id || !entry.format_id?.agent_url) continue;
    if (normalizeAgentUrl(entry.format_id.agent_url) !== normalizedAgentUrl) continue;
    const m = entry.format_id.id.match(SIZED_ID_RE);
    if (!m) continue;
    const [, prefix, wStr, hStr, suffix] = m;
    if (options?.prefix && prefix !== options.prefix) continue;
    if (options?.suffix && suffix !== options.suffix) continue;
    if (parseInt(wStr!, 10) === width && parseInt(hStr!, 10) === height) {
      return entry;
    }
  }
  return undefined;
}
