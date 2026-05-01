import { adaptGetProductsRequestForV2, normalizeGetProductsResponse } from '../../utils/pricing-adapter';
import type { GetProductsRequest, GetProductsResponse } from '../../types/v2-5';
import type { AdapterPair } from './types';

/**
 * v3 ↔ v2.5 adapter pair for `get_products`. Wraps the existing scattered
 * adapter helpers so the registry pattern lands without behavior change;
 * a focused refactor of the underlying implementation can follow.
 */
export const getProductsAdapter: AdapterPair<unknown, GetProductsRequest, GetProductsResponse, unknown> = {
  toolName: 'get_products',
  adaptRequest: adaptGetProductsRequestForV2,
  normalizeResponse: normalizeGetProductsResponse,
};
