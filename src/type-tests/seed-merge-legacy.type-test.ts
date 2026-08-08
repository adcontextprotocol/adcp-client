// Compile-time coverage for the explicit v13 legacy-product seed merge path.

import type { LegacyProduct } from '../lib/index';
import { mergeSeedProductLegacy } from '../lib/testing/index';

declare const legacyProduct: Partial<LegacyProduct>;

const mergedLegacyProduct: Partial<LegacyProduct> = mergeSeedProductLegacy(legacyProduct, {
  product_id: 'seeded-product',
});

void mergedLegacyProduct;
