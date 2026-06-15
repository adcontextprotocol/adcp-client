import { createMediaBuyAdapter, getProductsAdapter } from './brand-fields';
import { syncAccountsAdapter } from './sync-accounts';
import type { VersionAdapter } from '../types';

export const v30Adapters: ReadonlyArray<VersionAdapter> = [
  createMediaBuyAdapter,
  getProductsAdapter,
  syncAccountsAdapter,
];
