import type {
  CreateMediaBuyPayload as RootCreateMediaBuyPayload,
  GetProductsPayload as RootGetProductsPayload,
  ServerPayload,
} from '../lib';
import type {
  CreateMediaBuyPayload as ServerCreateMediaBuyPayload,
  GetProductsPayload as ServerGetProductsPayload,
  LegacyCreateMediaBuyPayload as ServerLegacyCreateMediaBuyPayload,
  LegacyPreviewCreativePayload as ServerLegacyPreviewCreativePayload,
} from '../lib/server';
import type {
  CreateMediaBuyPayload as TypesCreateMediaBuyPayload,
  GetProductsPayload as TypesGetProductsPayload,
  PreviewCreativePayload as TypesPreviewCreativePayload,
} from '../lib/types';
import type { CreateMediaBuyError, CreateMediaBuySuccess } from '../lib/types';
import type { AdcpToolMap } from '../lib/server/create-adcp-server';
import type { TaskHandoff } from '../lib/server/decisioning/async-outcome';
import type {
  CreateMediaBuyHandlerResult,
  GetProductsPayload as DecisioningGetProductsPayload,
} from '../lib/server/decisioning/specialisms/sales';
import { legacyProductsResponse } from '../lib/server';

const rootCreateMediaBuyPayload = {
  media_buy_id: 'mb_1',
  confirmed_at: '2026-01-01T00:00:00Z',
  revision: 1,
  packages: [],
  status: 'active',
} satisfies RootCreateMediaBuyPayload;
const serverCreateMediaBuyPayload: ServerCreateMediaBuyPayload = rootCreateMediaBuyPayload;
const typesCreateMediaBuyPayload: TypesCreateMediaBuyPayload = serverCreateMediaBuyPayload;
const genericPayload: ServerPayload<CreateMediaBuySuccess> = typesCreateMediaBuyPayload;
void genericPayload;

const rootCreateMediaBuyErrorPayload: RootCreateMediaBuyPayload = {
  errors: [
    { code: 'INVALID_REQUEST', message: 'packages array is required' },
    { code: 'VALIDATION_ERROR', message: 'package budget is invalid', field: 'packages[0].budget' },
  ],
};
const serverCreateMediaBuyErrorPayload: ServerCreateMediaBuyPayload = rootCreateMediaBuyErrorPayload;
const typesCreateMediaBuyErrorPayload: TypesCreateMediaBuyPayload = serverCreateMediaBuyErrorPayload;
const genericErrorPayload: ServerPayload<CreateMediaBuyError> = typesCreateMediaBuyErrorPayload;
const handlerErrorPayload: CreateMediaBuyHandlerResult = rootCreateMediaBuyErrorPayload;
const toolMapErrorPayload: AdcpToolMap['create_media_buy']['result'] = typesCreateMediaBuyErrorPayload;
const legacyCreateMediaBuyErrorPayload: ServerLegacyCreateMediaBuyPayload = typesCreateMediaBuyErrorPayload;
void genericErrorPayload;
void handlerErrorPayload;
void toolMapErrorPayload;
void legacyCreateMediaBuyErrorPayload;

// @ts-expect-error Error arms must not carry success-only media-buy fields.
const hybridCreateMediaBuyPayload: TypesCreateMediaBuyPayload = {
  media_buy_id: 'mb_invalid',
  confirmed_at: null,
  revision: 1,
  packages: [],
  errors: [{ code: 'INVALID_REQUEST', message: 'hybrid payload' }],
};
void hybridCreateMediaBuyPayload;

declare const createMediaBuyErrorHandoff: TaskHandoff<ServerPayload<CreateMediaBuyError>>;
// @ts-expect-error Handoff callbacks must return success; throw AdcpError to fail an async task.
const handlerErrorHandoff: CreateMediaBuyHandlerResult = createMediaBuyErrorHandoff;
void handlerErrorHandoff;

declare const createMediaBuyPayload: TypesCreateMediaBuyPayload;
// @ts-expect-error Error-arm payloads are not assignable to the success-only subtype.
const successOnlyPayload: ServerPayload<CreateMediaBuySuccess> = createMediaBuyPayload;
void successOnlyPayload;
// @ts-expect-error Primary server payload packages never expose legacy format_ids.
void rootCreateMediaBuyPayload.packages[0]?.format_ids;
declare const legacyCreateMediaBuyPayload: Extract<ServerLegacyCreateMediaBuyPayload, { packages: unknown }>;
void legacyCreateMediaBuyPayload.packages[0]?.format_ids;

const rootGetProductsPayload: RootGetProductsPayload = {
  products: [],
  cache_scope: 'account',
};
const serverGetProductsPayload: ServerGetProductsPayload = rootGetProductsPayload;
// @ts-expect-error The explicit protocol-types subpath retains the raw wire product union.
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
// @ts-expect-error DecisioningPlatform is canonical-only; the raw wire alias may contain legacy-only products.
const decisioningPayloadFromPublicAlias: DecisioningGetProductsPayload = publicTypesGetProductsPayload;
// @ts-expect-error Generated Product's empty oneOf marker interfaces prevent structural recovery of the canonical arm.
const publicAliasFromDecisioningPayload: TypesGetProductsPayload = decisioningGetProductsPayload;
void decisioningPayloadFromPublicAlias;
void publicAliasFromDecisioningPayload;

// @ts-expect-error get_products payloads with products must declare cache_scope.
const missingCacheScopeWithProducts: RootGetProductsPayload = { products: [] };
void missingCacheScopeWithProducts;

// @ts-expect-error get_products unchanged wholesale-feed payloads must echo cache_scope.
const missingCacheScopeWithUnchanged: RootGetProductsPayload = { unchanged: true, wholesale_feed_version: 'wf_v1' };
void missingCacheScopeWithUnchanged;

// @ts-expect-error The legacy response builder also enforces cache_scope at the manual builder callsite.
legacyProductsResponse({ products: [] });

declare const serverPreviewCreativePayload: ServerLegacyPreviewCreativePayload;
const typesPreviewCreativePayload: TypesPreviewCreativePayload = serverPreviewCreativePayload;
void typesPreviewCreativePayload;

// @ts-expect-error payload aliases must not expose SDK-owned protocol envelope fields.
void rootCreateMediaBuyPayload.task_id;

// @ts-expect-error payload aliases must preserve required domain fields.
const missingRequiredDomainField: RootCreateMediaBuyPayload = { packages: [] };
void missingRequiredDomainField;
