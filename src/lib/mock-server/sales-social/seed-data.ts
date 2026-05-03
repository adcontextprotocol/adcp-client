export interface MockAdvertiser {
  advertiser_id: string;
  display_name: string;
  /** AdCP-side identifier the adapter receives in `account.advertiser` (or
   * `account.brand.domain`) and must translate to `advertiser_id` for path
   * composition. */
  adcp_advertiser: string;
  currency: string;
  timezone: string;
  status: 'active' | 'suspended' | 'archived';
}

export interface MockOAuthClient {
  client_id: string;
  client_secret: string;
  /** Advertisers this OAuth client can access. Token issued to this client
   * is valid for any of these advertisers' resources. */
  authorized_advertiser_ids: string[];
}

/**
 * The "customer-level" OAuth client. Real walled-garden ad APIs issue one
 * app credential per developer / system-user, valid across multiple
 * advertiser seats owned by that customer.
 */
export const OAUTH_CLIENTS: MockOAuthClient[] = [
  {
    client_id: 'walled_garden_test_client_001',
    client_secret: 'walled_garden_test_secret_do_not_use_in_prod',
    authorized_advertiser_ids: ['adv_acme_us', 'adv_summit_us'],
  },
];

export const ADVERTISERS: MockAdvertiser[] = [
  {
    advertiser_id: 'adv_acme_us',
    display_name: 'Acme Outdoor — US',
    adcp_advertiser: 'acmeoutdoor.example',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
    status: 'active',
  },
  {
    advertiser_id: 'adv_summit_us',
    display_name: 'Summit Media — US',
    adcp_advertiser: 'summit-media.example',
    currency: 'USD',
    timezone: 'America/New_York',
    status: 'active',
  },
];

/** Access token TTL — long enough not to refresh during a single matrix
 * run, short enough that the refresh path is exercise-able by adopters
 * who want to test it explicitly (`sleep 3700 && retry`). 1 hour is the
 * common default across major walled-garden CAPIs. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** Refresh token TTL — much longer than access. 30 days. Real platforms
 * vary; this is in the realistic range. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
