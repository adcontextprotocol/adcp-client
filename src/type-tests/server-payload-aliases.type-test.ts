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

declare const serverPreviewCreativePayload: ServerPreviewCreativePayload;
const typesPreviewCreativePayload: TypesPreviewCreativePayload = serverPreviewCreativePayload;
void typesPreviewCreativePayload;

// @ts-expect-error payload aliases must not expose SDK-owned protocol envelope fields.
void rootCreateMediaBuyPayload.task_id;

// @ts-expect-error payload aliases must preserve required domain fields.
const missingRequiredDomainField: RootCreateMediaBuyPayload = { packages: [] };
void missingRequiredDomainField;
