export interface MockOffering {
  offering_id: string;
  brand_id: string;
  name: string;
  summary: string;
  tagline?: string;
  hero_image_url: string;
  landing_page_url: string;
  price_hint: string;
  expires_at: string;
  /** Upstream product catalog tied to this offering. The adapter projects
   * these to the `matching_products` array on `SIGetOfferingResponse` when
   * `include_products` is true. Note the upstream key is `sku` and AdCP
   * wants `product_id` — direct rename, intentional, exercises the
   * adapter's projection. */
  products: MockProduct[];
}

export interface MockProduct {
  sku: string;
  name: string;
  display_price: string;
  list_price?: string;
  thumbnail_url: string;
  pdp_url: string;
  inventory_status: string;
}

export interface MockBrand {
  brand_id: string;
  display_name: string;
  /** AdCP-side identifier the adapter receives in `account.brand` (or
   * however the adopter chooses to project brand identity). The adapter
   * resolves this to `brand_id` for outbound URL composition. */
  adcp_brand: string;
  /** Privacy policy version surfaced in `SIInitiateSessionResponse.identity`
   * acknowledgment when the host shares user data with consent. */
  privacy_policy_url: string;
  privacy_policy_version: string;
  visible_offering_ids: string[];
  /** Default session inactivity timeout the brand wants the host to honor.
   * Mirrors AdCP's `session_ttl_seconds` on the initiate response. */
  session_ttl_seconds: number;
}

const NOW = '2026-04-15T12:00:00Z';
const OFFERING_EXPIRES = '2026-06-30T23:59:59Z';

export const OFFERINGS: MockOffering[] = [
  {
    offering_id: 'off_acme_trailrun_summer26',
    brand_id: 'brand_acme_outdoor',
    name: 'Trail Runner Summer Collection',
    summary:
      'Lightweight trail-running shoes with grippy lugs and breathable mesh — built for the long haul. Free returns within 30 days.',
    tagline: 'Built for the trail.',
    hero_image_url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/trailrun-hero.jpg',
    landing_page_url: 'https://acmeoutdoor.example/trailrun',
    price_hint: 'from $129',
    expires_at: OFFERING_EXPIRES,
    products: [
      {
        sku: 'acme_tr_blackgreen_10',
        name: 'Trail Runner — Black/Green, M10',
        display_price: '$129',
        list_price: '$159',
        thumbnail_url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/tr-blackgreen-10.jpg',
        pdp_url: 'https://acmeoutdoor.example/trailrun/blackgreen-10',
        inventory_status: 'In stock',
      },
      {
        sku: 'acme_tr_charcoal_11',
        name: 'Trail Runner — Charcoal, M11',
        display_price: '$129',
        list_price: '$159',
        thumbnail_url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/tr-charcoal-11.jpg',
        pdp_url: 'https://acmeoutdoor.example/trailrun/charcoal-11',
        inventory_status: 'Only 3 left',
      },
    ],
  },
  {
    offering_id: 'off_summit_books_summer26',
    brand_id: 'brand_summit_books',
    name: 'Summer Reading Picks',
    summary:
      'Hand-picked reading list from independent booksellers — fiction, memoir, nature writing. Free shipping on orders over $35.',
    tagline: 'Your next favorite book is here.',
    hero_image_url: 'https://test-assets.adcontextprotocol.org/summit-books/summer-hero.jpg',
    landing_page_url: 'https://summit-books.example/summer',
    price_hint: 'from $18',
    expires_at: OFFERING_EXPIRES,
    products: [
      {
        sku: 'sb_book_river_north',
        name: 'River North — A Novel (paperback)',
        display_price: '$18',
        thumbnail_url: 'https://test-assets.adcontextprotocol.org/summit-books/river-north.jpg',
        pdp_url: 'https://summit-books.example/books/river-north',
        inventory_status: 'In stock',
      },
    ],
  },
];

export const BRANDS: MockBrand[] = [
  {
    brand_id: 'brand_acme_outdoor',
    display_name: 'Acme Outdoor',
    adcp_brand: 'acmeoutdoor.example',
    privacy_policy_url: 'https://acmeoutdoor.example/privacy',
    privacy_policy_version: '2026-01-01',
    visible_offering_ids: ['off_acme_trailrun_summer26'],
    session_ttl_seconds: 600,
  },
  {
    brand_id: 'brand_summit_books',
    display_name: 'Summit Books',
    adcp_brand: 'summit-books.example',
    privacy_policy_url: 'https://summit-books.example/privacy',
    privacy_policy_version: '2025-09-15',
    visible_offering_ids: ['off_summit_books_summer26'],
    session_ttl_seconds: 900,
  },
];

/** Default static API key shared across all brands owned by the customer. */
export const DEFAULT_API_KEY = 'mock_si_brand_key_do_not_use_in_prod';

/** Stable timestamp returned by `created_at` fields on conversation and turn
 * records. Tests pin against this for deterministic assertions. */
export const SEED_NOW = NOW;
