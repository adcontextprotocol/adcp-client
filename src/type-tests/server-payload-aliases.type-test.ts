import type {
  CreateMediaBuyPayload as RootCreateMediaBuyPayload,
  GetProductsPayload as RootGetProductsPayload,
  ServerPayload,
} from '../lib';
import type {
  CreateMediaBuyPayload as ServerCreateMediaBuyPayload,
  GetProductsPayload as ServerGetProductsPayload,
  PreviewCreativePayload as ServerPreviewCreativePayload,
} from '../lib/server';
import type {
  CreateMediaBuyPayload as TypesCreateMediaBuyPayload,
  GetProductsPayload as TypesGetProductsPayload,
  PreviewCreativePayload as TypesPreviewCreativePayload,
} from '../lib/types';
import type { CreateMediaBuySuccess } from '../lib/types';
import type { GetProductsPayload as DecisioningGetProductsPayload } from '../lib/server/decisioning/specialisms/sales';
import { productsResponse } from '../lib/server';

const rootCreateMediaBuyPayload: RootCreateMediaBuyPayload = {
  media_buy_id: 'mb_1',
  packages: [],
  status: 'active',
};
const serverCreateMediaBuyPayload: ServerCreateMediaBuyPayload = rootCreateMediaBuyPayload;
const typesCreateMediaBuyPayload: TypesCreateMediaBuyPayload = serverCreateMediaBuyPayload;
const genericPayload: ServerPayload<CreateMediaBuySuccess> = typesCreateMediaBuyPayload;
void genericPayload;

const rootGetProductsPayload: RootGetProductsPayload = {
  products: [],
  cache_scope: 'account',
};
const serverGetProductsPayload: ServerGetProductsPayload = rootGetProductsPayload;
const typesGetProductsPayload: TypesGetProductsPayload = serverGetProductsPayload;
void typesGetProductsPayload;

const unchangedGetProductsPayload: RootGetProductsPayload = {
  unchanged: true,
  wholesale_feed_version: 'wf_v1',
  cache_scope: 'public',
};
const unchangedServerGetProductsPayload: ServerGetProductsPayload = unchangedGetProductsPayload;
void unchangedServerGetProductsPayload;

declare const publicTypesGetProductsPayload: TypesGetProductsPayload;
declare const decisioningGetProductsPayload: DecisioningGetProductsPayload;
const decisioningPayloadFromPublicAlias: DecisioningGetProductsPayload = publicTypesGetProductsPayload;
const publicAliasFromDecisioningPayload: TypesGetProductsPayload = decisioningGetProductsPayload;
void decisioningPayloadFromPublicAlias;
void publicAliasFromDecisioningPayload;

// @ts-expect-error get_products payloads with products must declare cache_scope.
const missingCacheScopeWithProducts: RootGetProductsPayload = { products: [] };
void missingCacheScopeWithProducts;

// @ts-expect-error get_products unchanged wholesale-feed payloads must echo cache_scope.
const missingCacheScopeWithUnchanged: RootGetProductsPayload = { unchanged: true, wholesale_feed_version: 'wf_v1' };
void missingCacheScopeWithUnchanged;

// @ts-expect-error productsResponse also enforces cache_scope at the manual builder callsite.
productsResponse({ products: [] });

declare const serverPreviewCreativePayload: ServerPreviewCreativePayload;
const typesPreviewCreativePayload: TypesPreviewCreativePayload = serverPreviewCreativePayload;
void typesPreviewCreativePayload;

// @ts-expect-error payload aliases must not expose SDK-owned protocol envelope fields.
void rootCreateMediaBuyPayload.task_id;

// @ts-expect-error payload aliases must preserve required domain fields.
const missingRequiredDomainField: RootCreateMediaBuyPayload = { packages: [] };
void missingRequiredDomainField;
