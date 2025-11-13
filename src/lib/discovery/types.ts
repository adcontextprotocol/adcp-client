/**
 * Property Discovery Types
 * Based on AdCP v2.2.0 specification
 */

/** Property identifier types from AdCP spec */
export type PropertyIdentifierType =
  | 'domain'
  | 'subdomain'
  | 'ios_bundle'
  | 'android_package'
  | 'apple_app_store_id'
  | 'google_play_id'
  | 'amazon_app_store_id'
  | 'roku_channel_id'
  | 'samsung_app_id'
  | 'lg_channel_id'
  | 'vizio_app_id'
  | 'fire_tv_app_id'
  | 'dooh_venue_id'
  | 'podcast_rss_feed'
  | 'spotify_show_id'
  | 'apple_podcast_id'
  | 'iab_tech_lab_domain_id'
  | 'custom';

/** Property identifier */
export interface PropertyIdentifier {
  type: PropertyIdentifierType;
  value: string;
}

/** Property types */
export type PropertyType =
  | 'website'
  | 'mobile_app'
  | 'ctv_app'
  | 'dooh'
  | 'podcast'
  | 'radio'
  | 'streaming_audio';

/** Advertising property definition from adagents.json */
export interface Property {
  property_id?: string;
  property_type: PropertyType;
  name: string;
  identifiers: PropertyIdentifier[];
  tags?: string[];
  publisher_domain?: string;
}

/** Authorized agent from adagents.json */
export interface AuthorizedAgent {
  url: string;
  authorized_for: string;
  property_ids?: string[];
}

/** adagents.json structure */
export interface AdAgentsJson {
  $schema?: string;
  authorized_agents: AuthorizedAgent[];
  properties?: Property[];
  last_updated?: string;
}
