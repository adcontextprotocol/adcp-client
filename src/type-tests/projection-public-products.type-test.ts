import type { LegacyProduct, Product } from '../lib';
import { projectV1ProductToV2, projectV2ProductToV1, toCanonicalOnlyResponse } from '../lib/v2/projection';

declare const canonical: Product;
declare const legacy: LegacyProduct;

projectV2ProductToV1(canonical);
projectV1ProductToV2(legacy);
toCanonicalOnlyResponse({ products: [legacy] });
