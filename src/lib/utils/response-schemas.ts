/**
 * Canonical map of AdCP tool names to their Zod response schemas.
 *
 * Shared by response-unwrapper (runtime parsing) and testing/client
 * (compliance validation) so the two never diverge.
 */

import { z } from 'zod';
import * as schemas from '../types/schemas.generated';

export const TOOL_RESPONSE_SCHEMAS: Partial<Record<string, z.ZodType>> = {
  get_products: schemas.GetProductsResponseSchema,
  list_creative_formats: schemas.ListCreativeFormatsResponseSchema,
  create_media_buy: schemas.CreateMediaBuyResponseSchema,
  update_media_buy: schemas.UpdateMediaBuyResponseSchema,
  sync_creatives: schemas.SyncCreativesResponseSchema,
  list_creatives: schemas.ListCreativesResponseSchema,
  get_media_buys: schemas.GetMediaBuysResponseSchema,
  get_media_buy_delivery: schemas.GetMediaBuyDeliveryResponseSchema,
  provide_performance_feedback: schemas.ProvidePerformanceFeedbackResponseSchema,
  build_creative: schemas.BuildCreativeResponseSchema,
  preview_creative: schemas.PreviewCreativeResponseSchema,
  get_signals: schemas.GetSignalsResponseSchema,
  activate_signal: schemas.ActivateSignalResponseSchema,
};
