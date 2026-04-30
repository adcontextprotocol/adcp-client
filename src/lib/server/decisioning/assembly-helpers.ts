/**
 * Wire-shape assembly helpers.
 *
 * AdCP wire shapes carry many required fields (Product needs 8 required
 * properties; PricingOption needs at least 3 plus model-specific extras).
 * Building them by hand is the largest single source of validation
 * cascades in LLM-generated platforms (Emma matrix v18: a single missed
 * `format_ids[0].id` shape error swallowed 30+ storyboard steps).
 *
 * These helpers emit correct wire shapes from a flatter, intent-shaped
 * input. Adopters opt in — anything you don't pass in gets a sensible
 * default; anything required gets a clear TS error if you omit it.
 *
 * @public
 */

import type { Product, PricingOption, ReportingCapabilities } from '../../types/tools.generated';

// ---------------------------------------------------------------------------
// buildProduct
// ---------------------------------------------------------------------------

export interface BuildProductInput {
  /** Unique product id. */
  id: string;

  /** Human-readable name surfaced to buyers. */
  name: string;

  /** Description surfaced to buyers. Defaults to `name`. */
  description?: string;

  /**
   * Format ids accepted on creatives bound to this product.
   *
   * Pass either:
   *   - Array of strings → SDK wraps each as `{ id, agent_url }` using the
   *     `agentUrl` you pass alongside (required for string-form formats —
   *     wire schema requires `agent_url` per AdCP 3.0.1)
   *   - Array of `{ id, agent_url }` for cross-agent format references
   *     (each entry carries its own agent_url)
   */
  formats: ReadonlyArray<string | { id: string; agent_url?: string }>;

  /**
   * Your agent's URL (e.g., `'http://127.0.0.1:4200/mcp'` in tests, your
   * production MCP endpoint live). Required when any entry in `formats` is
   * a bare string (so the helper can build `{ id, agent_url }`). Ignored
   * when every entry is `{ id, agent_url }`.
   *
   * Per AdCP 3.0.1, `format_ids[i].agent_url` is required on the wire shape
   * — every format reference must point at the agent that defines that
   * format. Pass once per `buildProduct` call and the helper threads it
   * into each format ref.
   */
  agentUrl?: string;

  /** `'guaranteed'` (reserved inventory) or `'non_guaranteed'` (auction / remnant). */
  delivery_type: 'guaranteed' | 'non_guaranteed';

  /**
   * One or more pricing options. Pass strings for "default CPM with floor"
   * convenience, or full `PricingOption` objects for fine-grained control.
   *
   * Convenience shortcut: `pricing: { model: 'cpm', floor: 5, currency: 'USD' }`
   * builds a single CPM auction pricing option with the given floor.
   */
  pricing?:
    | { model: 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'flat_rate' | 'time'; floor?: number; fixed?: number; currency?: string; pricing_option_id?: string }
    | ReadonlyArray<PricingOption>;

  /**
   * Shortcut for the common single-publisher case: pass the domain (e.g.,
   * `'sports.example'`) and the helper builds `publisher_properties: [{
   * publisher_domain: '<domain>', selection_type: 'all' }]`.
   *
   * Use `publisher_properties` directly for multi-domain or by-id / by-tag
   * selection.
   */
  publisher_domain?: string;

  /**
   * Publisher properties this product covers. Required (per AdCP 3.0.1
   * product schema) — pass `publisher_domain` for the common single-domain
   * shortcut, OR pass this directly for fine-grained selection.
   *
   * Each entry is a discriminated union by `selection_type`:
   *   - `'all'` — select all properties at the publisher_domain
   *   - `'by_id'` — select specific property_ids[]
   *   - `'by_tag'` — select by property_tags[]
   */
  publisher_properties?: ReadonlyArray<
    | { publisher_domain: string; selection_type: 'all' }
    | { publisher_domain: string; selection_type: 'by_id'; property_ids: ReadonlyArray<{ property_type: string; identifier: string; [k: string]: unknown }> }
    | { publisher_domain: string; selection_type: 'by_tag'; property_tags: ReadonlyArray<string> }
  >;

  /** Reporting capabilities. Defaults to hourly+daily impressions/spend/clicks. */
  reporting_capabilities?: ReportingCapabilities;

  /** Channels this product targets (`'display'`, `'video'`, etc.). */
  channels?: ReadonlyArray<string>;

  /** Adapter-internal opaque blob round-tripped by the SDK. */
  ctx_metadata?: unknown;

  /** Anything else on the wire shape (escape hatch). */
  extra?: Record<string, unknown>;
}

const DEFAULT_REPORTING_CAPABILITIES: ReportingCapabilities = {
  available_reporting_frequencies: ['hourly', 'daily'],
  expected_delay_minutes: 60,
  timezone: 'UTC',
  supports_webhooks: false,
  available_metrics: ['impressions', 'spend', 'clicks'],
  date_range_support: 'date_range',
} as ReportingCapabilities;

function resolvePublisherProperties(input: BuildProductInput): ReadonlyArray<unknown> {
  if (input.publisher_properties && input.publisher_properties.length > 0) {
    return input.publisher_properties;
  }
  if (input.publisher_domain) {
    return [{ publisher_domain: input.publisher_domain, selection_type: 'all' }];
  }
  throw new Error(
    `buildProduct: ${input.id} requires either \`publisher_domain\` (single-publisher shortcut) ` +
      `or \`publisher_properties\` (multi-domain / by-id / by-tag selection). The wire schema requires ` +
      `at least one publisher_property entry per product.`
  );
}

/**
 * Build a wire-correct `Product` from intent-shaped input. Required fields
 * (per AdCP 3.0.1 product.json) are filled in with sensible defaults when
 * omitted; the caller can override any of them.
 *
 * @example Catalog product (minimal)
 * ```ts
 * const product = buildProduct({
 *   id: 'sports_display_auction',
 *   name: 'Sports Display Auction',
 *   formats: ['display_300x250', 'display_728x90'],
 *   delivery_type: 'non_guaranteed',
 *   pricing: { model: 'cpm', floor: 5.0, currency: 'USD' },
 *   ctx_metadata: { gam: { ad_unit_ids: ['au_123'] } },
 * });
 * ```
 *
 * @example Multi-pricing-option product
 * ```ts
 * const product = buildProduct({
 *   id: 'premium_homepage',
 *   name: 'Premium Homepage Takeover',
 *   formats: [{ id: 'display_970x250' }],
 *   delivery_type: 'guaranteed',
 *   pricing: [
 *     buildPricingOption({ id: 'po_cpm', model: 'cpm', fixed: 25.0, currency: 'USD' }),
 *     buildPricingOption({ id: 'po_flat', model: 'flat_rate', fixed: 50000, currency: 'USD' }),
 *   ],
 * });
 * ```
 */
export function buildProduct(input: BuildProductInput): Product {
  const formats = input.formats.map(f => {
    if (typeof f === 'string') {
      if (!input.agentUrl) {
        throw new Error(
          `buildProduct: ${input.id} declares format '${f}' as a bare string, but \`agentUrl\` is required ` +
            `to build the wire \`{ id, agent_url }\` shape. Pass \`agentUrl\` on the input, OR pass each format ` +
            `as \`{ id, agent_url }\` directly.`
        );
      }
      return { id: f, agent_url: input.agentUrl };
    }
    if (f.agent_url) return f;
    if (input.agentUrl) return { ...f, agent_url: input.agentUrl };
    throw new Error(
      `buildProduct: ${input.id} format '${f.id}' has no agent_url and no \`agentUrl\` was passed on the input.`
    );
  });

  let pricing_options: PricingOption[];
  if (Array.isArray(input.pricing)) {
    pricing_options = [...input.pricing];
  } else if (input.pricing) {
    // Narrow: not an array, so it's the BuildPricingOptionInput shorthand object.
    pricing_options = [buildPricingOption(input.pricing as BuildPricingOptionInput)];
  } else {
    // No pricing supplied — emit a single CPM placeholder so the wire shape
    // validates. Adopters who skip pricing usually don't realize it's required.
    pricing_options = [
      buildPricingOption({ model: 'cpm', floor: 0.01, currency: 'USD' }),
    ];
  }

  const product = {
    product_id: input.id,
    name: input.name,
    description: input.description ?? input.name,
    publisher_properties: resolvePublisherProperties(input),
    format_ids: formats,
    delivery_type: input.delivery_type,
    pricing_options,
    reporting_capabilities: input.reporting_capabilities ?? DEFAULT_REPORTING_CAPABILITIES,
    ...(input.channels && input.channels.length > 0 && { channels: [...input.channels] }),
    ...(input.ctx_metadata !== undefined && { ctx_metadata: input.ctx_metadata }),
    ...(input.extra ?? {}),
  } as unknown as Product;

  return product;
}

// ---------------------------------------------------------------------------
// buildPricingOption
// ---------------------------------------------------------------------------

export interface BuildPricingOptionInput {
  /** Pricing option id, unique within the product. Defaults to `${model}_${floor||fixed||'default'}`. */
  id?: string;

  /** Pricing model. */
  model: 'cpm' | 'vcpm' | 'cpc' | 'cpcv' | 'cpv' | 'cpp' | 'cpa' | 'flat_rate' | 'time';

  /** Fixed price per unit. Mutually exclusive with `floor`. */
  fixed?: number;

  /** Auction floor price. Mutually exclusive with `fixed`. */
  floor?: number;

  /** ISO 4217 currency code (e.g., `'USD'`, `'EUR'`). Defaults to `'USD'`. */
  currency?: string;

  /** Minimum spend requirement per package using this pricing option. */
  min_spend_per_package?: number;
}

/**
 * Build a wire-correct `PricingOption` from intent-shaped input. Use the
 * shortcut on `buildProduct({ pricing })` for the common case; call
 * `buildPricingOption` directly when you need multiple options on a product.
 *
 * @example
 * ```ts
 * const cpm = buildPricingOption({ model: 'cpm', floor: 5.0, currency: 'USD' });
 * const flat = buildPricingOption({ id: 'po_flat', model: 'flat_rate', fixed: 50000, currency: 'USD' });
 * ```
 */
export function buildPricingOption(input: BuildPricingOptionInput): PricingOption {
  if (input.fixed !== undefined && input.floor !== undefined) {
    throw new Error('buildPricingOption: `fixed` and `floor` are mutually exclusive (CPM/etc. is either fixed-price or auction).');
  }
  const currency = input.currency ?? 'USD';
  const idHint = input.fixed != null ? `fixed_${input.fixed}` : input.floor != null ? `floor_${input.floor}` : 'default';
  const opt = {
    pricing_option_id: input.id ?? `${input.model}_${idHint}`,
    pricing_model: input.model,
    currency,
    ...(input.fixed !== undefined && { fixed_price: input.fixed }),
    ...(input.floor !== undefined && { floor_price: input.floor }),
    ...(input.min_spend_per_package !== undefined && { min_spend_per_package: input.min_spend_per_package }),
  } as unknown as PricingOption;
  return opt;
}

// ---------------------------------------------------------------------------
// buildPackage (createMediaBuy / getMediaBuys response packages)
// ---------------------------------------------------------------------------

export interface BuildPackageInput {
  id: string;
  /** Buyer-supplied client-side reference (echoed from the request). */
  buyer_ref?: string;
  /** AdCP package status. Defaults to `'pending_creatives'` (just-created buys). */
  status?: 'draft' | 'pending_creatives' | 'pending_start' | 'active' | 'paused' | 'completed' | 'canceled' | 'rejected';
  /** product_id this package was bound to. */
  product_id?: string;
  /** pricing_option_id selected for this package. */
  pricing_option_id?: string;
  /** Adapter-internal opaque blob round-tripped by the SDK. */
  ctx_metadata?: unknown;
  /** Anything else on the wire shape. */
  extra?: Record<string, unknown>;
}

/**
 * Build a wire-correct package shape for a media buy response.
 *
 * @example
 * ```ts
 * createMediaBuy: async (req, ctx) => {
 *   const order = await this.gam.createOrder(req);
 *   return {
 *     media_buy_id: order.id,
 *     status: 'pending_creatives',
 *     packages: order.lineItems.map(li => buildPackage({
 *       id: li.id,
 *       buyer_ref: li.buyerRef,
 *       status: 'pending_creatives',
 *       ctx_metadata: { gam_line_item_id: li.gamLineItemId },
 *     })),
 *   };
 * }
 * ```
 */
export function buildPackage(input: BuildPackageInput): Record<string, unknown> {
  return {
    package_id: input.id,
    status: input.status ?? 'pending_creatives',
    ...(input.buyer_ref !== undefined && { buyer_ref: input.buyer_ref }),
    ...(input.product_id !== undefined && { product_id: input.product_id }),
    ...(input.pricing_option_id !== undefined && { pricing_option_id: input.pricing_option_id }),
    ...(input.ctx_metadata !== undefined && { ctx_metadata: input.ctx_metadata }),
    ...(input.extra ?? {}),
  };
}
