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
  delivery_type: 'guaranteed' | 'non_guaranteed';
  channel: 'video' | 'ctv' | 'display' | 'audio';
  format_ids: string[];
  ad_unit_ids: string[];
  pricing: {
    model: 'cpm' | 'cpv';
    cpm: number;
    currency: string;
    min_spend?: number;
  };
  availability?: {
    start_date?: string;
    end_date?: string;
    available_impressions?: number;
  };
}

export const NETWORKS: MockNetwork[] = [
  {
    network_code: 'net_premium_us',
    display_name: 'Premium Sports Network — US',
    adcp_publisher: 'premium-sports.example',
  },
  {
    network_code: 'net_premium_uk',
    display_name: 'Premium Sports Network — UK',
    adcp_publisher: 'premium-sports.uk',
  },
  // Storyboard-fixture-aligned entries — the `sales_guaranteed` storyboard
  // sends payloads with these publisher domains. Without them, every
  // `_lookup/network` returns 404 and a blind agent has to invent a fallback
  // that contradicts the skill's "fail closed on 404" advice. Issue
  // adcontextprotocol/adcp#3822. Until the storyboard runner exposes a
  // setup phase that primes the upstream, we seed the fixture domains
  // here so blind agents can pass the traffic gate without contradiction.
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
    ad_unit_id: 'au_us_video_preroll',
    name: 'US Sports Preroll',
    path: '/premium/us/sports/preroll',
    network_code: 'net_premium_us',
    sizes: [{ width: 1920, height: 1080 }],
    environment: 'web',
    targetable: true,
  },
  {
    ad_unit_id: 'au_us_ctv_30s',
    name: 'US CTV 30s Spot',
    path: '/premium/us/ctv/30s',
    network_code: 'net_premium_us',
    sizes: [{ width: 1920, height: 1080 }],
    environment: 'ctv',
    targetable: true,
  },
  {
    ad_unit_id: 'au_us_display_300x250',
    name: 'US Display Medrec',
    path: '/premium/us/display/medrec',
    network_code: 'net_premium_us',
    sizes: [{ width: 300, height: 250 }],
    environment: 'web',
    targetable: true,
  },
  {
    ad_unit_id: 'au_uk_video_preroll',
    name: 'UK Sports Preroll',
    path: '/premium/uk/sports/preroll',
    network_code: 'net_premium_uk',
    sizes: [{ width: 1920, height: 1080 }],
    environment: 'web',
    targetable: true,
  },
  // Storyboard-fixture-aligned ad units (see NETWORKS comment + adcp#3822).
  {
    ad_unit_id: 'au_acmeoutdoor_billboards',
    name: 'Acme Outdoor — Programmatic DOOH Billboards',
    path: '/acme/outdoor/billboards',
    network_code: 'net_acmeoutdoor',
    sizes: [{ width: 1920, height: 1080 }],
    environment: 'web',
    targetable: true,
  },
  {
    ad_unit_id: 'au_pinnacle_video_preroll',
    name: 'Pinnacle Premium Video Preroll',
    path: '/pinnacle/video/preroll',
    network_code: 'net_pinnacle',
    sizes: [{ width: 1920, height: 1080 }],
    environment: 'web',
    targetable: true,
  },
];

export const PRODUCTS: MockProduct[] = [
  {
    product_id: 'sports_preroll_q2_guaranteed',
    name: 'Sports Preroll Q2 — Guaranteed',
    network_code: 'net_premium_us',
    delivery_type: 'guaranteed',
    channel: 'video',
    format_ids: ['video_30s', 'video_15s'],
    ad_unit_ids: ['au_us_video_preroll'],
    pricing: { model: 'cpm', cpm: 35.0, currency: 'USD', min_spend: 25_000 },
    availability: {
      start_date: '2026-04-01',
      end_date: '2026-06-30',
      available_impressions: 50_000_000,
    },
  },
  {
    product_id: 'outdoor_ctv_q2_guaranteed',
    name: 'CTV Outdoor Q2 — Guaranteed',
    network_code: 'net_premium_us',
    delivery_type: 'guaranteed',
    channel: 'ctv',
    format_ids: ['video_30s'],
    ad_unit_ids: ['au_us_ctv_30s'],
    pricing: { model: 'cpm', cpm: 60.0, currency: 'USD', min_spend: 50_000 },
    availability: {
      start_date: '2026-04-01',
      end_date: '2026-06-30',
      available_impressions: 20_000_000,
    },
  },
  {
    product_id: 'display_medrec_run_of_site',
    name: 'Display Medrec — Run of Site',
    network_code: 'net_premium_us',
    delivery_type: 'non_guaranteed',
    channel: 'display',
    format_ids: ['display_300x250'],
    ad_unit_ids: ['au_us_display_300x250'],
    pricing: { model: 'cpm', cpm: 4.5, currency: 'USD' },
  },
  // Storyboard-fixture-aligned products (see NETWORKS comment + adcp#3822).
  {
    product_id: 'acme_dooh_billboards_q2',
    name: 'Acme Outdoor — DOOH Billboards Q2',
    network_code: 'net_acmeoutdoor',
    delivery_type: 'guaranteed',
    channel: 'video',
    format_ids: ['video_30s'],
    ad_unit_ids: ['au_acmeoutdoor_billboards'],
    pricing: { model: 'cpm', cpm: 28.0, currency: 'USD', min_spend: 15_000 },
    availability: {
      start_date: '2026-04-01',
      end_date: '2026-06-30',
      available_impressions: 30_000_000,
    },
  },
  {
    product_id: 'pinnacle_video_preroll_q2',
    name: 'Pinnacle Premium Video Preroll Q2',
    network_code: 'net_pinnacle',
    delivery_type: 'guaranteed',
    channel: 'video',
    format_ids: ['video_30s', 'video_15s'],
    ad_unit_ids: ['au_pinnacle_video_preroll'],
    pricing: { model: 'cpm', cpm: 42.0, currency: 'USD', min_spend: 30_000 },
    availability: {
      start_date: '2026-04-01',
      end_date: '2026-06-30',
      available_impressions: 25_000_000,
    },
  },
];

/** Default static API key (Bearer). Real GAM-style platforms use OAuth or
 * service accounts; we use static Bearer here to vary the test surface
 * (sales-social already exercises OAuth). */
export const DEFAULT_API_KEY = 'mock_sales_guaranteed_key_do_not_use_in_prod';
