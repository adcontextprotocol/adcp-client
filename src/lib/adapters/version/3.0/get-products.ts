import { omit31BrandFields } from '../../../utils/adcp-version-config';
import type { VersionAdapter, VersionDrift } from '../types';

const BRAND_DRIFT: VersionDrift = {
  type: 'pre31_brand_fields_stripped',
  message:
    'brand_kit_override stripped: field requires AdCP 3.1 but the target seller does not advertise 3.1 support. ' +
    'These fields will not reach the seller; brand identity (domain, brand_id) is preserved.',
  strippedFields: ['brand_kit_override'],
};

const PRICING_FILTERS_DRIFT: VersionDrift = {
  type: 'pre31_pricing_currencies_stripped',
  message:
    'filters.pricing_currencies stripped: field requires AdCP 3.1 but the target seller does not advertise 3.1 support. ' +
    'The seller will return products in all available currencies.',
  strippedFields: ['filters.pricing_currencies'],
};

export const getProductsAdapter: VersionAdapter = {
  toolName: 'get_products',
  adaptRequest(params) {
    if (!params || typeof params !== 'object') return { params };
    const req = params as Record<string, unknown>;
    let adapted: Record<string, unknown> = req;
    const drifts: VersionDrift[] = [];

    // Strip 3.1-only brand fields.
    if (adapted.brand) {
      const stripped = omit31BrandFields(adapted.brand);
      if (stripped !== adapted.brand) {
        adapted = { ...adapted, brand: stripped };
        drifts.push(BRAND_DRIFT);
      }
    }

    // Strip filters.pricing_currencies — 3.1-only filter. 3.0 sellers return
    // UNSUPPORTED_FEATURE and 0 products when they receive this field.
    if (adapted.filters && typeof adapted.filters === 'object') {
      const filters = adapted.filters as Record<string, unknown>;
      if ('pricing_currencies' in filters) {
        const { pricing_currencies: _, ...restFilters } = filters;
        adapted = { ...adapted, filters: restFilters };
        drifts.push(PRICING_FILTERS_DRIFT);
      }
    }

    if (adapted === req) return { params };
    return { params: adapted, drift: drifts[0] };
  },
};
