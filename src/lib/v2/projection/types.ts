/**
 * Hand-rolled type surface for the v2 → v1 projection prototype.
 *
 * These shadow `schemas/cache/3.1.0-beta.0/core/{product,product-format-declaration,format-id}.json`
 * at the precision the projection layer cares about — slot-level fields
 * like `slots[]`, `platform_extensions[]`, and per-canonical params blocks
 * are kept loose (`Record<string, unknown>`) because the projection
 * algorithm doesn't read them. When the SDK's full versioned codegen
 * lands (separate piece of 8.0), these get replaced by generated types.
 *
 * Not exported from the SDK barrel — projection callers consume the
 * normalized shape via `projectV2ProductToV1`'s return type.
 */

/** v1 format_id (`{ agent_url, id }`). Same shape in 3.0 and 3.1. */
export interface V1FormatId {
  agent_url: string;
  id: string;
  width?: number;
  height?: number;
  duration_ms?: number;
}

/**
 * 12 canonical `format_kind` values from
 * `static/schemas/source/formats/canonical/` plus the `custom` escape
 * hatch. Kept as a literal union so a future canonical gets surfaced at
 * the projection's switch statement (exhaustive-check).
 */
export type CanonicalFormatKind =
  | 'image'
  | 'html5'
  | 'display_tag'
  | 'image_carousel'
  | 'video_hosted'
  | 'video_vast'
  | 'audio_hosted'
  | 'audio_daast'
  | 'sponsored_placement'
  | 'responsive_creative'
  | 'agent_placement'
  | 'custom';

/**
 * v2 `ProductFormatDeclaration`. The `params` object is canonical-specific
 * and stays loose at this layer — the projection algorithm reads only
 * `format_kind`, `v1_format_ref`, and `canonical_formats_only`. Width /
 * height (for image canonicals) are surfaced as optional top-level fields
 * the registry reverse-lookup can read without unwrapping params.
 */
export interface V2ProductFormatDeclaration {
  format_kind: CanonicalFormatKind;
  params: Record<string, unknown>;
  capability_id?: string;
  display_name?: string;
  applies_to_channels?: string[];
  canonical_formats_only?: boolean;
  experimental?: boolean;
  format_shape?: string;
  v1_format_ref?: V1FormatId;
  format_schema?: { uri: string; digest: string };
}

/**
 * Public-surface Product (V2-shaped per the 8.0 design at
 * `docs/development/v3.1-sdk-design.md`). All other fields are passthrough.
 */
export interface V2Product {
  product_id: string;
  name: string;
  description: string;
  format_options: V2ProductFormatDeclaration[];
  [k: string]: unknown;
}

/**
 * Wire-level v1 Product. Carries `format_ids` (the v1 path). Other fields
 * are passthrough; we don't model them at the projection layer.
 */
export interface V1Product {
  product_id: string;
  name: string;
  description: string;
  format_ids: V1FormatId[];
  [k: string]: unknown;
}

/**
 * Structured channel for projection failures and lossy downgrades, per
 * `v1-canonical-mapping.json`'s resolution-order amendment. **Never
 * logger-only** — emitted on the response envelope's `errors[]` and on
 * the SDK's `TaskResult` so callers can react.
 */
export type ProjectionDiagnostic =
  | {
      code: 'FORMAT_DECLARATION_V1_UNREACHABLE';
      field: string;
      details: {
        format_kind: CanonicalFormatKind;
        capability_id?: string;
        reason: 'canonical_formats_only' | 'no_v1_format_ref_or_registry_match';
        hint?: string;
      };
    }
  | {
      code: 'FORMAT_DECLARATION_V1_AMBIGUOUS';
      field: string;
      details: {
        format_kind: CanonicalFormatKind;
        capability_id?: string;
        matched_registry_entries: number;
        hint?: string;
      };
    };
