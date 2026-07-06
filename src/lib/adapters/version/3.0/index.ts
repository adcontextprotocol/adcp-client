import { createMediaBuyAdapter } from './brand-fields';
import { getProductsAdapter } from './get-products';
import { syncAccountsAdapter } from './sync-accounts';
import type { VersionAdapter } from '../types';

export const v30Adapters: ReadonlyArray<VersionAdapter> = [
  createMediaBuyAdapter,
  getProductsAdapter,
  syncAccountsAdapter,
];
