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
 * Minimum @adcp/client version in which each server-side helper first shipped.
 * Used to suffix shape-drift hints when the agent reports an older SDK version.
 * Keys match the helper name referenced in the hint `message`.
 */
const HELPER_MIN_VERSION: Record<string, string> = {
  buildCreativeResponse: '5.14.0',
  listCreativesResponse: '5.10.0',
  listCreativeFormatsResponse: '5.10.0',
  listAccountsResponse: '5.10.0',
  productsResponse: '5.10.0',
  getMediaBuysResponse: '5.10.0',
  getSignalsResponse: '5.10.0',
  listPropertyListsResponse: '5.10.0',
  listCollectionListsResponse: '5.10.0',
  listContentStandardsResponse: '5.10.0',
  getPlanAuditLogsResponse: '5.10.0',
  syncCreativesResponse: '5.10.0',
  previewCreativeResponse: '5.10.0',
};

/**
 * Compare two semver strings using numeric segment ordering.
 * Returns true when `a` is strictly less than `b`.
 * Handles `@adcp/client@X.Y.Z` format by stripping the package prefix.
 */
function semverLessThan(a: string, b: string): boolean {
  // Strip package prefix (e.g. "@adcp/client@") and pre-release suffix (e.g. "-beta.1")
  const normalize = (v: string) => v.replace(/^.*@/, '').replace(/-.*$/, '');
  const segs = (v: string) =>
    normalize(v)
      .split('.')
      .map(s => parseInt(s, 10) || 0);
  const [aMaj, aMin, aPatch] = segs(a);
  const [bMaj, bMin, bPatch] = segs(b);
  if (aMaj !== bMaj) return aMaj < bMaj;
  if (aMin !== bMin) return aMin < bMin;
  return aPatch < bPatch;
}

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
  get_plan_audit_logs: { wrapperKey: 'plans', helper: 'getPlanAuditLogsResponse' },
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
 * @param libraryVersion — optional SDK version string the agent self-reported
 *   in `get_adcp_capabilities` (e.g. `"@adcp/client@4.16.2"`). When present
 *   and below the helper's minimum version, the hint message is suffixed with
 *   an upgrade note so developers know to update their SDK dep.
 */
export function detectShapeDriftHints(taskName: string, payload: unknown, libraryVersion?: string): ShapeDriftHint[] {
  const hint = detect(taskName, payload);
  if (!hint) return [];
  if (libraryVersion) hint.message = appendVersionSuffix(hint.message, libraryVersion);
  return [hint];
}

/**
 * If the hint message references a helper that requires a minimum SDK
 * version and the agent's reported version is below it, append an upgrade
 * note to the message. Returns the message unchanged if no version data or
 * no match.
 */
function appendVersionSuffix(message: string, libraryVersion: string): string {
  // Skip non-numeric version strings (e.g. "local-dev") to avoid spurious suffixes
  const stripped = libraryVersion.replace(/^.*@/, '').replace(/-.*$/, '');
  if (!/^\d+\.\d+/.test(stripped)) return message;
  for (const [helper, minVersion] of Object.entries(HELPER_MIN_VERSION)) {
    if (message.includes(helper) && semverLessThan(libraryVersion, minVersion)) {
      return (
        message +
        ` (Note: your agent reports ${libraryVersion} — ${helper}() ships in @adcp/client ≥${minVersion}. Upgrade your SDK dep.)`
      );
    }
  }
  return message;
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
