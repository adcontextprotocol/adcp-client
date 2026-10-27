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
  adaptRequest: stripTopLevelBrand,
  downgradeResponse: downgradeMediaBuyStatus,
};

export const getProductsAdapter: VersionAdapter = {
  toolName: 'get_products',
  adaptRequest: stripTopLevelBrand,
};

export const updateMediaBuyAdapter: VersionAdapter = {
  toolName: 'update_media_buy',
  downgradeResponse: downgradeMediaBuyStatus,
};
