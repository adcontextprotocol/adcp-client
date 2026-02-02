// Generated AdCP core types from official schemas vlatest
// Generated at: 2026-02-02T14:00:27.160Z

// MEDIA-BUY SCHEMA
/**
 * Status of a media buy
 */
export type MediaBuyStatus = 'pending_activation' | 'active' | 'paused' | 'completed';
/**
 * Budget pacing strategy
 */
export type Pacing = 'even' | 'asap' | 'front_loaded';
/**
 * Metro area classification system (e.g., 'nielsen_dma', 'uk_itl2')
 */
export type MetroAreaSystem = 'nielsen_dma' | 'uk_itl1' | 'uk_itl2' | 'eurostat_nuts2' | 'custom';
/**
 * Postal code system (e.g., 'us_zip', 'gb_outward'). System name encodes country and precision.
 */
export type PostalCodeSystem =
  | 'us_zip'
  | 'us_zip_plus_four'
  | 'gb_outward'
  | 'gb_full'
  | 'ca_fsa'
  | 'ca_full'
  | 'de_plz'
  | 'fr_code_postal'
  | 'au_postcode';

/**
 * Represents a purchased advertising campaign
 */
export interface MediaBuy {
  /**
   * Publisher's unique identifier for the media buy
   */
  media_buy_id: string;
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref?: string;
  account?: Account;
  status: MediaBuyStatus;
  /**
   * Description of advertiser and what is being promoted
   */
  promoted_offering: string;
  /**
   * Total budget amount
   */
  total_budget: number;
  /**
   * Array of packages within this media buy
   */
  packages: Package[];
  /**
   * ISO 8601 timestamp for creative upload deadline
   */
  creative_deadline?: string;
  /**
   * Creation timestamp
   */
  created_at?: string;
  /**
   * Last update timestamp
   */
  updated_at?: string;
  ext?: ExtensionObject;
}
/**
 * Account billed for this media buy
 */
export interface Account {
  /**
   * Unique identifier for this account
   */
  account_id: string;
  /**
   * Human-readable account name (e.g., 'Coke', 'Coke c/o Publicis')
   */
  name: string;
  /**
   * The advertiser whose rates apply to this account
   */
  advertiser?: string;
  /**
   * Optional intermediary who receives invoices on behalf of the advertiser (e.g., agency)
   */
  billing_proxy?: string;
  /**
   * Account status
   */
  status: 'active' | 'suspended' | 'closed';
  /**
   * Identifier for the rate card applied to this account
   */
  rate_card?: string;
  /**
   * Payment terms (e.g., 'net_30', 'prepay')
   */
  payment_terms?: string;
  /**
   * Maximum outstanding balance allowed
   */
  credit_limit?: {
    amount: number;
    currency: string;
  };
  ext?: ExtensionObject;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface ExtensionObject {
  [k: string]: unknown | undefined;
}
/**
 * A specific product within a media buy (line item)
 */
export interface Package {
  /**
   * Publisher's unique identifier for the package
   */
  package_id: string;
  /**
   * Buyer's reference identifier for this package
   */
  buyer_ref?: string;
  /**
   * ID of the product this package is based on
   */
  product_id?: string;
  /**
   * Budget allocation for this package in the currency specified by the pricing option
   */
  budget?: number;
  pacing?: Pacing;
  /**
   * ID of the selected pricing option from the product's pricing_options array
   */
  pricing_option_id?: string;
  /**
   * Bid price for auction-based CPM pricing (present if using cpm-auction-option)
   */
  bid_price?: number;
  /**
   * Impression goal for this package
   */
  impressions?: number;
  targeting_overlay?: TargetingOverlay;
  /**
   * Creative assets assigned to this package
   */
  creative_assignments?: CreativeAssignment[];
  /**
   * Format IDs that creative assets will be provided for this package
   */
  format_ids_to_provide?: FormatID[];
  /**
   * Whether this package is paused by the buyer. Paused packages do not deliver impressions. Defaults to false.
   */
  paused?: boolean;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Optional geographic refinements for media buys. Most targeting should be expressed in the brief and handled by the publisher. These fields are primarily for geographic restrictions (RCT testing, regulatory compliance).
 */
export interface TargetingOverlay {
  /**
   * Restrict delivery to specific countries. ISO 3166-1 alpha-2 codes (e.g., 'US', 'GB', 'DE').
   */
  geo_countries?: string[];
  /**
   * Restrict delivery to specific regions/states. ISO 3166-2 subdivision codes (e.g., 'US-CA', 'GB-SCT').
   */
  geo_regions?: string[];
  /**
   * Restrict delivery to specific metro areas. Each entry specifies the classification system and target values. Seller must declare supported systems in get_adcp_capabilities.
   */
  geo_metros?: {
    system: MetroAreaSystem;
    /**
     * Metro codes within the system (e.g., ['501', '602'] for Nielsen DMAs)
     *
     * @minItems 1
     */
    values: [string, ...string[]];
  }[];
  /**
   * Restrict delivery to specific postal areas. Each entry specifies the postal system and target values. Seller must declare supported systems in get_adcp_capabilities.
   */
  geo_postal_areas?: {
    system: PostalCodeSystem;
    /**
     * Postal codes within the system (e.g., ['10001', '10002'] for us_zip)
     *
     * @minItems 1
     */
    values: [string, ...string[]];
  }[];
  /**
   * AXE segment ID to include for targeting
   */
  axe_include_segment?: string;
  /**
   * AXE segment ID to exclude from targeting
   */
  axe_exclude_segment?: string;
  frequency_cap?: FrequencyCap;
  property_list?: PropertyListReference;
  [k: string]: unknown | undefined;
}
/**
 * Frequency capping settings for package-level application
 */
export interface FrequencyCap {
  /**
   * Minutes to suppress after impression
   */
  suppress_minutes: number;
  [k: string]: unknown | undefined;
}
/**
 * Reference to a property list for targeting specific properties within this product. The package runs on the intersection of the product's publisher_properties and this list. Sellers SHOULD return a validation error if the product has property_targeting_allowed: false.
 */
export interface PropertyListReference {
  /**
   * URL of the agent managing the property list
   */
  agent_url: string;
  /**
   * Identifier for the property list within the agent
   */
  list_id: string;
  /**
   * JWT or other authorization token for accessing the list. Optional if the list is public or caller has implicit access.
   */
  auth_token?: string;
}
/**
 * Assignment of a creative asset to a package with optional placement targeting. Used in create_media_buy and update_media_buy requests. Note: sync_creatives does not support placement_ids - use create/update_media_buy for placement-level targeting.
 */
export interface CreativeAssignment {
  /**
   * Unique identifier for the creative
   */
  creative_id: string;
  /**
   * Delivery weight for this creative
   */
  weight?: number;
  /**
   * Optional array of placement IDs where this creative should run. When omitted, the creative runs on all placements in the package. References placement_id values from the product's placements array.
   *
   * @minItems 1
   */
  placement_ids?: [string, ...string[]];
  [k: string]: unknown | undefined;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface FormatID {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_static', 'video_hosted', 'audio_standard'). When used alone, references a template format. When combined with dimension/duration fields, creates a parameterized format ID for a specific variant.
   */
  id: string;
  /**
   * Width in pixels for visual formats. When specified, height must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  width?: number;
  /**
   * Height in pixels for visual formats. When specified, width must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  height?: number;
  /**
   * Duration in milliseconds for time-based formats (video, audio). When specified, creates a parameterized format ID. Omit to reference a template format without parameters.
   */
  duration_ms?: number;
  [k: string]: unknown | undefined;
}

// CREATIVE-ASSET SCHEMA
/**
 * JavaScript module type
 */
export type JavaScriptModuleType = 'esm' | 'commonjs' | 'script';
/**
 * VAST (Video Ad Serving Template) tag for third-party video ad serving
 */
export type VASTAsset =
  | {
      /**
       * Discriminator indicating VAST is delivered via URL endpoint
       */
      delivery_type: 'url';
      /**
       * URL endpoint that returns VAST XML
       */
      url: string;
      vast_version?: VASTVersion;
      /**
       * Whether VPAID (Video Player-Ad Interface Definition) is supported
       */
      vpaid_enabled?: boolean;
      /**
       * Expected video duration in milliseconds (if known)
       */
      duration_ms?: number;
      /**
       * Tracking events supported by this VAST tag
       */
      tracking_events?: VASTTrackingEvent[];
      [k: string]: unknown | undefined;
    }
  | {
      /**
       * Discriminator indicating VAST is delivered as inline XML content
       */
      delivery_type: 'inline';
      /**
       * Inline VAST XML content
       */
      content: string;
      vast_version?: VASTVersion1;
      /**
       * Whether VPAID (Video Player-Ad Interface Definition) is supported
       */
      vpaid_enabled?: boolean;
      /**
       * Expected video duration in milliseconds (if known)
       */
      duration_ms?: number;
      /**
       * Tracking events supported by this VAST tag
       */
      tracking_events?: VASTTrackingEvent[];
      [k: string]: unknown | undefined;
    };
/**
 * VAST specification version
 */
export type VASTVersion = '2.0' | '3.0' | '4.0' | '4.1' | '4.2';
/**
 * Standard VAST tracking events for video ad playback and interaction
 */
export type VASTTrackingEvent =
  | 'start'
  | 'firstQuartile'
  | 'midpoint'
  | 'thirdQuartile'
  | 'complete'
  | 'impression'
  | 'click'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'mute'
  | 'unmute'
  | 'fullscreen'
  | 'exitFullscreen'
  | 'playerExpand'
  | 'playerCollapse';
/**
 * VAST specification version
 */
export type VASTVersion1 = '2.0' | '3.0' | '4.0' | '4.1' | '4.2';
/**
 * DAAST (Digital Audio Ad Serving Template) tag for third-party audio ad serving
 */
export type DAASTAsset =
  | {
      /**
       * Discriminator indicating DAAST is delivered via URL endpoint
       */
      delivery_type: 'url';
      /**
       * URL endpoint that returns DAAST XML
       */
      url: string;
      daast_version?: DAASTVersion;
      /**
       * Expected audio duration in milliseconds (if known)
       */
      duration_ms?: number;
      /**
       * Tracking events supported by this DAAST tag
       */
      tracking_events?: DAASTTrackingEvent[];
      /**
       * Whether companion display ads are included
       */
      companion_ads?: boolean;
      [k: string]: unknown | undefined;
    }
  | {
      /**
       * Discriminator indicating DAAST is delivered as inline XML content
       */
      delivery_type: 'inline';
      /**
       * Inline DAAST XML content
       */
      content: string;
      daast_version?: DAASTVersion1;
      /**
       * Expected audio duration in milliseconds (if known)
       */
      duration_ms?: number;
      /**
       * Tracking events supported by this DAAST tag
       */
      tracking_events?: DAASTTrackingEvent[];
      /**
       * Whether companion display ads are included
       */
      companion_ads?: boolean;
      [k: string]: unknown | undefined;
    };
/**
 * DAAST specification version
 */
export type DAASTVersion = '1.0' | '1.1';
/**
 * Standard DAAST tracking events for audio ad playback and interaction
 */
export type DAASTTrackingEvent =
  | 'start'
  | 'firstQuartile'
  | 'midpoint'
  | 'thirdQuartile'
  | 'complete'
  | 'impression'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'mute'
  | 'unmute';
/**
 * DAAST specification version
 */
export type DAASTVersion1 = '1.0' | '1.1';
/**
 * Brand information manifest containing assets, themes, and guidelines. Can be provided inline or as a URL reference to a hosted manifest.
 */
export type BrandManifestReference = BrandManifest | string;
/**
 * Type of asset. Note: Brand manifests typically contain basic media assets (image, video, audio, text). Code assets (html, javascript, css) and ad markup (vast, daast) are usually not part of brand asset libraries.
 */
export type AssetContentType =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'markdown'
  | 'html'
  | 'css'
  | 'javascript'
  | 'vast'
  | 'daast'
  | 'promoted_offerings'
  | 'url'
  | 'webhook';
/**
 * Type of URL asset: 'clickthrough' for user click destination (landing page), 'tracker_pixel' for impression/event tracking via HTTP request (fires GET, expects pixel/204 response), 'tracker_script' for measurement SDKs that must load as <script> tag (OMID verification, native event trackers using method:2)
 */
export type URLAssetType = 'clickthrough' | 'tracker_pixel' | 'tracker_script';
/**
 * For generative creatives: set to 'approved' to finalize, 'rejected' to request regeneration with updated assets/message. Omit for non-generative creatives (system will set based on processing state).
 */
export type CreativeStatus = 'processing' | 'approved' | 'rejected' | 'pending_review' | 'archived';

/**
 * Creative asset for upload to library - supports static assets, generative formats, and third-party snippets
 */
export interface CreativeAsset {
  /**
   * Unique identifier for the creative
   */
  creative_id: string;
  /**
   * Human-readable creative name
   */
  name: string;
  format_id: FormatID;
  /**
   * Assets required by the format, keyed by asset_role
   */
  assets: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-zA-Z0-9_-]+$".
     */
    [k: string]:
      | ImageAsset
      | VideoAsset
      | AudioAsset
      | TextAsset
      | HTMLAsset
      | CSSAsset
      | JavaScriptAsset
      | VASTAsset
      | DAASTAsset
      | PromotedOfferings
      | URLAsset;
  };
  /**
   * Preview contexts for generative formats - defines what scenarios to generate previews for
   */
  inputs?: {
    /**
     * Human-readable name for this preview variant
     */
    name: string;
    /**
     * Macro values to apply for this preview
     */
    macros?: {
      [k: string]: string | undefined;
    };
    /**
     * Natural language description of the context for AI-generated content
     */
    context_description?: string;
  }[];
  /**
   * User-defined tags for organization and searchability
   */
  tags?: string[];
  status?: CreativeStatus;
  /**
   * Optional delivery weight for creative rotation when uploading via create_media_buy or update_media_buy (0-100). If omitted, platform determines rotation. Only used during upload to media buy - not stored in creative library.
   */
  weight?: number;
  /**
   * Optional array of placement IDs where this creative should run when uploading via create_media_buy or update_media_buy. References placement_id values from the product's placements array. If omitted, creative runs on all placements. Only used during upload to media buy - not stored in creative library.
   */
  placement_ids?: string[];
}
/**
 * Format identifier specifying which format this creative conforms to. Can be: (1) concrete format_id referencing a format with fixed dimensions, (2) template format_id referencing a template format, or (3) parameterized format_id with dimensions/duration parameters for template formats.
 */
export interface ImageAsset {
  /**
   * URL to the image asset
   */
  url: string;
  /**
   * Width in pixels
   */
  width: number;
  /**
   * Height in pixels
   */
  height: number;
  /**
   * Image file format (jpg, png, gif, webp, etc.)
   */
  format?: string;
  /**
   * Alternative text for accessibility
   */
  alt_text?: string;
  [k: string]: unknown | undefined;
}
/**
 * Video asset with URL and technical specifications including audio track properties
 */
export interface VideoAsset {
  /**
   * URL to the video asset
   */
  url: string;
  /**
   * Width in pixels
   */
  width: number;
  /**
   * Height in pixels
   */
  height: number;
  /**
   * Video duration in milliseconds
   */
  duration_ms?: number;
  /**
   * File size in bytes
   */
  file_size_bytes?: number;
  /**
   * Video container format (mp4, webm, mov, etc.)
   */
  container_format?: string;
  /**
   * Video codec used (h264, h265, vp9, av1, prores, etc.)
   */
  video_codec?: string;
  /**
   * Video stream bitrate in kilobits per second
   */
  video_bitrate_kbps?: number;
  /**
   * Frame rate as string to preserve precision (e.g., '23.976', '29.97', '30')
   */
  frame_rate?: string;
  /**
   * Whether the video uses constant (CFR) or variable (VFR) frame rate
   */
  frame_rate_type?: 'constant' | 'variable';
  /**
   * Scan type of the video
   */
  scan_type?: 'progressive' | 'interlaced';
  /**
   * Color space of the video
   */
  color_space?: 'rec709' | 'rec2020' | 'rec2100' | 'srgb' | 'dci_p3';
  /**
   * HDR format if applicable, or 'sdr' for standard dynamic range
   */
  hdr_format?: 'sdr' | 'hdr10' | 'hdr10_plus' | 'hlg' | 'dolby_vision';
  /**
   * Chroma subsampling format
   */
  chroma_subsampling?: '4:2:0' | '4:2:2' | '4:4:4';
  /**
   * Video bit depth
   */
  video_bit_depth?: 8 | 10 | 12;
  /**
   * GOP/keyframe interval in seconds
   */
  gop_interval_seconds?: number;
  /**
   * GOP structure type
   */
  gop_type?: 'closed' | 'open';
  /**
   * Position of moov atom in MP4 container
   */
  moov_atom_position?: 'start' | 'end';
  /**
   * Whether the video contains an audio track
   */
  has_audio?: boolean;
  /**
   * Audio codec used (aac, aac_lc, he_aac, pcm, mp3, ac3, eac3, etc.)
   */
  audio_codec?: string;
  /**
   * Audio sampling rate in Hz (e.g., 44100, 48000)
   */
  audio_sampling_rate_hz?: number;
  /**
   * Audio channel configuration
   */
  audio_channels?: 'mono' | 'stereo' | '5.1' | '7.1';
  /**
   * Audio bit depth
   */
  audio_bit_depth?: 16 | 24 | 32;
  /**
   * Audio bitrate in kilobits per second
   */
  audio_bitrate_kbps?: number;
  /**
   * Integrated loudness in LUFS
   */
  audio_loudness_lufs?: number;
  /**
   * True peak level in dBFS
   */
  audio_true_peak_dbfs?: number;
  [k: string]: unknown | undefined;
}
/**
 * Audio asset with URL and technical specifications
 */
export interface AudioAsset {
  /**
   * URL to the audio asset
   */
  url: string;
  /**
   * Audio duration in milliseconds
   */
  duration_ms?: number;
  /**
   * File size in bytes
   */
  file_size_bytes?: number;
  /**
   * Audio container/file format (mp3, m4a, aac, wav, ogg, flac, etc.)
   */
  container_format?: string;
  /**
   * Audio codec used (aac, aac_lc, he_aac, pcm, mp3, vorbis, opus, flac, ac3, eac3, etc.)
   */
  codec?: string;
  /**
   * Sampling rate in Hz (e.g., 44100, 48000, 96000)
   */
  sampling_rate_hz?: number;
  /**
   * Channel configuration
   */
  channels?: 'mono' | 'stereo' | '5.1' | '7.1';
  /**
   * Bit depth
   */
  bit_depth?: 16 | 24 | 32;
  /**
   * Bitrate in kilobits per second
   */
  bitrate_kbps?: number;
  /**
   * Integrated loudness in LUFS
   */
  loudness_lufs?: number;
  /**
   * True peak level in dBFS
   */
  true_peak_dbfs?: number;
  [k: string]: unknown | undefined;
}
/**
 * Text content asset
 */
export interface TextAsset {
  /**
   * Text content
   */
  content: string;
  /**
   * Language code (e.g., 'en', 'es', 'fr')
   */
  language?: string;
  [k: string]: unknown | undefined;
}
/**
 * HTML content asset
 */
export interface HTMLAsset {
  /**
   * HTML content
   */
  content: string;
  /**
   * HTML version (e.g., 'HTML5')
   */
  version?: string;
  [k: string]: unknown | undefined;
}
/**
 * CSS stylesheet asset
 */
export interface CSSAsset {
  /**
   * CSS content
   */
  content: string;
  /**
   * CSS media query context (e.g., 'screen', 'print')
   */
  media?: string;
  [k: string]: unknown | undefined;
}
/**
 * JavaScript code asset
 */
export interface JavaScriptAsset {
  /**
   * JavaScript content
   */
  content: string;
  module_type?: JavaScriptModuleType;
  [k: string]: unknown | undefined;
}
/**
 * Complete offering specification combining brand manifest, product selectors, and optional SI agent endpoint. Provides all context needed for creative generation and/or conversational experiences about what is being promoted. When si_agent_url is present, hosts can connect users to conversational experiences about any of the offerings.
 */
export interface PromotedOfferings {
  brand_manifest: BrandManifestReference;
  /**
   * MCP endpoint URL for the brand's SI agent. When present, hosts can connect users to conversational experiences about any of the offerings. The agent handles si_get_offering lookups and full conversations.
   */
  si_agent_url?: string;
  product_selectors?: PromotedProducts;
  /**
   * Offerings available for promotion. Each offering can include creative assets (via portfolio_ref or inline assets) for traditional ads. When si_agent_url is set at the parent level, hosts can offer conversational experiences about any of these offerings.
   */
  offerings?: Offering[];
  /**
   * Selectors to choose specific assets from the brand manifest
   */
  asset_selectors?: {
    /**
     * Select assets with specific tags (e.g., ['holiday', 'premium'])
     */
    tags?: string[];
    /**
     * Filter by asset type (e.g., ['image', 'video'])
     */
    asset_types?: (
      | 'image'
      | 'video'
      | 'audio'
      | 'vast'
      | 'daast'
      | 'text'
      | 'url'
      | 'html'
      | 'css'
      | 'javascript'
      | 'webhook'
    )[];
    /**
     * Exclude assets with these tags
     */
    exclude_tags?: string[];
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * Inline brand manifest object
 */
export interface BrandManifest {
  /**
   * Primary brand URL for context and asset discovery. Creative agents can infer brand information from this URL.
   */
  url?: string;
  /**
   * URL to the brand's privacy policy. Used for consumer consent flows when personal data may be shared with the advertiser. AI platforms can use this to present explicit privacy choices to users before data handoff.
   */
  privacy_policy_url?: string;
  /**
   * Brand or business name
   */
  name: string;
  /**
   * Brand logo assets with semantic tags for different use cases
   */
  logos?: {
    /**
     * URL to the logo asset
     */
    url: string;
    /**
     * Semantic tags describing the logo variant (e.g., 'dark', 'light', 'square', 'horizontal', 'icon')
     */
    tags?: string[];
    /**
     * Logo width in pixels
     */
    width?: number;
    /**
     * Logo height in pixels
     */
    height?: number;
  }[];
  /**
   * Brand color palette
   */
  colors?: {
    /**
     * Primary brand color (hex format)
     */
    primary?: string;
    /**
     * Secondary brand color (hex format)
     */
    secondary?: string;
    /**
     * Accent color (hex format)
     */
    accent?: string;
    /**
     * Background color (hex format)
     */
    background?: string;
    /**
     * Text color (hex format)
     */
    text?: string;
  };
  /**
   * Brand typography guidelines
   */
  fonts?: {
    /**
     * Primary font family name
     */
    primary?: string;
    /**
     * Secondary font family name
     */
    secondary?: string;
    /**
     * URLs to web font files if using custom fonts
     */
    font_urls?: string[];
  };
  /**
   * Brand voice and messaging tone (e.g., 'professional', 'casual', 'humorous', 'trustworthy', 'innovative')
   */
  tone?: string;
  /**
   * Brand voice configuration for audio/conversational experiences
   */
  voice?: {
    /**
     * TTS provider (e.g., 'elevenlabs', 'openai', 'amazon_polly')
     */
    provider?: string;
    /**
     * Provider-specific voice identifier
     */
    voice_id?: string;
    /**
     * Provider-specific voice settings (speed, pitch, etc.)
     */
    settings?: {
      [k: string]: unknown | undefined;
    };
  };
  /**
   * Brand avatar configuration for visual conversational experiences
   */
  avatar?: {
    /**
     * Avatar provider (e.g., 'd-id', 'heygen', 'synthesia')
     */
    provider?: string;
    /**
     * Provider-specific avatar identifier
     */
    avatar_id?: string;
    /**
     * Provider-specific avatar settings
     */
    settings?: {
      [k: string]: unknown | undefined;
    };
  };
  /**
   * Brand tagline or slogan
   */
  tagline?: string;
  /**
   * Brand asset library with explicit assets and tags. Assets are referenced inline with URLs pointing to CDN-hosted files.
   */
  assets?: {
    /**
     * Unique identifier for this asset
     */
    asset_id: string;
    asset_type: AssetContentType;
    /**
     * URL to CDN-hosted asset file
     */
    url: string;
    /**
     * Tags for asset discovery (e.g., 'holiday', 'lifestyle', 'product_shot')
     */
    tags?: string[];
    /**
     * Human-readable asset name
     */
    name?: string;
    /**
     * Asset description or usage notes
     */
    description?: string;
    /**
     * Image/video width in pixels
     */
    width?: number;
    /**
     * Image/video height in pixels
     */
    height?: number;
    /**
     * Video/audio duration in seconds
     */
    duration_seconds?: number;
    /**
     * File size in bytes
     */
    file_size_bytes?: number;
    /**
     * File format (e.g., 'jpg', 'mp4', 'mp3')
     */
    format?: string;
    /**
     * Additional asset-specific metadata
     */
    metadata?: {
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  }[];
  /**
   * Product catalog information for e-commerce advertisers. Enables SKU-level creative generation and product selection.
   */
  product_catalog?: {
    /**
     * URL to product catalog feed
     */
    feed_url: string;
    /**
     * Format of the product feed. Use 'openai_product_feed' for feeds conforming to the OpenAI Commerce Product Feed specification.
     */
    feed_format?: 'google_merchant_center' | 'facebook_catalog' | 'openai_product_feed' | 'custom';
    /**
     * Product categories available in the catalog (for filtering)
     */
    categories?: string[];
    /**
     * When the product catalog was last updated
     */
    last_updated?: string;
    /**
     * How frequently the product catalog is updated
     */
    update_frequency?: 'realtime' | 'hourly' | 'daily' | 'weekly';
    /**
     * Agentic checkout endpoint configuration. Enables AI agents to complete purchases on behalf of users through a structured checkout API.
     */
    agentic_checkout?: {
      /**
       * Base URL for checkout session API (e.g., https://merchant.com/api/checkout_sessions)
       */
      endpoint: string;
      /**
       * Checkout API specification implemented by the endpoint
       */
      spec: 'openai_agentic_checkout_v1';
      /**
       * Payment providers supported by this checkout endpoint
       */
      supported_payment_providers?: string[];
    };
    [k: string]: unknown | undefined;
  };
  /**
   * Legal disclaimers or required text that must appear in creatives
   */
  disclaimers?: {
    /**
     * Disclaimer text
     */
    text: string;
    /**
     * When this disclaimer applies (e.g., 'financial_products', 'health_claims', 'all')
     */
    context?: string;
    /**
     * Whether this disclaimer must appear
     */
    required?: boolean;
  }[];
  /**
   * Industry or vertical (e.g., 'retail', 'automotive', 'finance', 'healthcare')
   */
  industry?: string;
  /**
   * Primary target audience description
   */
  target_audience?: string;
  /**
   * Brand contact information
   */
  contact?: {
    /**
     * Contact email
     */
    email?: string;
    /**
     * Contact phone number
     */
    phone?: string;
  };
  /**
   * Additional brand metadata
   */
  metadata?: {
    /**
     * When this brand manifest was created
     */
    created_date?: string;
    /**
     * When this brand manifest was last updated
     */
    updated_date?: string;
    /**
     * Brand card version number
     */
    version?: string;
  };
  [k: string]: unknown | undefined;
}
/**
 * Selectors to choose which products/offerings from the brand manifest product catalog to promote
 */
export interface PromotedProducts {
  /**
   * Direct product SKU references from the brand manifest product catalog
   */
  manifest_skus?: string[];
  /**
   * Select products by tags from the brand manifest product catalog (e.g., 'organic', 'sauces', 'holiday')
   */
  manifest_tags?: string[];
  /**
   * Select products from a specific category in the brand manifest product catalog (e.g., 'beverages/soft-drinks', 'food/sauces')
   */
  manifest_category?: string;
  /**
   * Natural language query to select products from the brand manifest (e.g., 'all Kraft Heinz pasta sauces', 'organic products under $20')
   */
  manifest_query?: string;
  [k: string]: unknown | undefined;
}
/**
 * A promotable offering from a brand. Can represent a campaign, product promotion, service, or any other thing the brand wants to make available. Offerings can be promoted via traditional creatives (using portfolio_ref or assets) or conversational SI experiences (via si_agent_url at the promoted-offerings level).
 */
export interface Offering {
  /**
   * Unique identifier for this offering. Used by hosts to reference specific offerings in si_get_offering calls.
   */
  offering_id: string;
  /**
   * Human-readable offering name (e.g., 'Winter Sale', 'Free Trial', 'Enterprise Platform')
   */
  name: string;
  /**
   * Description of what's being offered
   */
  description?: string;
  /**
   * Short promotional tagline for the offering
   */
  tagline?: string;
  /**
   * When the offering becomes available. If not specified, offering is immediately available.
   */
  valid_from?: string;
  /**
   * When the offering expires. If not specified, offering has no expiration.
   */
  valid_to?: string;
  /**
   * URL for checkout/purchase flow when the brand doesn't support agentic checkout.
   */
  checkout_url?: string;
  /**
   * Landing page URL for this offering.
   */
  landing_url?: string;
  /**
   * Assets specific to this offering (images, videos, copy)
   */
  assets?: {
    [k: string]: unknown | undefined;
  }[];
  /**
   * Reference to a creative portfolio for this offering. Portfolios contain organized creative assets across formats, enabling consistent ad delivery for this specific offering.
   */
  portfolio_ref?: string;
  /**
   * Keywords for matching this offering to user intent. Hosts use these for retrieval/relevance scoring.
   */
  keywords?: string[];
  /**
   * Categories this offering belongs to (e.g., 'measurement', 'identity', 'programmatic')
   */
  categories?: string[];
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
export interface URLAsset {
  /**
   * URL reference
   */
  url: string;
  url_type?: URLAssetType;
  /**
   * Description of what this URL points to
   */
  description?: string;
  [k: string]: unknown | undefined;
}

// PRODUCT SCHEMA
/**
 * Selects properties from a publisher's adagents.json. Used for both product definitions and agent authorization. Supports three selection patterns: all properties, specific IDs, or by tags.
 */
export type PublisherPropertySelector =
  | {
      /**
       * Domain where publisher's adagents.json is hosted (e.g., 'cnn.com')
       */
      publisher_domain: string;
      /**
       * Discriminator indicating all properties from this publisher are included
       */
      selection_type: 'all';
      [k: string]: unknown | undefined;
    }
  | {
      /**
       * Domain where publisher's adagents.json is hosted (e.g., 'cnn.com')
       */
      publisher_domain: string;
      /**
       * Discriminator indicating selection by specific property IDs
       */
      selection_type: 'by_id';
      /**
       * Specific property IDs from the publisher's adagents.json
       *
       * @minItems 1
       */
      property_ids: [PropertyID, ...PropertyID[]];
      [k: string]: unknown | undefined;
    }
  | {
      /**
       * Domain where publisher's adagents.json is hosted (e.g., 'cnn.com')
       */
      publisher_domain: string;
      /**
       * Discriminator indicating selection by property tags
       */
      selection_type: 'by_tag';
      /**
       * Property tags from the publisher's adagents.json. Selector covers all properties with these tags
       *
       * @minItems 1
       */
      property_tags: [PropertyTag, ...PropertyTag[]];
      [k: string]: unknown | undefined;
    };
/**
 * Identifier for a publisher property. Must be lowercase alphanumeric with underscores only.
 */
export type PropertyID = string;
/**
 * Tag for categorizing publisher properties. Must be lowercase alphanumeric with underscores only.
 */
export type PropertyTag = string;
/**
 * Type of inventory delivery
 */
export type DeliveryType = 'guaranteed' | 'non_guaranteed';
/**
 * A pricing model option offered by a publisher for a product. Discriminated by pricing_model field. If fixed_price is present, it's fixed pricing. If absent, it's auction-based (floor_price and price_guidance optional).
 */
export type PricingOption =
  | CPMPricingOption
  | VCPMPricingOption
  | CPCPricingOption
  | CPCVPricingOption
  | CPVPricingOption
  | CPPPricingOption
  | FlatRatePricingOption;
/**
 * Available frequencies for delivery reports and metrics updates
 */
export type ReportingFrequency = 'hourly' | 'daily' | 'monthly';
/**
 * Standard delivery and performance metrics available for reporting
 */
export type AvailableMetric =
  | 'impressions'
  | 'spend'
  | 'clicks'
  | 'ctr'
  | 'video_completions'
  | 'completion_rate'
  | 'conversions'
  | 'viewability'
  | 'engagement_rate';
/**
 * Co-branding requirement
 */
export type CoBrandingRequirement = 'required' | 'optional' | 'none';
/**
 * Landing page requirements
 */
export type LandingPageRequirement = 'any' | 'retailer_site_only' | 'must_include_retailer';

/**
 * Represents available advertising inventory
 */
export interface Product {
  /**
   * Unique identifier for the product
   */
  product_id: string;
  /**
   * Human-readable product name
   */
  name: string;
  /**
   * Detailed description of the product and its inventory
   */
  description: string;
  /**
   * Publisher properties covered by this product. Buyers fetch actual property definitions from each publisher's adagents.json and validate agent authorization. Selection patterns mirror the authorization patterns in adagents.json for consistency.
   */
  publisher_properties: PublisherPropertySelector[];
  /**
   * Array of supported creative format IDs - structured format_id objects with agent_url and id
   */
  format_ids: FormatID[];
  /**
   * Optional array of specific placements within this product. When provided, buyers can target specific placements when assigning creatives.
   */
  placements?: Placement[];
  delivery_type: DeliveryType;
  /**
   * Available pricing models for this product
   */
  pricing_options: PricingOption[];
  /**
   * Estimated exposures/impressions for guaranteed products
   */
  estimated_exposures?: number;
  measurement?: Measurement;
  /**
   * Measurement provider and methodology for delivery metrics. The buyer accepts the declared provider as the source of truth for the buy. REQUIRED for all products.
   */
  delivery_measurement: {
    /**
     * Measurement provider(s) used for this product (e.g., 'Google Ad Manager with IAS viewability', 'Nielsen DAR', 'Geopath for DOOH impressions')
     */
    provider: string;
    /**
     * Additional details about measurement methodology in plain language (e.g., 'MRC-accredited viewability. 50% in-view for 1s display / 2s video', 'Panel-based demographic measurement updated monthly')
     */
    notes?: string;
  };
  reporting_capabilities?: ReportingCapabilities;
  creative_policy?: CreativePolicy;
  /**
   * Whether this is a custom product
   */
  is_custom?: boolean;
  /**
   * Whether buyers can filter this product to a subset of its publisher_properties. When false (default), the product is 'all or nothing' - buyers must accept all properties or the product is excluded from property_list filtering results.
   */
  property_targeting_allowed?: boolean;
  /**
   * Explanation of why this product matches the brief (only included when brief is provided)
   */
  brief_relevance?: string;
  /**
   * Expiration timestamp for custom products
   */
  expires_at?: string;
  /**
   * Optional standard visual card (300x400px) for displaying this product in user interfaces. Can be rendered via preview_creative or pre-generated.
   */
  product_card?: {
    format_id: FormatID1;
    /**
     * Asset manifest for rendering the card, structure defined by the format
     */
    manifest: {};
  };
  /**
   * Optional detailed card with carousel and full specifications. Provides rich product presentation similar to media kit pages.
   */
  product_card_detailed?: {
    format_id: FormatID2;
    /**
     * Asset manifest for rendering the detailed card, structure defined by the format
     */
    manifest: {};
  };
  ext?: ExtensionObject;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface Placement {
  /**
   * Unique identifier for the placement within the product
   */
  placement_id: string;
  /**
   * Human-readable name for the placement (e.g., 'Homepage Banner', 'Article Sidebar')
   */
  name: string;
  /**
   * Detailed description of where and how the placement appears
   */
  description?: string;
  /**
   * Format IDs supported by this specific placement. Can include: (1) concrete format_ids (fixed dimensions), (2) template format_ids without parameters (accepts any dimensions/duration), or (3) parameterized format_ids (specific dimension/duration constraints).
   *
   * @minItems 1
   */
  format_ids?: [FormatID, ...FormatID[]];
  [k: string]: unknown | undefined;
}
/**
 * Cost Per Mille (cost per 1,000 impressions) pricing. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface CPMPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per 1,000 impressions
   */
  pricing_model: 'cpm';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per unit. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface PriceGuidance {
  /**
   * 25th percentile of recent winning bids
   */
  p25?: number;
  /**
   * Median of recent winning bids
   */
  p50?: number;
  /**
   * 75th percentile of recent winning bids
   */
  p75?: number;
  /**
   * 90th percentile of recent winning bids
   */
  p90?: number;
  [k: string]: unknown | undefined;
}
/**
 * Viewable Cost Per Mille (cost per 1,000 viewable impressions) pricing - MRC viewability standard. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface VCPMPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per 1,000 viewable impressions (MRC standard)
   */
  pricing_model: 'vcpm';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per unit. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance1;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface PriceGuidance1 {
  /**
   * 25th percentile of recent winning bids
   */
  p25?: number;
  /**
   * Median of recent winning bids
   */
  p50?: number;
  /**
   * 75th percentile of recent winning bids
   */
  p75?: number;
  /**
   * 90th percentile of recent winning bids
   */
  p90?: number;
  [k: string]: unknown | undefined;
}
/**
 * Cost Per Click pricing. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface CPCPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per click
   */
  pricing_model: 'cpc';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per click. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance2;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface PriceGuidance2 {
  /**
   * 25th percentile of recent winning bids
   */
  p25?: number;
  /**
   * Median of recent winning bids
   */
  p50?: number;
  /**
   * 75th percentile of recent winning bids
   */
  p75?: number;
  /**
   * 90th percentile of recent winning bids
   */
  p90?: number;
  [k: string]: unknown | undefined;
}
/**
 * Cost Per Completed View (100% video/audio completion) pricing. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface CPCVPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per completed view (100% completion)
   */
  pricing_model: 'cpcv';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per completed view. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance3;
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface PriceGuidance3 {
  /**
   * 25th percentile of recent winning bids
   */
  p25?: number;
  /**
   * Median of recent winning bids
   */
  p50?: number;
  /**
   * 75th percentile of recent winning bids
   */
  p75?: number;
  /**
   * 90th percentile of recent winning bids
   */
  p90?: number;
  [k: string]: unknown | undefined;
}
/**
 * Cost Per View (at publisher-defined threshold) pricing for video/audio. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface CPVPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per view at threshold
   */
  pricing_model: 'cpv';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per view. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance4;
  /**
   * CPV-specific parameters defining the view threshold
   */
  parameters: {
    view_threshold:
      | number
      | {
          /**
           * Seconds of viewing required
           */
          duration_seconds: number;
          [k: string]: unknown | undefined;
        };
    [k: string]: unknown | undefined;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface PriceGuidance4 {
  /**
   * 25th percentile of recent winning bids
   */
  p25?: number;
  /**
   * Median of recent winning bids
   */
  p50?: number;
  /**
   * 75th percentile of recent winning bids
   */
  p75?: number;
  /**
   * 90th percentile of recent winning bids
   */
  p90?: number;
  [k: string]: unknown | undefined;
}
/**
 * Cost Per Point (Gross Rating Point) pricing for TV and audio campaigns. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface CPPPricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Cost per Gross Rating Point
   */
  pricing_model: 'cpp';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Fixed price per rating point. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance5;
  /**
   * CPP-specific parameters for demographic targeting
   */
  parameters: {
    /**
     * Target demographic in Nielsen format (P18-49, M25-54, W35+, etc.)
     */
    demographic: string;
    /**
     * Minimum GRPs/TRPs required
     */
    min_points?: number;
    [k: string]: unknown | undefined;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface PriceGuidance5 {
  /**
   * 25th percentile of recent winning bids
   */
  p25?: number;
  /**
   * Median of recent winning bids
   */
  p50?: number;
  /**
   * 75th percentile of recent winning bids
   */
  p75?: number;
  /**
   * 90th percentile of recent winning bids
   */
  p90?: number;
  [k: string]: unknown | undefined;
}
/**
 * Flat rate pricing for DOOH, sponsorships, and time-based campaigns. If fixed_price is present, it's fixed pricing. If absent, it's auction-based.
 */
export interface FlatRatePricingOption {
  /**
   * Unique identifier for this pricing option within the product
   */
  pricing_option_id: string;
  /**
   * Fixed cost regardless of delivery volume
   */
  pricing_model: 'flat_rate';
  /**
   * ISO 4217 currency code
   */
  currency: string;
  /**
   * Flat rate cost. If present, this is fixed pricing. If absent, auction-based.
   */
  fixed_price?: number;
  /**
   * Minimum acceptable bid for auction pricing (mutually exclusive with fixed_price). Bids below this value will be rejected.
   */
  floor_price?: number;
  price_guidance?: PriceGuidance6;
  /**
   * Flat rate parameters for DOOH and time-based campaigns
   */
  parameters?: {
    /**
     * Duration in hours for time-based pricing
     */
    duration_hours?: number;
    /**
     * Guaranteed share of voice (0-100)
     */
    sov_percentage?: number;
    /**
     * Duration of ad loop rotation in seconds
     */
    loop_duration_seconds?: number;
    /**
     * Minimum plays per hour
     */
    min_plays_per_hour?: number;
    /**
     * Named venue package identifier
     */
    venue_package?: string;
    /**
     * Estimated impressions (informational)
     */
    estimated_impressions?: number;
    /**
     * Specific daypart for time-based pricing
     */
    daypart?: string;
    [k: string]: unknown | undefined;
  };
  /**
   * Minimum spend requirement per package using this pricing option, in the specified currency
   */
  min_spend_per_package?: number;
  [k: string]: unknown | undefined;
}
/**
 * Optional pricing guidance for auction-based bidding
 */
export interface PriceGuidance6 {
  /**
   * 25th percentile of recent winning bids
   */
  p25?: number;
  /**
   * Median of recent winning bids
   */
  p50?: number;
  /**
   * 75th percentile of recent winning bids
   */
  p75?: number;
  /**
   * 90th percentile of recent winning bids
   */
  p90?: number;
  [k: string]: unknown | undefined;
}
/**
 * Measurement capabilities included with a product
 */
export interface Measurement {
  /**
   * Type of measurement
   */
  type: string;
  /**
   * Attribution methodology
   */
  attribution: string;
  /**
   * Attribution window
   */
  window?: string;
  /**
   * Reporting frequency and format
   */
  reporting: string;
  [k: string]: unknown | undefined;
}
/**
 * Reporting capabilities available for a product
 */
export interface ReportingCapabilities {
  /**
   * Supported reporting frequency options
   *
   * @minItems 1
   */
  available_reporting_frequencies: [ReportingFrequency, ...ReportingFrequency[]];
  /**
   * Expected delay in minutes before reporting data becomes available (e.g., 240 for 4-hour delay)
   */
  expected_delay_minutes: number;
  /**
   * Timezone for reporting periods. Use 'UTC' or IANA timezone (e.g., 'America/New_York'). Critical for daily/monthly frequency alignment.
   */
  timezone: string;
  /**
   * Whether this product supports webhook-based reporting notifications
   */
  supports_webhooks: boolean;
  /**
   * Metrics available in reporting. Impressions and spend are always implicitly included.
   */
  available_metrics: AvailableMetric[];
  [k: string]: unknown | undefined;
}
/**
 * Creative requirements and restrictions for a product
 */
export interface CreativePolicy {
  co_branding: CoBrandingRequirement;
  landing_page: LandingPageRequirement;
  /**
   * Whether creative templates are provided
   */
  templates_available: boolean;
  [k: string]: unknown | undefined;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface FormatID1 {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_static', 'video_hosted', 'audio_standard'). When used alone, references a template format. When combined with dimension/duration fields, creates a parameterized format ID for a specific variant.
   */
  id: string;
  /**
   * Width in pixels for visual formats. When specified, height must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  width?: number;
  /**
   * Height in pixels for visual formats. When specified, width must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  height?: number;
  /**
   * Duration in milliseconds for time-based formats (video, audio). When specified, creates a parameterized format ID. Omit to reference a template format without parameters.
   */
  duration_ms?: number;
  [k: string]: unknown | undefined;
}
/**
 * Structured format identifier with agent URL and format name. Can reference: (1) a concrete format with fixed dimensions (id only), (2) a template format without parameters (id only), or (3) a template format with parameters (id + dimensions/duration). Template formats accept parameters in format_id while concrete formats have fixed dimensions in their definition. Parameterized format IDs create unique, specific format variants.
 */
export interface FormatID2 {
  /**
   * URL of the agent that defines this format (e.g., 'https://creatives.adcontextprotocol.org' for standard formats, or 'https://publisher.com/.well-known/adcp/sales' for custom formats)
   */
  agent_url: string;
  /**
   * Format identifier within the agent's namespace (e.g., 'display_static', 'video_hosted', 'audio_standard'). When used alone, references a template format. When combined with dimension/duration fields, creates a parameterized format ID for a specific variant.
   */
  id: string;
  /**
   * Width in pixels for visual formats. When specified, height must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  width?: number;
  /**
   * Height in pixels for visual formats. When specified, width must also be specified. Both fields together create a parameterized format ID for dimension-specific variants.
   */
  height?: number;
  /**
   * Duration in milliseconds for time-based formats (video, audio). When specified, creates a parameterized format ID. Omit to reference a template format without parameters.
   */
  duration_ms?: number;
  [k: string]: unknown | undefined;
}
/**
 * Extension object for platform-specific, vendor-namespaced parameters. Extensions are always optional and must be namespaced under a vendor/platform key (e.g., ext.gam, ext.roku). Used for custom capabilities, partner-specific configuration, and features being proposed for standardization.
 */
// TARGETING SCHEMA
/**
 * Metro area classification system (e.g., 'nielsen_dma', 'uk_itl2')
 */
// PROPERTY SCHEMA
/**
 * Unique identifier for this property (optional). Enables referencing properties by ID instead of repeating full objects.
 */
export type PropertyType =
  | 'website'
  | 'mobile_app'
  | 'ctv_app'
  | 'desktop_app'
  | 'dooh'
  | 'podcast'
  | 'radio'
  | 'streaming_audio';
/**
 * Type of identifier for this property
 */
export type PropertyIdentifierTypes =
  | 'domain'
  | 'subdomain'
  | 'network_id'
  | 'ios_bundle'
  | 'android_package'
  | 'apple_app_store_id'
  | 'google_play_id'
  | 'roku_store_id'
  | 'fire_tv_asin'
  | 'samsung_app_id'
  | 'apple_tv_bundle'
  | 'bundle_id'
  | 'venue_id'
  | 'screen_id'
  | 'openooh_venue_type'
  | 'rss_url'
  | 'apple_podcast_id'
  | 'spotify_show_id'
  | 'podcast_guid';
/**
 * Tag for categorizing publisher properties. Must be lowercase alphanumeric with underscores only.
 */
export interface Property {
  property_id?: PropertyID;
  property_type: PropertyType;
  /**
   * Human-readable property name
   */
  name: string;
  /**
   * Array of identifiers for this property
   */
  identifiers: {
    type: PropertyIdentifierTypes;
    /**
     * The identifier value. For domain type: 'example.com' matches base domain plus www and m subdomains; 'edition.example.com' matches that specific subdomain; '*.example.com' matches ALL subdomains but NOT base domain
     */
    value: string;
  }[];
  /**
   * Tags for categorization and grouping (e.g., network membership, content categories)
   */
  tags?: PropertyTag[];
  /**
   * Domain where adagents.json should be checked for authorization validation. Optional in adagents.json (file location implies domain).
   */
  publisher_domain?: string;
}

// MCP-WEBHOOK-PAYLOAD SCHEMA
/**
 * Type of AdCP operation that triggered this webhook. Enables webhook handlers to route to appropriate processing logic.
 */
export type TaskType =
  | 'create_media_buy'
  | 'update_media_buy'
  | 'sync_creatives'
  | 'activate_signal'
  | 'get_signals'
  | 'create_property_list'
  | 'update_property_list'
  | 'get_property_list'
  | 'list_property_lists'
  | 'delete_property_list';
/**
 * AdCP domain this task belongs to. Helps classify the operation type at a high level.
 */
export type AdCPDomain = 'media-buy' | 'signals' | 'governance' | 'creative';
/**
 * Current task status. Webhooks are triggered for status changes after initial submission.
 */
export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';
/**
 * Task-specific payload matching the status. For completed/failed, contains the full task response. For working/input-required/submitted, contains status-specific data. This is the data layer that AdCP specs - same structure used in A2A status.message.parts[].data.
 */
export type AdCPAsyncResponseData =
  | GetProductsResponse
  | GetProductsAsyncWorking
  | GetProductsAsyncInputRequired
  | GetProductsAsyncSubmitted
  | CreateMediaBuyResponse
  | CreateMediaBuyAsyncWorking
  | CreateMediaBuyAsyncInputRequired
  | CreateMediaBuyAsyncSubmitted
  | UpdateMediaBuyResponse
  | UpdateMediaBuyAsyncWorking
  | UpdateMediaBuyAsyncInputRequired
  | UpdateMediaBuyAsyncSubmitted
  | SyncCreativesResponse
  | SyncCreativesAsyncWorking
  | SyncCreativesAsyncInputRequired
  | SyncCreativesAsyncSubmitted;
/**
 * Selects properties from a publisher's adagents.json. Used for both product definitions and agent authorization. Supports three selection patterns: all properties, specific IDs, or by tags.
 */
export type CreateMediaBuyResponse = CreateMediaBuySuccess | CreateMediaBuyError;
/**
 * Budget pacing strategy
 */
export type UpdateMediaBuyResponse = UpdateMediaBuySuccess | UpdateMediaBuyError;
/**
 * Response for completed or failed sync_creatives
 */
export type SyncCreativesResponse = SyncCreativesSuccess | SyncCreativesError;
/**
 * Action taken for this creative
 */
export type CreativeAction = 'created' | 'updated' | 'unchanged' | 'failed' | 'deleted';

/**
 * Standard envelope for HTTP-based push notifications (MCP). This defines the wire format sent to the URL configured in `pushNotificationConfig`. NOTE: This envelope is NOT used in A2A integration, which uses native Task/TaskStatusUpdateEvent messages with the AdCP payload nested in `status.message.parts[].data`.
 */
export interface MCPWebhookPayload {
  /**
   * Publisher-defined operation identifier correlating a sequence of task updates across webhooks.
   */
  operation_id?: string;
  /**
   * Unique identifier for this task. Use this to correlate webhook notifications with the original task submission.
   */
  task_id: string;
  task_type: TaskType;
  domain?: AdCPDomain;
  status: TaskStatus;
  /**
   * ISO 8601 timestamp when this webhook was generated.
   */
  timestamp: string;
  /**
   * Human-readable summary of the current task state. Provides context about what happened and what action may be needed.
   */
  message?: string;
  /**
   * Session/conversation identifier. Use this to continue the conversation if input-required status needs clarification or additional parameters.
   */
  context_id?: string;
  result?: AdCPAsyncResponseData;
}
/**
 * Response for completed or failed get_products
 */
export interface GetProductsResponse {
  /**
   * Array of matching products
   */
  products: Product[];
  /**
   * Optional array of proposed media plans with budget allocations across products. Publishers include proposals when they can provide strategic guidance based on the brief. Proposals are actionable - buyers can refine them via subsequent get_products calls or execute them directly via create_media_buy.
   */
  proposals?: Proposal[];
  /**
   * Task-specific errors and warnings (e.g., product filtering issues)
   */
  errors?: Error[];
  /**
   * [AdCP 3.0] Indicates whether property_list filtering was applied. True if the agent filtered products based on the provided property_list. Absent or false if property_list was not provided or not supported by this agent.
   */
  property_list_applied?: boolean;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Represents available advertising inventory
 */
export interface Proposal {
  /**
   * Unique identifier for this proposal. Used to refine the proposal in subsequent get_products calls or to execute it via create_media_buy.
   */
  proposal_id: string;
  /**
   * Human-readable name for this media plan proposal
   */
  name: string;
  /**
   * Explanation of the proposal strategy and what it achieves
   */
  description?: string;
  /**
   * Budget allocations across products. Allocation percentages MUST sum to 100. Publishers are responsible for ensuring the sum equals 100; buyers SHOULD validate this before execution.
   *
   * @minItems 1
   */
  allocations: [ProductAllocation, ...ProductAllocation[]];
  /**
   * When this proposal expires and can no longer be executed. After expiration, referenced products or pricing may no longer be available.
   */
  expires_at?: string;
  /**
   * Optional budget guidance for this proposal
   */
  total_budget_guidance?: {
    /**
     * Minimum recommended budget
     */
    min?: number;
    /**
     * Recommended budget for optimal performance
     */
    recommended?: number;
    /**
     * Maximum budget before diminishing returns
     */
    max?: number;
    /**
     * ISO 4217 currency code
     */
    currency?: string;
    [k: string]: unknown | undefined;
  };
  /**
   * Explanation of how this proposal aligns with the campaign brief
   */
  brief_alignment?: string;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * A budget allocation for a specific product within a proposal. Percentages across all allocations in a proposal should sum to 100.
 */
export interface ProductAllocation {
  /**
   * ID of the product (must reference a product in the products array)
   */
  product_id: string;
  /**
   * Percentage of total budget allocated to this product (0-100)
   */
  allocation_percentage: number;
  /**
   * Recommended pricing option ID from the product's pricing_options array
   */
  pricing_option_id?: string;
  /**
   * Explanation of why this product and allocation are recommended
   */
  rationale?: string;
  /**
   * Optional ordering hint for multi-line-item plans (1-based)
   */
  sequence?: number;
  /**
   * Categorical tags for this allocation (e.g., 'desktop', 'german', 'mobile') - useful for grouping/filtering allocations by dimension
   */
  tags?: string[];
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Standard error structure for task-specific errors and warnings
 */
export interface Error {
  /**
   * Error code for programmatic handling
   */
  code: string;
  /**
   * Human-readable error message
   */
  message: string;
  /**
   * Field path associated with the error (e.g., 'packages[0].targeting')
   */
  field?: string;
  /**
   * Suggested fix for the error
   */
  suggestion?: string;
  /**
   * Seconds to wait before retrying the operation
   */
  retry_after?: number;
  /**
   * Additional task-specific error details
   */
  details?: {
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
/**
 * Opaque correlation data that is echoed unchanged in responses. Used for internal tracking, UI session IDs, trace IDs, and other caller-specific identifiers that don't affect protocol behavior. Context data is never parsed by AdCP agents - it's simply preserved and returned.
 */
export interface ContextObject {
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working get_products
 */
export interface GetProductsAsyncWorking {
  /**
   * Progress percentage of the search operation
   */
  percentage?: number;
  /**
   * Current step in the search process (e.g., 'searching_inventory', 'validating_availability')
   */
  current_step?: string;
  /**
   * Total number of steps in the search process
   */
  total_steps?: number;
  /**
   * Current step number (1-indexed)
   */
  step_number?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for get_products needing clarification
 */
export interface GetProductsAsyncInputRequired {
  /**
   * Reason code indicating why input is needed
   */
  reason?: 'CLARIFICATION_NEEDED' | 'BUDGET_REQUIRED';
  /**
   * Partial product results that may help inform the clarification
   */
  partial_results?: Product[];
  /**
   * Suggested values or options for the required input
   */
  suggestions?: string[];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted get_products (custom curation)
 */
export interface GetProductsAsyncSubmitted {
  /**
   * Estimated completion time for the search
   */
  estimated_completion?: string;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Success response - media buy created successfully
 */
export interface CreateMediaBuySuccess {
  /**
   * Publisher's unique identifier for the created media buy
   */
  media_buy_id: string;
  /**
   * Buyer's reference identifier for this media buy
   */
  buyer_ref: string;
  account?: Account;
  /**
   * ISO 8601 timestamp for creative upload deadline
   */
  creative_deadline?: string;
  /**
   * Array of created packages with complete state information
   */
  packages: Package[];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Account billed for this media buy. Includes advertiser, billing proxy (if any), and rate card applied.
 */
export interface CreateMediaBuyError {
  /**
   * Array of errors explaining why the operation failed
   *
   * @minItems 1
   */
  errors: [Error, ...Error[]];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working create_media_buy
 */
export interface CreateMediaBuyAsyncWorking {
  /**
   * Completion percentage (0-100)
   */
  percentage?: number;
  /**
   * Current step or phase of the operation
   */
  current_step?: string;
  /**
   * Total number of steps in the operation
   */
  total_steps?: number;
  /**
   * Current step number
   */
  step_number?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for create_media_buy needing user input
 */
export interface CreateMediaBuyAsyncInputRequired {
  /**
   * Reason code indicating why input is needed
   */
  reason?: 'APPROVAL_REQUIRED' | 'BUDGET_EXCEEDS_LIMIT';
  /**
   * Optional validation errors or warnings for debugging purposes. Helps explain why input is required.
   */
  errors?: Error[];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted create_media_buy
 */
export interface CreateMediaBuyAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Success response - media buy updated successfully
 */
export interface UpdateMediaBuySuccess {
  /**
   * Publisher's identifier for the media buy
   */
  media_buy_id: string;
  /**
   * Buyer's reference identifier for the media buy
   */
  buyer_ref: string;
  /**
   * ISO 8601 timestamp when changes take effect (null if pending approval)
   */
  implementation_date?: string | null;
  /**
   * Array of packages that were modified with complete state information
   */
  affected_packages?: Package[];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Error response - operation failed, no changes applied
 */
export interface UpdateMediaBuyError {
  /**
   * Array of errors explaining why the operation failed
   *
   * @minItems 1
   */
  errors: [Error, ...Error[]];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working update_media_buy
 */
export interface UpdateMediaBuyAsyncWorking {
  /**
   * Completion percentage (0-100)
   */
  percentage?: number;
  /**
   * Current step or phase of the operation
   */
  current_step?: string;
  /**
   * Total number of steps in the operation
   */
  total_steps?: number;
  /**
   * Current step number
   */
  step_number?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for update_media_buy needing user input
 */
export interface UpdateMediaBuyAsyncInputRequired {
  /**
   * Reason code indicating why input is needed
   */
  reason?: 'APPROVAL_REQUIRED' | 'CHANGE_CONFIRMATION';
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted update_media_buy
 */
export interface UpdateMediaBuyAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Success response - sync operation processed creatives (may include per-item failures)
 */
export interface SyncCreativesSuccess {
  /**
   * Whether this was a dry run (no actual changes made)
   */
  dry_run?: boolean;
  /**
   * Results for each creative processed. Items with action='failed' indicate per-item validation/processing failures, not operation-level failures.
   */
  creatives: {
    /**
     * Creative ID from the request
     */
    creative_id: string;
    account?: Account1;
    action: CreativeAction;
    /**
     * Platform-specific ID assigned to the creative
     */
    platform_id?: string;
    /**
     * Field names that were modified (only present when action='updated')
     */
    changes?: string[];
    /**
     * Validation or processing errors (only present when action='failed')
     */
    errors?: string[];
    /**
     * Non-fatal warnings about this creative
     */
    warnings?: string[];
    /**
     * Preview URL for generative creatives (only present for generative formats)
     */
    preview_url?: string;
    /**
     * ISO 8601 timestamp when preview link expires (only present when preview_url exists)
     */
    expires_at?: string;
    /**
     * Package IDs this creative was successfully assigned to (only present when assignments were requested)
     */
    assigned_to?: string[];
    /**
     * Assignment errors by package ID (only present when assignment failures occurred)
     */
    assignment_errors?: {
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  }[];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Account that owns this creative
 */
export interface Account1 {
  /**
   * Unique identifier for this account
   */
  account_id: string;
  /**
   * Human-readable account name (e.g., 'Coke', 'Coke c/o Publicis')
   */
  name: string;
  /**
   * The advertiser whose rates apply to this account
   */
  advertiser?: string;
  /**
   * Optional intermediary who receives invoices on behalf of the advertiser (e.g., agency)
   */
  billing_proxy?: string;
  /**
   * Account status
   */
  status: 'active' | 'suspended' | 'closed';
  /**
   * Identifier for the rate card applied to this account
   */
  rate_card?: string;
  /**
   * Payment terms (e.g., 'net_30', 'prepay')
   */
  payment_terms?: string;
  /**
   * Maximum outstanding balance allowed
   */
  credit_limit?: {
    amount: number;
    currency: string;
  };
  ext?: ExtensionObject;
}
/**
 * Error response - operation failed completely, no creatives were processed
 */
export interface SyncCreativesError {
  /**
   * Operation-level errors that prevented processing any creatives (e.g., authentication failure, service unavailable, invalid request format)
   *
   * @minItems 1
   */
  errors: [Error, ...Error[]];
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Progress data for working sync_creatives
 */
export interface SyncCreativesAsyncWorking {
  /**
   * Completion percentage (0-100)
   */
  percentage?: number;
  /**
   * Current step or phase of the operation
   */
  current_step?: string;
  /**
   * Total number of steps in the operation
   */
  total_steps?: number;
  /**
   * Current step number
   */
  step_number?: number;
  /**
   * Number of creatives processed so far
   */
  creatives_processed?: number;
  /**
   * Total number of creatives to process
   */
  creatives_total?: number;
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Input requirements for sync_creatives needing user input
 */
export interface SyncCreativesAsyncInputRequired {
  /**
   * Reason code indicating why buyer input is needed
   */
  reason?: 'APPROVAL_REQUIRED' | 'ASSET_CONFIRMATION' | 'FORMAT_CLARIFICATION';
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}
/**
 * Acknowledgment for submitted sync_creatives
 */
export interface SyncCreativesAsyncSubmitted {
  context?: ContextObject;
  ext?: ExtensionObject;
  [k: string]: unknown | undefined;
}

