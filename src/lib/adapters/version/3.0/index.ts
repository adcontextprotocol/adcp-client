import { createMediaBuyAdapter, updateMediaBuyAdapter, downgradeCreativeTrackers } from './brand-fields';
import { getProductsAdapter } from './get-products';
import { getSignalsAdapter } from './get-signals';
import { syncAccountsAdapter } from './sync-accounts';
import type { VersionAdapter } from '../types';

export const v30Adapters: ReadonlyArray<VersionAdapter> = [
  createMediaBuyAdapter,
  updateMediaBuyAdapter,
  {
    toolName: 'sync_creatives',
    adaptRequest: downgradeCreativeTrackers,
    adaptUnnegotiatedRequest: params => ({ params }),
  },
  getProductsAdapter,
  getSignalsAdapter,
  syncAccountsAdapter,
];
