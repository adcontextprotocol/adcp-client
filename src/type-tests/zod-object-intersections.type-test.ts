// Type-level gate for generated schemas that come from TypeScript object intersections.
// These should remain ZodObject instances so downstream consumers can keep using
// common helpers such as .shape, .extend(), .omit(), and .pick().

import { z } from 'zod';
import {
  CreativeVariantSchema,
  GroupVideoAssetSchema,
  IndividualImageAssetSchema,
  TasksGetRequestSchema,
  TasksGetResponseSchema,
  ValidatePropertyDeliveryRequestSchema,
  ValidatePropertyDeliveryResponseSchema,
} from '../lib/types/schemas.generated';

const validatePropertyDeliveryShape = ValidatePropertyDeliveryRequestSchema.shape;
void validatePropertyDeliveryShape.list_id;

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
