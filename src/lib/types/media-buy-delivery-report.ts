import type { z } from 'zod';
import type { GetMediaBuyDeliveryResponseSchema } from './schemas.generated';

/** Shared delivery body using the stable poll schema's existing tolerant output shape. */
export type MediaBuyDeliveryReport = Omit<z.output<typeof GetMediaBuyDeliveryResponseSchema>, 'status'>;
