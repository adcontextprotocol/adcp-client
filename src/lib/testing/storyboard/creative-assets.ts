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

function resolveFormat(value: unknown, context: StoryboardContext): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  if (Array.isArray(value.slots) || Array.isArray(value.assets) || Array.isArray(value.assets_required)) {
    return value;
  }

  if (typeof value.id !== 'string') return undefined;
  const formats = Array.isArray(context.formats) ? context.formats : [];
  return formats.find(
    (candidate): candidate is JsonObject => isObject(candidate) && formatIdMatches(candidate.format_id, value)
  );
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

function buildImage(slot: RequiredSlot, assets: JsonObject): JsonObject | undefined {
  const images = Array.isArray(assets.images) ? assets.images.filter(isObject) : [];
  const image = images.find(candidate => {
    const widthMatches = slot.width === undefined || candidate.width === slot.width;
    const heightMatches = slot.height === undefined || candidate.height === slot.height;
    return widthMatches && heightMatches;
  });
  if (!image || typeof image.url !== 'string') return undefined;
  return {
    asset_type: 'image',
    url: image.url,
    ...(asNumber(image.width) !== undefined ? { width: image.width } : {}),
    ...(asNumber(image.height) !== undefined ? { height: image.height } : {}),
    ...(typeof image.mime_type === 'string' ? { mime_type: image.mime_type } : {}),
  };
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === 'string') : undefined;
}

function buildText(slot: RequiredSlot, assets: JsonObject): JsonObject | undefined {
  const text = isObject(assets.text) ? assets.text : {};
  const id = slot.id.toLowerCase();
  const content = id.includes('headline')
    ? firstString(text.headlines)
    : id.includes('description') || id.includes('body')
      ? firstString(text.descriptions)
      : id.includes('cta') || id.includes('call_to_action')
        ? firstString(text.cta)
        : (firstString(text.headlines) ?? firstString(text.descriptions) ?? firstString(text.cta));
  return content === undefined ? undefined : { asset_type: 'text', content };
}

function buildAsset(slot: RequiredSlot, testKit: unknown): JsonObject | undefined {
  if (!isObject(testKit) || !isObject(testKit.assets)) return undefined;
  const assets = testKit.assets;
  if (slot.assetType === 'image') return buildImage(slot, assets);
  if (slot.assetType === 'url' && typeof assets.click_url === 'string') {
    return { asset_type: 'url', url: assets.click_url };
  }
  if (slot.assetType === 'text') return buildText(slot, assets);
  return undefined;
}

function buildAssets(value: unknown, context: StoryboardContext, testKit: unknown): JsonObject | undefined {
  const format = resolveFormat(value, context);
  if (!format) return undefined;
  const slots = requiredSlots(format);
  if (slots.length === 0) return undefined;

  const built: JsonObject = {};
  for (const slot of slots) {
    const asset = buildAsset(slot, testKit);
    if (!asset) return undefined;
    built[slot.id] = asset;
  }
  return built;
}

/** Expand reserved storyboard creative-asset directives without mutating the fixture. */
export function expandCreativeAssetDirectives(value: unknown, context: StoryboardContext, testKit: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => expandCreativeAssetDirectives(item, context, testKit));
  }
  if (!isObject(value)) return value;

  if (Object.prototype.hasOwnProperty.call(value, BUILD_ASSETS_FROM_FORMAT_DIRECTIVE)) {
    const built = buildAssets(value[BUILD_ASSETS_FROM_FORMAT_DIRECTIVE], context, testKit);
    if (!built) return value;
    const siblings = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== BUILD_ASSETS_FROM_FORMAT_DIRECTIVE)
        .map(([key, item]) => [key, expandCreativeAssetDirectives(item, context, testKit)])
    );
    return { ...siblings, ...built };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandCreativeAssetDirectives(item, context, testKit)])
  );
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
