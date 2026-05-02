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
];

/** Default static API key (Bearer). Real GAM-style platforms use OAuth or
 * service accounts; we use static Bearer here to vary the test surface
 * (sales-social already exercises OAuth). */
export const DEFAULT_API_KEY = 'mock_sales_guaranteed_key_do_not_use_in_prod';
