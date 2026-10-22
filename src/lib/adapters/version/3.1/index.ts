import { createMediaBuyAdapter, updateMediaBuyAdapter } from './bidding';
import { getMediaBuyDeliveryAdapter } from './delivery';
import type { VersionAdapter } from '../types';

/** Adapters between AdCP 3.2 (next minor) and AdCP 3.1 (this key). */
export const v31Adapters: ReadonlyArray<VersionAdapter> = [
  createMediaBuyAdapter,
  updateMediaBuyAdapter,
  getMediaBuyDeliveryAdapter,
];
