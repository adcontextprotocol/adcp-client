// Type-level gate for generated schemas that come from TypeScript object intersections.
// These should remain ZodObject instances so downstream consumers can keep using
// common helpers such as .shape, .extend(), .omit(), and .pick().

import { z } from 'zod';
import { customToolFor, TOOL_INPUT_SHAPES } from '../lib/schemas';
import type { AccountReference } from '../lib/types';
import {
  CanonicalFormatImageSchema,
  CreativeVariantSchema,
  GroupVideoAssetSchema,
  IndividualImageAssetSchema,
  ProductSchema,
  TasksGetRequestSchema,
  TasksGetResponseSchema,
  ValidatePropertyDeliveryRequestSchema,
  ValidatePropertyDeliveryResponseSchema,
} from '../lib/types/schemas.generated';
import { TOOL_REQUEST_SCHEMAS } from '../lib/utils/tool-request-schemas';

const validatePropertyDeliveryShape = ValidatePropertyDeliveryRequestSchema.shape;
void validatePropertyDeliveryShape.list_id;

const productShape = ProductSchema.shape;
void productShape.product_id;

const productPick = ProductSchema.pick({ product_id: true, name: true });
void productPick;

const productOmit = ProductSchema.omit({ forecast: true });
void productOmit;

const productExtend = ProductSchema.extend({
  audit_id: z.string().optional(),
});
void productExtend;

const canonicalFormatImageShape = CanonicalFormatImageSchema.shape;
void canonicalFormatImageShape.image_formats;

const getProductsShape = TOOL_REQUEST_SCHEMAS.get_products.shape;
void getProductsShape.brief;

const createMediaBuyShape = TOOL_REQUEST_SCHEMAS.create_media_buy.shape;
void createMediaBuyShape.account;
// @ts-expect-error known tool request schemas should reject bogus fields
void createMediaBuyShape.not_a_real_field;

void TOOL_REQUEST_SCHEMAS.preview_creative.shape.request_type;
const previewRequestType: 'single' | 'batch' | 'variant' =
  TOOL_REQUEST_SCHEMAS.preview_creative.shape.request_type.parse('single');
void previewRequestType;
// @ts-expect-error TS7056 object annotations should keep known request fields exact
void TOOL_REQUEST_SCHEMAS.preview_creative.shape.not_a_real_field;

void TOOL_INPUT_SHAPES.update_media_buy.media_buy_id;
// @ts-expect-error update_media_buy input shape should reject bogus fields
void TOOL_INPUT_SHAPES.update_media_buy.not_a_real_field;

const creativeApprovalShape = TOOL_INPUT_SHAPES.creative_approval;
void creativeApprovalShape.rights_id;

function assertOptionalAccountReference(account: AccountReference | undefined): void {
  if (account && 'account_id' in account) {
    const accountId: string = account.account_id;
    void accountId;
  }
}

customToolFor('creative_approval', 'Submit creative for approval', creativeApprovalShape, async args => {
  const rightsId: string = args.rights_id;
  void rightsId;
  // @ts-expect-error unknown creative approval fields should not type-check
  void args.not_a_real_field;
});

customToolFor('create_media_buy', 'Create a media buy', TOOL_INPUT_SHAPES.create_media_buy, async args => {
  assertOptionalAccountReference(args.account);
});

customToolFor('update_media_buy', 'Update a media buy', TOOL_INPUT_SHAPES.update_media_buy, async args => {
  const mediaBuyId: string = args.media_buy_id;
  void mediaBuyId;
  assertOptionalAccountReference(args.account);
  // @ts-expect-error customToolFor handler args should reject bogus update fields
  void args.not_a_real_field;
});

customToolFor('preview_creative', 'Preview a creative', TOOL_INPUT_SHAPES.preview_creative, async args => {
  const requestType: 'single' | 'batch' | 'variant' = args.request_type;
  void requestType;
});

declare const runtimeToolName: string;
const runtimeToolShape = TOOL_INPUT_SHAPES[runtimeToolName];
void runtimeToolShape;

const runtimeRequestSchema = TOOL_REQUEST_SCHEMAS[runtimeToolName];
void runtimeRequestSchema?.shape;

// @ts-expect-error unknown tool names are not valid customToolFor shapes without narrowing
customToolFor('creative_approval', 'x', TOOL_INPUT_SHAPES.typo_tool, async args => args);

// @ts-expect-error unknown fields should not type-check
void TOOL_INPUT_SHAPES.creative_approval.not_a_real_field;

const validatePropertyDeliveryPick = ValidatePropertyDeliveryRequestSchema.pick({ list_id: true, records: true });
void validatePropertyDeliveryPick;

const validatePropertyDeliveryOmit = ValidatePropertyDeliveryRequestSchema.omit({ ext: true });
void validatePropertyDeliveryOmit;

const validatePropertyDeliveryExtend = ValidatePropertyDeliveryRequestSchema.extend({
  audit_id: z.string().optional(),
});
void validatePropertyDeliveryExtend;

const tasksGetPick = TasksGetRequestSchema.pick({ task_id: true });
void tasksGetPick;

const tasksGetResponseOmit = TasksGetResponseSchema.omit({ history: true });
void tasksGetResponseOmit;

const deliveryResponseExtend = ValidatePropertyDeliveryResponseSchema.extend({
  audit_id: z.string().optional(),
});
void deliveryResponseExtend;

const imageAssetPick = IndividualImageAssetSchema.pick({ asset_type: true, asset_id: true });
void imageAssetPick;

const groupVideoOmit = GroupVideoAssetSchema.omit({ requirements: true });
void groupVideoOmit;

const creativeVariantShape = CreativeVariantSchema.shape;
void creativeVariantShape.variant_id;
