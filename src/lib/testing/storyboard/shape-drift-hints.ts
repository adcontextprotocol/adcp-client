/**
 * Structured shape-drift hint detection (issue #935).
 *
 * The runner emits one `ShapeDriftHint` per response when it recognizes a
 * common payload-shape mistake — bare arrays from list tools, platform-
 * native fields from `build_creative`, missing wrappers on `sync_creatives`
 * / `preview_creative`. Each hint carries the same prose the legacy
 * `detectShapeDriftHint` returned, plus structured fields (`tool`,
 * `observed_variant`, `expected_variant`, `instance_path`) so renderers
 * (CLI, Addie, JUnit, SARIF) can build per-case fix plans without re-
 * parsing the message.
 *
 * The string-only `detectShapeDriftHint` in `validations.ts` is a thin
 * shim over this detector — kept so existing unit tests and external
 * callers keep working, but the canonical path is structured.
 *
 * Fires unconditionally (regardless of step pass/fail) — same gate as
 * `ValidationResult.warning` carried previously. The caller (`runner.ts`)
 * merges the result into `StoryboardStepResult.hints[]`.
 */
import type { ShapeDriftHint } from './types';

/**
 * List-shaped tools where handlers commonly return the bare inner array
 * (`[{...}]`) at the top level instead of wrapping it in the required
 * object envelope. Each entry names the wrapper key and the response
 * helper that builds the correct shape.
 *
 * Helper names aren't uniformly prefixed — `get_products` uses
 * `productsResponse` (no `get` prefix) while `get_media_buys` uses
 * `getMediaBuysResponse`. Names match the exports in
 * `src/lib/server/responses.ts` verbatim so a developer can grep
 * straight from the hint.
 */
export const LIST_WRAPPER_TOOLS: Record<string, { wrapperKey: string; helper: string }> = {
  list_creatives: { wrapperKey: 'creatives', helper: 'listCreativesResponse' },
  list_creative_formats: { wrapperKey: 'formats', helper: 'listCreativeFormatsResponse' },
  list_accounts: { wrapperKey: 'accounts', helper: 'listAccountsResponse' },
  get_products: { wrapperKey: 'products', helper: 'productsResponse' },
  get_media_buys: { wrapperKey: 'media_buys', helper: 'getMediaBuysResponse' },
  get_signals: { wrapperKey: 'signals', helper: 'getSignalsResponse' },
  list_property_lists: { wrapperKey: 'lists', helper: 'listPropertyListsResponse' },
  list_collection_lists: { wrapperKey: 'lists', helper: 'listCollectionListsResponse' },
  list_content_standards: { wrapperKey: 'standards', helper: 'listContentStandardsResponse' },
};

/**
 * Detect shape-drift and return the structured hints that apply (zero or
 * one — the detector emits at most one hint per response, but returns an
 * array so callers can spread it into `step.hints[]` without a guard).
 *
 * @param taskName — tool name (snake_case) the storyboard dispatched under
 * @param payload — raw response payload, after the runner's `_message`
 *   pre-strip. `unknown` rather than `Record<string, unknown>` so bare-
 *   array payloads are recognizable at the top level; object branches
 *   guard internally.
 */
export function detectShapeDriftHints(taskName: string, payload: unknown): ShapeDriftHint[] {
  const hint = detect(taskName, payload);
  return hint ? [hint] : [];
}

function detect(taskName: string, payload: unknown): ShapeDriftHint | undefined {
  if (Array.isArray(payload)) {
    const listMeta = LIST_WRAPPER_TOOLS[taskName];
    if (!listMeta) return undefined;
    return {
      kind: 'shape_drift',
      tool: taskName,
      observed_variant: 'bare_array',
      expected_variant: `{ ${listMeta.wrapperKey}: [...] }`,
      instance_path: '',
      message:
        `${taskName} returned a bare array at the top level. ` +
        `Required: { ${listMeta.wrapperKey}: [...] }. ` +
        `Use ${listMeta.helper}() from @adcp/client/server.`,
    };
  }

  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;

  if (taskName === 'build_creative') {
    const hasManifest = 'creative_manifest' in p || 'creative_manifests' in p;
    const platformNativeKeys = ['tag_url', 'creative_id', 'media_type', 'tag_type'];
    const platformNativePresent = platformNativeKeys.filter(k => k in p);
    if (!hasManifest && platformNativePresent.length > 0) {
      return {
        kind: 'shape_drift',
        tool: taskName,
        observed_variant: 'platform_native_fields',
        expected_variant: '{ creative_manifest: { format_id, assets } }',
        instance_path: '',
        message:
          `build_creative returned platform-native fields at the top level (${platformNativePresent.join(', ')}). ` +
          `Required: { creative_manifest: { format_id, assets } }. ` +
          `Use buildCreativeResponse() from @adcp/client/server.`,
      };
    }
  }

  if (taskName === 'sync_creatives') {
    const hasValidWrapper = 'creatives' in p || 'errors' in p || 'task_id' in p;
    const perItemKeys = ['creative_id', 'platform_id', 'action'];
    const perItemPresent = perItemKeys.filter(k => k in p);
    if (!hasValidWrapper && perItemPresent.length > 0) {
      return {
        kind: 'shape_drift',
        tool: taskName,
        observed_variant: 'per_item_shape',
        expected_variant: '{ creatives: [{ creative_id, action, ... }] }',
        instance_path: '',
        message:
          `sync_creatives returned a single creative's inner shape at the top level (${perItemPresent.join(', ')}). ` +
          `Required: { creatives: [{ creative_id, action, ... }] } (or { errors: [...] } / { status: 'submitted', task_id }). ` +
          `Use syncCreativesResponse() from @adcp/client/server.`,
      };
    }

    const results = p.results;
    if (!hasValidWrapper && Array.isArray(results) && results.length > 0) {
      const firstRow = results[0];
      const looksLikeCreativeRow =
        firstRow != null && typeof firstRow === 'object' && ('creative_id' in firstRow || 'action' in firstRow);
      if (looksLikeCreativeRow) {
        return {
          kind: 'shape_drift',
          tool: taskName,
          observed_variant: 'wrong_wrapper_key',
          expected_variant: '{ creatives: [{ creative_id, action, ... }] }',
          instance_path: '/results',
          message:
            `sync_creatives returned { results: [...] } instead of { creatives: [...] } — wrong wrapper key. ` +
            `Required: { creatives: [{ creative_id, action, ... }] }. ` +
            `Use syncCreativesResponse() from @adcp/client/server.`,
        };
      }
    }
  }

  if (taskName === 'preview_creative') {
    const hasValidWrapper = 'response_type' in p || 'previews' in p || 'results' in p;
    const rawRenderKeys = ['preview_url', 'preview_html', 'interactive_url'];
    const rawRenderPresent = rawRenderKeys.filter(k => k in p);
    const driftSignal = rawRenderPresent.filter(k => k !== 'interactive_url');
    if (!hasValidWrapper && driftSignal.length > 0) {
      return {
        kind: 'shape_drift',
        tool: taskName,
        observed_variant: 'raw_render_fields',
        expected_variant: "{ response_type: 'single', previews: [{ renders: [...] }], expires_at }",
        instance_path: '',
        message:
          `preview_creative returned raw render fields at the top level (${driftSignal.join(', ')}). ` +
          `Required: { response_type: 'single', previews: [{ renders: [{ preview_url | preview_html }] }], expires_at }. ` +
          `Use previewCreativeResponse() from @adcp/client/server.`,
      };
    }
  }

  return undefined;
}
