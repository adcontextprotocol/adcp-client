import { normalizeGetProductsResponse, type PricingOptionV2, type PricingOptionV3 } from '../../utils/pricing-adapter';

/** Legacy product fields normalized before v2-to-canonical projection. */
export type LegacyProductNormalizationInput = object & {
  pricing_options?: readonly (PricingOptionV2 | PricingOptionV3)[];
  channels?: readonly string[];
  forecast?: Record<string, unknown>;
};

/** Product shape after pricing, channel, and forecast compatibility cleanup. */
export type NormalizedLegacyProduct<TProduct extends LegacyProductNormalizationInput> = Omit<
  TProduct,
  'pricing_options' | 'channels' | 'forecast'
> & {
  pricing_options?: PricingOptionV3[];
  channels?: string[];
  forecast?: Record<string, unknown>;
};

/**
 * Apply the SDK's complete v2.5 `get_products` compatibility normalization
 * before projecting a response recovered through a custom `tasks_get` flow.
 */
export function normalizeLegacyGetProductsResponse<
  TProduct extends LegacyProductNormalizationInput,
  TResponse extends object & { products: readonly TProduct[] },
>(response: TResponse): Omit<TResponse, 'products'> & { products: NormalizedLegacyProduct<TProduct>[] };
/** Preserve pass-through/error responses when the recovered shape is not yet narrowed. */
export function normalizeLegacyGetProductsResponse(response: unknown): unknown;
export function normalizeLegacyGetProductsResponse(response: unknown): unknown {
  return normalizeGetProductsResponse(response);
}
