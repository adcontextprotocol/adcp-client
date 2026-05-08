// Typed factory helpers for `get_media_buy_delivery` webhook notifications.
// `notification_type` discriminator carries five values, each with distinct
// re-send / supersession semantics:
//   `scheduled` / `final` / `delayed` / `adjusted` / `window_update`.

import type { GetMediaBuyDeliveryResponse } from '../types/core.generated';

type NotificationFields = Omit<GetMediaBuyDeliveryResponse, 'notification_type'>;
type Tagged<Tag extends string> = NotificationFields & { notification_type: Tag };

/** Regular periodic delivery update. Set `sequence_number` and `next_expected_at`. */
export function scheduledMediaBuyDeliveryNotification(fields: NotificationFields): Tagged<'scheduled'> {
  return { ...fields, notification_type: 'scheduled' };
}

/** Campaign completed; no further notifications. Omit `next_expected_at`. */
export function finalMediaBuyDeliveryNotification(fields: NotificationFields): Tagged<'final'> {
  return { ...fields, notification_type: 'final' };
}

/** Data not yet available. Set `partial_data: true` and `unavailable_count`. */
export function delayedMediaBuyDeliveryNotification(fields: NotificationFields): Tagged<'delayed'> {
  return { ...fields, notification_type: 'delayed' };
}

/** Re-send with corrected data, SAME measurement window. Distinct from `window_update`. */
export function adjustedMediaBuyDeliveryNotification(fields: NotificationFields): Tagged<'adjusted'> {
  return { ...fields, notification_type: 'adjusted' };
}

/** Re-send with WIDER measurement window (e.g. C7 superseding C3). */
export function windowUpdateMediaBuyDeliveryNotification(fields: NotificationFields): Tagged<'window_update'> {
  return { ...fields, notification_type: 'window_update' };
}

/** Grouped accessor for all five `MediaBuyDeliveryNotification` variants. */
export const mediaBuyDeliveryNotification = {
  scheduled: scheduledMediaBuyDeliveryNotification,
  final: finalMediaBuyDeliveryNotification,
  delayed: delayedMediaBuyDeliveryNotification,
  adjusted: adjustedMediaBuyDeliveryNotification,
  windowUpdate: windowUpdateMediaBuyDeliveryNotification,
} as const;
