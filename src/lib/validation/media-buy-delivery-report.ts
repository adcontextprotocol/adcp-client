import type { z } from 'zod';
import { GetMediaBuyDeliveryResponseSchema } from '../types/schemas.generated';
import type { MediaBuyDeliveryReport } from '../types/media-buy-delivery-report';

/**
 * Payload-only reporting shape at the SDK pin. Poll responses still require
 * their task status; webhook receivers validate the separate outer envelope.
 * Use parseMediaBuyDeliveryWebhook for strict validation at an older release.
 */
export const MediaBuyDeliveryReportSchema: z.ZodType<MediaBuyDeliveryReport> =
  /* @__PURE__ */ GetMediaBuyDeliveryResponseSchema.omit({
    status: true,
  });
