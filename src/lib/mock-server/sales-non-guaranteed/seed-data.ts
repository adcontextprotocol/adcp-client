/**
 * Seed data for the `sales-non-guaranteed` mock-server.
 *
 * Closes #1457 (sub-issue of #1381). Programmatic-auction shape:
 * floor pricing per product (`min_cpm`), sync confirmation on
 * `POST /v1/orders` (no HITL approval), single-bucket delivery
 * scaling with budget × pacing curve. No guaranteed-availability
 * surface — forecast is `spend`-only with saturating returns at
 * high budgets (auction-clearing premium ~1.3x floor at modest
 * budgets, asymptoting at ~2x).
 *
 * Compare to `sales-guaranteed/seed-data.ts`:
 *   - `MockProduct.pricing.cpm` (fixed) → `MockProduct.pricing.min_cpm` (floor) + optional `target_cpm`.
 *   - `MockProduct.availability.available_impressions` → out of scope (programmatic).
 *   - `MockProduct.delivery_type: 'guaranteed'` → always `'non_guaranteed'`.
 */

export interface MockNetwork {
  network_code: string;
  display_name: string;
  /** AdCP-side identifier the adapter receives (typically `account.publisher`). */
  adcp_publisher: string;
}

export interface MockAdUnit {
  ad_unit_id: string;
  name: string;
  path: string;
  network_code: string;
  sizes: Array<{ width: number; height: number }>;
  environment: 'web' | 'mobile_app' | 'ctv' | 'audio';
  targetable: boolean;
}

export interface MockProduct {
  product_id: string;
  name: string;
  network_code: string;
  /** Always `'non_guaranteed'` for this mock — auction-cleared programmatic remnant. */
  delivery_type: 'non_guaranteed';
  channel: 'video' | 'ctv' | 'display' | 'audio';
  format_ids: string[];
  ad_unit_ids: string[];
  pricing: {
    /** Floor (minimum) CPM in `currency`. Sellers accept any bid ≥ floor. */
    min_cpm: number;
    /** Optional historical clearing CPM — typically 1.2-1.5x `min_cpm` at
     * modest spend, saturating toward 2x at high budgets. Used by the
     * forecast endpoint to project effective CPM at the requested budget. */
    target_cpm?: number;
    currency: string;
    /** Optional minimum spend to access this product. Pacing/learning-floor
     * style, not a guarantee threshold. */
    min_spend?: number;
  };
}

export const NETWORKS: MockNetwork[] = [
  {
    network_code: 'net_remnant_us',
    display_name: 'Programmatic Remnant Network — US',
    adcp_publisher: 'remnant-network.example',
  },
  {
    network_code: 'net_remnant_eu',
    display_name: 'Programmatic Remnant Network — EU',
    adcp_publisher: 'remnant-network.eu',
  },
  // Storyboard-fixture-aligned entries — the `sales_non_guaranteed`
  // storyboard sends payloads with these publisher domains. Mirrors the
  // pattern from `sales-guaranteed/seed-data.ts`. Without seeded fixture
  // domains, every `_lookup/network` returns 404 and a blind agent has
  // to invent a fallback that contradicts the skill's "fail closed on
  // 404" advice. Track upstream-fixture rationale at adcontextprotocol/adcp#3822.
  {
    network_code: 'net_acmeoutdoor',
    display_name: 'Acme Outdoor Media',
    adcp_publisher: 'acmeoutdoor.example',
  },
  {
    network_code: 'net_pinnacle',
    display_name: 'Pinnacle Agency',
    adcp_publisher: 'pinnacle-agency.example',
  },
];

export const AD_UNITS: MockAdUnit[] = [
  {
    ad_unit_id: 'au_us_display_medrec',
    name: 'US Display Medrec — Run of Network',
    path: '/remnant/us/display/medrec',
    network_code: 'net_remnant_us',
    sizes: [{ width: 300, height: 250 }],
    environment: 'web',
    targetable: true,
  },
  {
    ad_unit_id: 'au_us_display_leaderboard',
    name: 'US Display Leaderboard — Run of Network',
    path: '/remnant/us/display/leaderboard',
    network_code: 'net_remnant_us',
    sizes: [{ width: 728, height: 90 }],
    environment: 'web',
    targetable: true,
  },
  {
    ad_unit_id: 'au_us_video_outstream',
    name: 'US Video Outstream — Run of Network',
    path: '/remnant/us/video/outstream',
    network_code: 'net_remnant_us',
    sizes: [{ width: 640, height: 360 }],
    environment: 'web',
    targetable: true,
  },
  {
    ad_unit_id: 'au_us_ctv_15s',
    name: 'US CTV 15s — Programmatic Remnant',
    path: '/remnant/us/ctv/15s',
    network_code: 'net_remnant_us',
    sizes: [{ width: 1920, height: 1080 }],
    environment: 'ctv',
    targetable: true,
  },
  {
    ad_unit_id: 'au_eu_display_medrec',
    name: 'EU Display Medrec — Run of Network',
    path: '/remnant/eu/display/medrec',
    network_code: 'net_remnant_eu',
    sizes: [{ width: 300, height: 250 }],
    environment: 'web',
    targetable: true,
  },
  // Storyboard-fixture-aligned ad units.
  {
    ad_unit_id: 'au_acmeoutdoor_dooh',
    name: 'Acme Outdoor — DOOH Programmatic',
    path: '/acme/outdoor/dooh',
    network_code: 'net_acmeoutdoor',
    sizes: [{ width: 1920, height: 1080 }],
    environment: 'web',
    targetable: true,
  },
  {
    ad_unit_id: 'au_pinnacle_remnant',
    name: 'Pinnacle Display Remnant',
    path: '/pinnacle/display/remnant',
    network_code: 'net_pinnacle',
    sizes: [{ width: 300, height: 250 }],
    environment: 'web',
    targetable: true,
  },
];

export const PRODUCTS: MockProduct[] = [
  {
    product_id: 'display_medrec_remnant',
    name: 'Display Medrec — Remnant',
    network_code: 'net_remnant_us',
    delivery_type: 'non_guaranteed',
    channel: 'display',
    format_ids: ['display_300x250'],
    ad_unit_ids: ['au_us_display_medrec'],
    pricing: { min_cpm: 1.5, target_cpm: 2.25, currency: 'USD' },
  },
  {
    product_id: 'display_leaderboard_remnant',
    name: 'Display Leaderboard — Remnant',
    network_code: 'net_remnant_us',
    delivery_type: 'non_guaranteed',
    channel: 'display',
    format_ids: ['display_728x90'],
    ad_unit_ids: ['au_us_display_leaderboard'],
    pricing: { min_cpm: 1.0, target_cpm: 1.5, currency: 'USD' },
  },
  {
    product_id: 'video_outstream_remnant',
    name: 'Video Outstream — Remnant',
    network_code: 'net_remnant_us',
    delivery_type: 'non_guaranteed',
    channel: 'video',
    format_ids: ['video_30s', 'video_15s'],
    ad_unit_ids: ['au_us_video_outstream'],
    pricing: { min_cpm: 8.0, target_cpm: 12.0, currency: 'USD', min_spend: 1_000 },
  },
  {
    product_id: 'ctv_15s_remnant',
    name: 'CTV 15s — Programmatic Remnant',
    network_code: 'net_remnant_us',
    delivery_type: 'non_guaranteed',
    channel: 'ctv',
    format_ids: ['video_15s'],
    ad_unit_ids: ['au_us_ctv_15s'],
    pricing: { min_cpm: 15.0, target_cpm: 22.0, currency: 'USD', min_spend: 5_000 },
  },
  {
    product_id: 'display_medrec_remnant_eu',
    name: 'Display Medrec — Remnant (EU)',
    network_code: 'net_remnant_eu',
    delivery_type: 'non_guaranteed',
    channel: 'display',
    format_ids: ['display_300x250'],
    ad_unit_ids: ['au_eu_display_medrec'],
    pricing: { min_cpm: 1.2, target_cpm: 1.8, currency: 'EUR' },
  },
  // Storyboard-fixture-aligned products.
  {
    product_id: 'acme_dooh_remnant_q2',
    name: 'Acme Outdoor — DOOH Programmatic Q2',
    network_code: 'net_acmeoutdoor',
    delivery_type: 'non_guaranteed',
    channel: 'video',
    format_ids: ['video_15s'],
    ad_unit_ids: ['au_acmeoutdoor_dooh'],
    pricing: { min_cpm: 6.0, target_cpm: 9.0, currency: 'USD', min_spend: 500 },
  },
  {
    product_id: 'pinnacle_display_remnant_q2',
    name: 'Pinnacle Display Remnant Q2',
    network_code: 'net_pinnacle',
    delivery_type: 'non_guaranteed',
    channel: 'display',
    format_ids: ['display_300x250'],
    ad_unit_ids: ['au_pinnacle_remnant'],
    pricing: { min_cpm: 0.85, target_cpm: 1.3, currency: 'USD' },
  },
];

/** Default static API key (Bearer). Real DSPs / SSPs typically use OAuth
 * or signed-request auth; static Bearer keeps the test surface varied
 * (sales-social already exercises OAuth, sales-guaranteed uses static
 * Bearer too — this mock matches the latter to focus on the auction
 * shape rather than re-exercising OAuth). */
export const DEFAULT_API_KEY = 'mock_sales_non_guaranteed_key_do_not_use_in_prod';
