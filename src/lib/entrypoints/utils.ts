// `@adcp/sdk/utils`: runtime helpers a buyer reaches for alongside a client —
// JSON canonicalization, media-buy status helpers, response unwrapping,
// capability parsing and the `*_TOOLS` tool lists, and the brand-manifest
// compatibility converters — without loading the package root.
//
// Every name here is exported by `@adcp/sdk` under the same name, from the same
// source module. Add a name here only when the root exports it under the same
// name (`test/lib/runtime-subpaths.test.js` enforces this).

// RFC 8785 JSON canonicalization.
export { canonicalize, canonicalJsonSha256 } from '../utils/jcs';

// Media-buy status.
export { getAuthoritativeMediaBuyStatus, isMediaBuyStatus } from '../utils/media-buy-status';

// Response unwrapping and classification.
export {
  unwrapProtocolResponse,
  isAdcpError,
  isAdcpSuccess,
  isTerminalAdcpError,
  hasAdvisorySuccessPayload,
} from '../utils/response-unwrapper';

// Capabilities detection and version negotiation.
export {
  buildSyntheticV3Capabilities,
  parseCapabilitiesResponse,
  supportsV3,
  supportsProtocol,
  supportsPropertyListFiltering,
  supportsContentStandards,
  supportsSyncCreatives,
  supportsBuyingMode,
  requiresOperatorAuth,
  requiresAccountForProducts,
  supportsSandbox,
  supportsExperimentalFeature,
  resolveFeature,
  listDeclaredFeatures,
  MEDIA_BUY_TOOLS,
  SIGNALS_TOOLS,
  GOVERNANCE_TOOLS,
  CREATIVE_TOOLS,
  EVENT_TRACKING_TOOLS,
  ACCOUNT_TOOLS,
  PROTOCOL_TOOLS,
  BRAND_RIGHTS_TOOLS,
  TASK_FEATURE_MAP,
} from '../utils/capabilities';
export type {
  AdcpCapabilities,
  AdcpMajorVersion,
  AdcpProtocol,
  AccountCapabilities,
  BuyingMode,
  MediaBuyFeatures,
  ToolInfo,
  FeatureName,
  IdempotencyCapabilities,
} from '../utils/capabilities';

// Deprecated brand-manifest / promoted-offerings converters.
export type {
  BrandManifest,
  BrandManifestReference,
  AssetContentType,
  PromotedProducts,
  PromotedOfferings,
  Measurement,
} from '../types/compat';
export { brandManifestToBrandReference, promotedProductsToCatalog, promotedOfferingsToCatalog } from '../types/compat';
