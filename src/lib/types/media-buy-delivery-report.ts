import type { GetMediaBuyDeliveryResponse } from './tools.generated';

/**
 * Delivery body at the SDK protocol pin, shared by polls and pushes without task status.
 * Version-aware parsing validates the original wire body at the supplied release.
 */
export type MediaBuyDeliveryReport = Omit<GetMediaBuyDeliveryResponse, 'status'>;
