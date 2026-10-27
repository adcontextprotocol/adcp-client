import { CreativeFormatProjectionError } from '../../../v2/projection/creative-delivery';
import { downgradePixelTracker, pixelTrackerDrift } from '../../../v2/projection/legacy-metadata';
import { omit31BrandFields } from '../../../utils/adcp-version-config';
import type { VersionAdapter, VersionDrift } from '../types';

const BRAND_DRIFT: VersionDrift = {
  type: 'pre31_brand_fields_stripped',
  message:
    'brand_kit_override stripped: field requires AdCP 3.1 but the target seller does not advertise 3.1 support. ' +
    'These fields will not reach the seller; brand identity (domain, brand_id) is preserved.',
  strippedFields: ['brand_kit_override'],
};

function stripTopLevelBrand(params: unknown): { params: unknown; drift?: VersionDrift } {
  if (!params || typeof params !== 'object') return { params };
  const req = params as Record<string, unknown>;
  if (!req.brand) return { params };
  const stripped = omit31BrandFields(req.brand);
  if (stripped === req.brand) return { params };
  return { params: { ...req, brand: stripped }, drift: BRAND_DRIFT };
}

// AdCP 3.0 uses `status` for the buy lifecycle; 3.1+ separates it from
// task completion. Move it before projection drops the canonical field.
function downgradeMediaBuyStatus(data: unknown): { data: unknown; drift?: VersionDrift } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { data };
  const response = data as Record<string, unknown>;
  if (typeof response.media_buy_status !== 'string') {
    // A 3.1 task completion without a lifecycle must not become a completed
    // media buy in 3.0. An explicit lifecycle is handled by the branch below.
    if (response.status !== 'completed') return { data };
    const { status: _taskStatus, ...rest } = response;
    return {
      data: rest,
      drift: {
        type: 'pre31_task_status_stripped',
        message: 'Task completion omitted: AdCP 3.0 status describes the media-buy lifecycle.',
        strippedFields: ['status'],
      },
    };
  }
  if (response.status !== undefined && response.status !== 'completed') return { data };
  const { media_buy_status, ...rest } = response;
  return {
    data: { ...rest, status: media_buy_status },
    drift: {
      type: 'pre31_media_buy_status_moved',
      message: 'Media-buy lifecycle moved from media_buy_status to the AdCP 3.0 status field.',
      movedFields: [{ from: 'media_buy_status', to: 'status' }],
    },
  };
}

export const createMediaBuyAdapter: VersionAdapter = {
  toolName: 'create_media_buy',
  adaptUnnegotiatedRequest: stripTopLevelBrand,
  adaptRequest(params) {
    const brand = stripTopLevelBrand(params);
    const trackers = downgradeCreativeTrackers(brand.params);
    if (!brand.drift) return trackers;
    if (!trackers.drift) return { params: trackers.params, drift: brand.drift };
    return {
      params: trackers.params,
      drift: {
        type: brand.drift.type,
        message: `${brand.drift.message} ${trackers.drift.message}`,
        strippedFields: [...(brand.drift.strippedFields ?? []), ...(trackers.drift.strippedFields ?? [])],
        constituentTypes: [brand.drift.type, trackers.drift.type],
      },
    };
  },
  downgradeResponse: downgradeMediaBuyStatus,
};

export const getProductsAdapter: VersionAdapter = {
  toolName: 'get_products',
  adaptRequest: stripTopLevelBrand,
};

export const updateMediaBuyAdapter: VersionAdapter = {
  toolName: 'update_media_buy',
  adaptRequest: downgradeCreativeTrackers,
  adaptUnnegotiatedRequest: params => ({ params }),
  downgradeResponse: downgradeMediaBuyStatus,
};

type Json = Record<string, unknown>;
function record(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

/** Convert only creative asset positions, never opaque ext/provenance objects. */
export function downgradeCreativeTrackers(params: unknown): { params: unknown; drift?: VersionDrift } {
  const request = record(params);
  if (!request) return { params };
  const losses: VersionDrift[] = [];
  const convertCreatives = (items: unknown, path: string): unknown => {
    if (!Array.isArray(items)) return items;
    let changed = false;
    const converted = items.map((item, index) => {
      const creative = record(item);
      const assets = record(creative?.assets);
      if (!creative || !assets) return item;
      const replacements = new Map<string, { source: string; asset: unknown }>();
      for (const [key, value] of Object.entries(assets)) {
        const pixels = Array.isArray(value) ? value : [value];
        if (pixels.length === 0) continue;
        const trackers = pixels.map(downgradePixelTracker);
        if (trackers.some(tracker => tracker === undefined)) continue;
        const groups = new Map<string, unknown[]>();
        for (const tracker of trackers) {
          const group = groups.get(tracker!.assetId) ?? [];
          group.push(tracker!.asset);
          groups.set(tracker!.assetId, group);
        }
        for (const [target, group] of groups) {
          if ((Object.hasOwn(assets, target) && target !== key) || replacements.has(target)) {
            throw new CreativeFormatProjectionError(
              'creative_delivery',
              typeof creative.creative_id === 'string' ? creative.creative_id : '(unknown)',
              `multiple assets would occupy the legacy tracker slot ${target}`
            );
          }
          replacements.set(target, { source: key, asset: Array.isArray(value) ? group : group[0] });
        }
        trackers.forEach((tracker, trackerIndex) => {
          const field = `${path}[${index}].assets.${key}${Array.isArray(value) ? `[${trackerIndex}]` : ''}`;
          const drift = pixelTrackerDrift(field, tracker!);
          if (drift) losses.push(drift);
        });
      }
      if (replacements.size === 0) return item;
      changed = true;
      const sources = new Set([...replacements.values()].map(entry => entry.source));
      return {
        ...creative,
        assets: {
          ...Object.fromEntries(Object.entries(assets).filter(([key]) => !sources.has(key))),
          ...Object.fromEntries([...replacements].map(([target, entry]) => [target, entry.asset])),
        },
      };
    });
    return changed ? converted : items;
  };
  let adapted = request;
  const creatives = convertCreatives(request.creatives, 'creatives');
  if (creatives !== request.creatives) adapted = { ...adapted, creatives };
  for (const field of ['packages', 'new_packages']) {
    const packages = request[field];
    if (!Array.isArray(packages)) continue;
    let changed = false;
    const converted = packages.map((pkg, index) => {
      const item = record(pkg);
      if (!item) return pkg;
      const creatives = convertCreatives(item.creatives, `${field}[${index}].creatives`);
      if (creatives === item.creatives) return pkg;
      changed = true;
      return { ...item, creatives };
    });
    if (changed) adapted = { ...adapted, [field]: converted };
  }
  if (losses.length === 0) return { params: adapted };
  return {
    params: adapted,
    drift: {
      type: 'PIXEL_TRACKER_LOSSY_DOWNGRADE',
      message: losses.map(loss => loss.message).join(' '),
      strippedFields: losses.flatMap(loss => loss.strippedFields ?? []),
    },
  };
}
