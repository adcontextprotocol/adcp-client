// Typed factory helpers for `Format.renders[]` entries (format declarations
// returned by `list_creative_formats`).
//
// The `Format.renders[]` item schema carries a `oneOf` on its shape:
//   - branch A: `dimensions` required, `parameters_from_format_id` forbidden
//   - branch B: `parameters_from_format_id: true` required, `dimensions` forbidden
//
// A render with only `{ role }` fails `oneOf` — neither branch is satisfied.
// Audio formats in particular cannot use `{ role, duration_seconds }` as a
// standalone render (duration_seconds isn't a recognized `renders[]` field and
// wouldn't satisfy the oneOf anyway). Audio/template formats must declare
// `parameters_from_format_id: true` so the format_id parameters carry
// codec / duration / sampling-rate — which is how AdCP's template-format model
// already works.
//
// These builders enforce the oneOf branch at the type level so `renders[]` can't
// drift out of the schema when written by hand. They parallel the asset-
// builders and preview-render-builders pattern.
//
// NOTE: this file targets `Format.renders[]` (format declarations). The
// existing `render-builders.ts` targets `PreviewRender` (`preview_creative`
// responses). The two are unrelated and use separate namespace exports
// (`FormatRender` vs `Render`) to prevent name collision.

/** Dimensions sub-object — shared between display and video formats. */
export interface RenderDimensions {
  width: number;
  height: number;
  /** Unit defaults to pixels. Set explicitly for non-pixel formats (e.g. DOOH physical dimensions). */
  unit?: string;
}

/** Fixed-dimensions render — display banners, video placements, any format with a known W×H. */
export interface DimensionsRender {
  role: string;
  dimensions: RenderDimensions;
}

/**
 * Parameterized render — format carries its render spec in the format_id
 * parameters. Required for audio formats (no W×H) and for template formats
 * whose dimensions/duration are caller-chosen via `accepts_parameters`.
 */
export interface ParameterizedRender {
  role: string;
  parameters_from_format_id: true;
}

/**
 * Build a fixed-dimensions render entry. Use for display banners, video ads,
 * and any format with a known width × height.
 *
 * @example
 *   displayRender({ role: 'primary', dimensions: { width: 300, height: 250 } })
 */
export function displayRender(fields: { role: string; dimensions: RenderDimensions }): DimensionsRender {
  return { role: fields.role, dimensions: fields.dimensions };
}

/**
 * Build a parameterized render entry. Use for audio formats and template
 * formats whose render parameters come from `format_id.parameters`.
 * `parameters_from_format_id: true` is injected.
 *
 * @example
 *   parameterizedRender({ role: 'primary' })
 *   // → { role: 'primary', parameters_from_format_id: true }
 */
export function parameterizedRender(fields: { role: string }): ParameterizedRender {
  return { role: fields.role, parameters_from_format_id: true };
}

// No grouped namespace on this file — `FormatRender` is already an exported
// interface (v3 structural type) in `utils/format-renders.ts`. Callers use
// the named exports directly. `@adcp/client` exports a `Render` namespace
// from `render-builders.ts` that is scoped to `preview_creative` response
// renders — those are a different concept from `Format.renders[]`.
