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
 * Structured diagnostic shape matching the spec's `errors[]` augmentation
 * contract (`source: "sdk"`, `sdk_id`, `code`, `field`, `error.details`).
 * Spec codes — `FORMAT_PROJECTION_FAILED` and `FORMAT_DECLARATION_V1_AMBIGUOUS`
 * — come straight from `enums/error-code.json`. The two SDK-local codes
 * (`*_NOT_APPLICABLE`, `CANONICAL_NOT_V1_TRANSLATABLE`) cover cases the
 * spec leaves to SDK discretion ("surface as a different diagnostic or
 * skip silently") but where buyer-side transparency is more useful
 * than silent product drops.
 *
 * **Never logger-only**, per the resolution-order amendment — emitted
 * on the response envelope's `errors[]` array and surfaced on the
 * SDK's `TaskResult` for caller-side handling without re-walking
 * `errors[]`.
 */
export interface ProjectionDiagnosticBase {
  /** Spec-mandated origin marker for SDK-augmented diagnostics. */
  source: 'sdk';
  /** Spec-mandated SDK identity for multi-hop deduplication. */
  sdk_id: string;
  /** Field path into the offending declaration. */
  field: string;
}

export type ProjectionDiagnostic =
  | (ProjectionDiagnosticBase & {
      /**
       * Spec code (`enums/error-code.json`): registry-coverage gap or
       * v1-catalog-coverage gap depending on `resolution_failure`:
       *
       *   - `no_registry_match` — v2→v1 direction. Registry has no
       *     entries for this canonical (and v1_translatable is true).
       *   - `catalog_lacks_canonical_annotation` — v1→v2 direction.
       *     The AAO catalog has this v1 format but hasn't annotated
       *     it with a `canonical:` field. Native, DOOH, broadcast,
       *     and card-scaffolding categories sit in this bucket at
       *     3.1 GA. Distinct from a generic registry gap — the
       *     catalog DOES know the format, it just hasn't blessed a
       *     v2 canonical mapping yet. Symmetric counterpart to
       *     CANONICAL_NOT_V1_TRANSLATABLE: that signals "no v1 form
       *     possible"; this signals "no v2 form yet."
       *   - `no_match` — v1→v2 direction, format not in catalog or
       *     registry, no structural match.
       */
      code: 'FORMAT_PROJECTION_FAILED';
      error: {
        details: {
          format_kind: CanonicalFormatKind;
          product_id: string;
          capability_id?: string;
          resolution_failure: 'no_registry_match' | 'catalog_lacks_canonical_annotation' | 'no_match';
        };
      };
    })
  | (ProjectionDiagnosticBase & {
      /**
       * Spec code (`enums/error-code.json`): registry has family-level
       * structural entries for this canonical (e.g., the VAST entries
       * for `video_vast`), but none are invertible to a specific v1
       * named format. Family is known, specific format isn't pickable.
       * Correctable by the seller adding `v1_format_ref` to the
       * declaration.
       */
      code: 'FORMAT_DECLARATION_V1_AMBIGUOUS';
      error: {
        details: {
          format_kind: CanonicalFormatKind;
          product_id: string;
          capability_id?: string;
          registry_matches: number;
        };
      };
    })
  | (ProjectionDiagnosticBase & {
      /**
       * SDK-local code: declaration has `canonical_formats_only: true`.
       * Seller explicitly opted out of v1 emission. Not a registry-
       * coverage gap; not ambiguous. Informational so buyers can see
       * why a product disappeared from a v1-only catalog.
       */
      code: 'FORMAT_DECLARATION_V1_NOT_APPLICABLE';
      error: {
        details: {
          format_kind: CanonicalFormatKind;
          product_id: string;
          capability_id?: string;
          reason: 'canonical_formats_only';
        };
      };
    })
  | (ProjectionDiagnosticBase & {
      /**
       * SDK-local code: canonical declares `v1_translatable: false`.
       * Structural v1-unreachability — no v1 form is possible for this
       * canonical regardless of registry coverage. The 4 inherently-v2
       * canonicals at 3.1 GA: `image_carousel`, `sponsored_placement`,
       * `responsive_creative`, `agent_placement`. Spec is explicit:
       * **SDKs MUST NOT emit `FORMAT_PROJECTION_FAILED`** for these
       * (they're not coverage gaps).
       */
      code: 'CANONICAL_NOT_V1_TRANSLATABLE';
      error: {
        details: {
          format_kind: CanonicalFormatKind;
          product_id: string;
          capability_id?: string;
        };
      };
    })
  | (ProjectionDiagnosticBase & {
      /**
       * SDK-local code: v2 declaration uses multi-size (`sizes: [...]`)
       * or responsive (`min_width`/`max_width`/`min_height`/`max_height`)
       * params, but `v1_format_ref` is a single catalog entry that can
       * only carry ONE fixed (width, height). The v1 wire emit
       * represents only the seller-chosen representative size; the
       * remaining sizes are **silently dropped on the v1 wire**.
       *
       * This diagnostic is emitted **alongside** the v1 format_id —
       * not instead of it — so the v1 buyer still sees the product
       * but the buyer code is told what coverage was lost. Different
       * from FORMAT_DECLARATION_V1_AMBIGUOUS (no v1 emit) and
       * FORMAT_DECLARATION_V1_NOT_APPLICABLE (seller opt-out).
       *
       * Surface follow-up: an SDK MAY (non-normative) expand multi-
       * size to N v1 format_ids by looking up the catalog for each
       * size. Today's prototype emits only the seller-asserted
       * representative; multi-emit is a follow-up.
       */
      code: 'FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE';
      error: {
        details: {
          format_kind: CanonicalFormatKind;
          product_id: string;
          capability_id?: string;
          size_mode: 'sizes' | 'responsive_range';
          declared_sizes_count?: number;
          v1_emit_represents_size?: { width?: number; height?: number };
        };
      };
    });
