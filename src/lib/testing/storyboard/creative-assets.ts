import type { StoryboardContext } from './types';

export const BUILD_ASSETS_FROM_FORMAT_DIRECTIVE = '$build_assets_from_format';

type JsonObject = Record<string, unknown>;

interface Dimensions {
  width?: number;
  height?: number;
}

interface RequiredSlot extends Dimensions {
  id: string;
  assetType: string;
}

type AssetsBuildFailure =
  | {
      reason: 'format_not_found' | 'malformed_directive';
      constraint: string;
    }
  | {
      reason: 'fixture_unavailable';
      slotId: string;
      assetType: string;
      constraint: string;
    };

export type CreativeAssetExpansionFailure = AssetsBuildFailure & { path: string };

export type CreativeAssetExpansionResult =
  | { ok: true; value: unknown }
  | { ok: false; value: unknown; failure: CreativeAssetExpansionFailure };

type AssetBuildResult = { ok: true; asset: JsonObject } | { ok: false; constraint: string };

type AssetsBuildResult = { ok: true; assets: JsonObject } | { ok: false; failure: AssetsBuildFailure };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeAgentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\/$/, '');
}

function formatIdMatches(candidate: unknown, requested: JsonObject): boolean {
  if (!isObject(candidate)) return false;
  if (candidate.id !== requested.id) return false;
  const requestedAgent = normalizeAgentUrl(requested.agent_url);
  const candidateAgent = normalizeAgentUrl(candidate.agent_url);
  return requestedAgent === undefined || candidateAgent === requestedAgent;
}

function resolveFormat(
  value: unknown,
  context: StoryboardContext
):
  | { ok: true; format: JsonObject }
  | { ok: false; reason: 'format_not_found' | 'malformed_directive'; constraint: string } {
  if (!isObject(value)) {
    return {
      ok: false,
      reason: 'malformed_directive',
      constraint: 'directive value must be a format object or FormatId',
    };
  }
  if (Array.isArray(value.slots) || Array.isArray(value.assets) || Array.isArray(value.assets_required)) {
    return { ok: true, format: value };
  }

  if (typeof value.id !== 'string') {
    return { ok: false, reason: 'malformed_directive', constraint: 'format reference must contain a string id' };
  }
  const formats = Array.isArray(context.formats) ? context.formats : [];
  const format = formats.find(
    (candidate): candidate is JsonObject => isObject(candidate) && formatIdMatches(candidate.format_id, value)
  );
  if (!format) {
    const agent = typeof value.agent_url === 'string' ? ` from ${value.agent_url}` : '';
    return {
      ok: false,
      reason: 'format_not_found',
      constraint: `format "${value.id}"${agent} is absent from storyboard context.formats`,
    };
  }
  return { ok: true, format };
}

function dimensionsFromId(format: JsonObject): Dimensions {
  const formatId = isObject(format.format_id) ? format.format_id.id : undefined;
  const match = typeof formatId === 'string' ? formatId.match(/(?:^|_)(\d{2,4})x(\d{2,4})(?:_|$)/i) : null;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : {};
}

function formatDimensions(format: JsonObject): Dimensions {
  const direct = { width: asNumber(format.width), height: asNumber(format.height) };
  if (direct.width !== undefined || direct.height !== undefined) return direct;

  const renders = Array.isArray(format.renders) ? format.renders : [];
  for (const render of renders) {
    if (!isObject(render)) continue;
    const dimensions = isObject(render.dimensions) ? render.dimensions : render;
    const width = asNumber(dimensions.width);
    const height = asNumber(dimensions.height);
    if (width !== undefined || height !== undefined) return { width, height };
  }

  return dimensionsFromId(format);
}

function slotDimensions(slot: JsonObject, fallback: Dimensions): Dimensions {
  const requirements = isObject(slot.requirements) ? slot.requirements : {};
  const nested = isObject(requirements.dimensions) ? requirements.dimensions : requirements;
  return {
    width: asNumber(slot.width) ?? asNumber(nested.width) ?? fallback.width,
    height: asNumber(slot.height) ?? asNumber(nested.height) ?? fallback.height,
  };
}

function requiredSlots(format: JsonObject): RequiredSlot[] {
  const canonicalSlots = Array.isArray(format.slots) ? format.slots : undefined;
  const legacySlots = Array.isArray(format.assets)
    ? format.assets
    : Array.isArray(format.assets_required)
      ? format.assets_required
      : undefined;
  const slots = canonicalSlots ?? legacySlots ?? [];
  const fallback = formatDimensions(format);

  return slots.flatMap(slotValue => {
    if (!isObject(slotValue) || slotValue.required !== true) return [];
    const id = canonicalSlots ? slotValue.asset_group_id : slotValue.asset_id;
    if (typeof id !== 'string' || typeof slotValue.asset_type !== 'string') return [];
    return [{ id, assetType: slotValue.asset_type, ...slotDimensions(slotValue, fallback) }];
  });
}

function imageConstraint(slot: RequiredSlot): string {
  if (slot.width !== undefined && slot.height !== undefined) {
    return `requires an exact ${slot.width}x${slot.height} image fixture`;
  }
  if (slot.width !== undefined) return `requires an image fixture with exact width ${slot.width}`;
  if (slot.height !== undefined) return `requires an image fixture with exact height ${slot.height}`;
  return 'requires an image fixture with a URL';
}

function buildImage(slot: RequiredSlot, assets: JsonObject): AssetBuildResult {
  const images = Array.isArray(assets.images) ? assets.images.filter(isObject) : [];
  const image = images.find(candidate => {
    const widthMatches = slot.width === undefined || candidate.width === slot.width;
    const heightMatches = slot.height === undefined || candidate.height === slot.height;
    return widthMatches && heightMatches;
  });
  if (!image) return { ok: false, constraint: imageConstraint(slot) };
  if (typeof image.url !== 'string') {
    return { ok: false, constraint: `${imageConstraint(slot)}, but the matching fixture has no URL` };
  }
  return {
    ok: true,
    asset: {
      asset_type: 'image',
      url: image.url,
      ...(asNumber(image.width) !== undefined ? { width: image.width } : {}),
      ...(asNumber(image.height) !== undefined ? { height: image.height } : {}),
      ...(typeof image.mime_type === 'string' ? { mime_type: image.mime_type } : {}),
    },
  };
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === 'string') : undefined;
}

function buildText(slot: RequiredSlot, assets: JsonObject): AssetBuildResult {
  const text = isObject(assets.text) ? assets.text : {};
  const id = slot.id.toLowerCase();
  const fixtureCategory = {
    headline: 'headlines',
    title: 'headlines',
    description: 'descriptions',
    body: 'descriptions',
    body_text: 'descriptions',
    primary_text: 'descriptions',
    cta: 'cta',
    cta_text: 'cta',
    call_to_action: 'cta',
  }[id];
  if (fixtureCategory === undefined) {
    return {
      ok: false,
      constraint: 'slot id has no exact runner mapping to a headlines, descriptions, or CTA fixture category',
    };
  }
  const content = firstString(text[fixtureCategory]);
  return content === undefined
    ? { ok: false, constraint: `requires a ${fixtureCategory} text fixture` }
    : { ok: true, asset: { asset_type: 'text', content } };
}

function buildAsset(slot: RequiredSlot, testKit: unknown): AssetBuildResult {
  if (!isObject(testKit) || !isObject(testKit.assets)) {
    return { ok: false, constraint: 'selected test kit does not declare asset fixtures' };
  }
  const assets = testKit.assets;
  if (slot.assetType === 'image') return buildImage(slot, assets);
  if (slot.assetType === 'url' && typeof assets.click_url === 'string') {
    return { ok: true, asset: { asset_type: 'url', url: assets.click_url } };
  }
  if (slot.assetType === 'url') return { ok: false, constraint: 'requires a click_url fixture' };
  if (slot.assetType === 'text') return buildText(slot, assets);
  return { ok: false, constraint: `asset type "${slot.assetType}" is not supported by the selected test kit` };
}

function buildAssets(value: unknown, context: StoryboardContext, testKit: unknown): AssetsBuildResult {
  const resolved = resolveFormat(value, context);
  if (!resolved.ok) {
    return { ok: false, failure: { reason: resolved.reason, constraint: resolved.constraint } };
  }
  const slots = requiredSlots(resolved.format);

  const built: JsonObject = {};
  for (const slot of slots) {
    const result = buildAsset(slot, testKit);
    if (!result.ok) {
      return {
        ok: false,
        failure: {
          reason: 'fixture_unavailable',
          slotId: slot.id,
          assetType: slot.assetType,
          constraint: result.constraint,
        },
      };
    }
    built[slot.id] = result.asset;
  }
  return { ok: true, assets: built };
}

function expandWithDiagnostics(
  value: unknown,
  context: StoryboardContext,
  testKit: unknown,
  path: string
): CreativeAssetExpansionResult {
  if (Array.isArray(value)) {
    const expanded = Array.from(value as unknown[]);
    for (let index = 0; index < value.length; index += 1) {
      const result = expandWithDiagnostics(value[index], context, testKit, `${path}[${index}]`);
      expanded[index] = result.value;
      if (!result.ok) return { ...result, value: expanded };
    }
    return { ok: true, value: expanded };
  }
  if (!isObject(value)) return { ok: true, value };

  if (Object.prototype.hasOwnProperty.call(value, BUILD_ASSETS_FROM_FORMAT_DIRECTIVE)) {
    const built = buildAssets(value[BUILD_ASSETS_FROM_FORMAT_DIRECTIVE], context, testKit);
    if (!built.ok) {
      return {
        ok: false,
        value,
        failure: {
          ...built.failure,
          path: `${path}.${BUILD_ASSETS_FROM_FORMAT_DIRECTIVE}`,
        },
      };
    }
    const siblings: JsonObject = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== BUILD_ASSETS_FROM_FORMAT_DIRECTIVE)
    );
    for (const [key, item] of Object.entries(value)) {
      if (key === BUILD_ASSETS_FROM_FORMAT_DIRECTIVE) continue;
      const result = expandWithDiagnostics(item, context, testKit, `${path}.${key}`);
      siblings[key] = result.value;
      if (!result.ok) return { ...result, value: { ...siblings, ...built.assets } };
    }
    return { ok: true, value: { ...siblings, ...built.assets } };
  }

  const expanded: JsonObject = { ...value };
  for (const [key, item] of Object.entries(value)) {
    const result = expandWithDiagnostics(item, context, testKit, `${path}.${key}`);
    expanded[key] = result.value;
    if (!result.ok) return { ...result, value: expanded };
  }
  return { ok: true, value: expanded };
}

/** Expand reserved storyboard creative-asset directives and preserve the first failure diagnostic. */
export function expandCreativeAssetDirectivesWithDiagnostics(
  value: unknown,
  context: StoryboardContext,
  testKit: unknown
): CreativeAssetExpansionResult {
  return expandWithDiagnostics(value, context, testKit, '$');
}

/** Expand reserved storyboard creative-asset directives without mutating the fixture. */
export function expandCreativeAssetDirectives(value: unknown, context: StoryboardContext, testKit: unknown): unknown {
  return expandCreativeAssetDirectivesWithDiagnostics(value, context, testKit).value;
}

export function findUnresolvedCreativeAssetDirectives(value: unknown): string[] {
  const paths: string[] = [];
  const walk = (item: unknown, path: string) => {
    if (Array.isArray(item)) {
      item.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (!isObject(item)) return;
    if (Object.prototype.hasOwnProperty.call(item, BUILD_ASSETS_FROM_FORMAT_DIRECTIVE)) {
      paths.push(`${path}.${BUILD_ASSETS_FROM_FORMAT_DIRECTIVE}`);
    }
    Object.entries(item).forEach(([key, entry]) => walk(entry, path ? `${path}.${key}` : key));
  };
  walk(value, '$');
  return paths;
}
