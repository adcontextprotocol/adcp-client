import type { VersionAdapter } from '../types';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * AdCP 3.2 reports currency per media buy and deprecates the root `currency`,
 * which is unsafe across currencies. A 3.1 response has exactly one currency
 * (the required root field), so each buy's currency is that value.
 */
export const getMediaBuyDeliveryAdapter: VersionAdapter = {
  toolName: 'get_media_buy_delivery',
  adaptResponse(data) {
    if (!isObject(data) || typeof data.currency !== 'string' || !Array.isArray(data.media_buy_deliveries)) {
      return { data };
    }
    const currency = data.currency;
    const moved: Array<{ from: string; to: string }> = [];
    const deliveries = data.media_buy_deliveries.map((delivery, index) => {
      if (!isObject(delivery) || delivery.currency !== undefined) return delivery;
      moved.push({ from: 'currency', to: `media_buy_deliveries[${index}].currency` });
      return { ...delivery, currency };
    });
    if (moved.length === 0) return { data };
    return {
      data: { ...data, media_buy_deliveries: deliveries },
      drift: {
        type: 'delivery_currency_per_media_buy',
        message: 'Root currency copied onto each media_buy_deliveries[] entry for the AdCP 3.2 response shape.',
        movedFields: moved,
      },
    };
  },
};
