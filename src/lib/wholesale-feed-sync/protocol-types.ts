import type {
  GetProductsResponse,
  GetSignalsResponse,
  WholesaleFeedEvent as CurrentWholesaleFeedEvent,
  WholesaleFeedWebhook as CurrentWholesaleFeedWebhook,
} from '../types';

export type LegacyWholesaleProduct = NonNullable<GetProductsResponse['products']>[number];
export type LegacyWholesaleSignal = NonNullable<GetSignalsResponse['signals']>[number];

type EventOf<K extends CurrentWholesaleFeedEvent['event_type']> = Extract<CurrentWholesaleFeedEvent, { event_type: K }>;
type WithPayload<TEvent, TPayload> = Omit<TEvent, 'payload'> & { payload: TPayload };
type LegacyProductPayload<K extends 'product.created' | 'product.updated'> = Omit<
  EventOf<K>['payload'],
  'product' | 'canonical_product'
> & {
  product: LegacyWholesaleProduct;
  canonical_product?: never;
};
type LegacyPricingPayload = Omit<
  EventOf<'product.priced'>['payload'],
  'pricing_options' | 'canonical_pricing_options'
> & {
  pricing_options: NonNullable<LegacyWholesaleProduct['pricing_options']>;
  canonical_pricing_options?: never;
};

/**
 * Wholesale-feed event shape supported by this legacy `get_products` mirror.
 *
 * AdCP 3.2 also defines canonical `list_products` payloads. This sync engine
 * intentionally accepts the legacy view only until it implements canonical
 * product storage and repair semantics.
 */
export type LegacyWholesaleFeedEvent =
  | WithPayload<EventOf<'product.created'>, LegacyProductPayload<'product.created'>>
  | WithPayload<EventOf<'product.updated'>, LegacyProductPayload<'product.updated'>>
  | WithPayload<EventOf<'product.priced'>, LegacyPricingPayload>
  | Exclude<CurrentWholesaleFeedEvent, { event_type: 'product.created' | 'product.updated' | 'product.priced' }>;

/**
 * Historical beta envelopes omitted `product_payload_view`; current 3.2
 * legacy-view envelopes set it to `legacy`. Both forms map to the same mirror.
 */
type LegacyWebhookBase = Omit<CurrentWholesaleFeedWebhook, 'event' | 'notification_type' | 'product_payload_view'>;
type LegacyWebhookFor<TEvent extends LegacyWholesaleFeedEvent> = TEvent extends LegacyWholesaleFeedEvent
  ? LegacyWebhookBase & {
      event: TEvent;
      notification_type: TEvent['event_type'];
    } & (TEvent['event_type'] extends `product.${string}`
        ? { product_payload_view?: 'legacy' }
        : { product_payload_view?: never })
  : never;

export type LegacyWholesaleFeedWebhook = LegacyWebhookFor<LegacyWholesaleFeedEvent>;
