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

export const createMediaBuyAdapter: VersionAdapter = {
  toolName: 'create_media_buy',
  adaptRequest: stripTopLevelBrand,
};

export const getProductsAdapter: VersionAdapter = {
  toolName: 'get_products',
  adaptRequest: stripTopLevelBrand,
};
