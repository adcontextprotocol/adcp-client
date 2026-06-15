import { omit31BrandFields } from '../../../utils/adcp-version-config';
import type { VersionAdapter, VersionDrift } from '../types';

const BRAND_DRIFT: VersionDrift = {
  type: 'pre31_brand_fields_stripped',
  message:
    'brand_kit_override stripped from accounts[].brand: field requires AdCP 3.1 but the target seller does not advertise 3.1 support. ' +
    'These fields will not reach the seller; brand identity (domain, brand_id) is preserved.',
  strippedFields: ['brand_kit_override'],
};

export const syncAccountsAdapter: VersionAdapter = {
  toolName: 'sync_accounts',
  adaptRequest(params) {
    if (!params || typeof params !== 'object') return { params };
    const req = params as Record<string, unknown>;
    if (!Array.isArray(req.accounts)) return { params };
    let stripped = false;
    const accounts = (req.accounts as Array<Record<string, unknown>>).map(a => {
      if (!a || typeof a !== 'object' || !a.brand) return a;
      const strippedBrand = omit31BrandFields(a.brand);
      if (strippedBrand === a.brand) return a;
      stripped = true;
      return { ...a, brand: strippedBrand };
    });
    if (!stripped) return { params };
    return { params: { ...req, accounts }, drift: BRAND_DRIFT };
  },
};
