import type {
  CatalogItemDeliveryMetrics,
  GeoDeliveryMetrics,
  KeywordDeliveryMetrics,
  PostalCountrySystem,
  TasksGetResponse,
} from '../lib/types/core.generated';
import type {
  CatalogItemDeliveryMetrics as ToolCatalogItemDeliveryMetrics,
  GeoDeliveryMetrics as ToolGeoDeliveryMetrics,
  GetMediaBuyDeliveryCatalogItemMetrics,
  GetMediaBuyDeliveryGeoMetrics,
  GetMediaBuyDeliveryKeywordMetrics,
  KeywordDeliveryMetrics as ToolKeywordDeliveryMetrics,
} from '../lib/types/tools.generated';

type Assert<T extends true> = T;
type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

// Canonical core types must preserve every required property declared by their
// source JSON Schema. Compatibility widening belongs on tool-specific response
// shapes and must not leak into these shared types through codegen de-duplication.
type _GeoLevelIsRequired = Assert<IsRequired<GeoDeliveryMetrics, 'geo_level'>>;
type _GeoCodeIsRequired = Assert<IsRequired<GeoDeliveryMetrics, 'geo_code'>>;
type _KeywordIsRequired = Assert<IsRequired<KeywordDeliveryMetrics, 'keyword'>>;
type _MatchTypeIsRequired = Assert<IsRequired<KeywordDeliveryMetrics, 'match_type'>>;
type _ContentIdIsRequired = Assert<IsRequired<CatalogItemDeliveryMetrics, 'content_id'>>;
type _PostalCountryIsRequired = Assert<IsRequired<PostalCountrySystem, 'country'>>;
type _PostalSystemIsRequired = Assert<IsRequired<PostalCountrySystem, 'system'>>;
type _TaskProtocolIsRequired = Assert<IsRequired<TasksGetResponse, 'protocol'>>;

// The published @adcp/sdk/types/tools.generated deep import historically
// exported these canonical names. Keep them as strict core re-exports.
type _ToolCatalogContentIdIsRequired = Assert<IsRequired<ToolCatalogItemDeliveryMetrics, 'content_id'>>;
type _ToolKeywordIsRequired = Assert<IsRequired<ToolKeywordDeliveryMetrics, 'keyword'>>;
type _ToolMatchTypeIsRequired = Assert<IsRequired<ToolKeywordDeliveryMetrics, 'match_type'>>;
type _ToolGeoLevelIsRequired = Assert<IsRequired<ToolGeoDeliveryMetrics, 'geo_level'>>;
type _ToolGeoCodeIsRequired = Assert<IsRequired<ToolGeoDeliveryMetrics, 'geo_code'>>;

// Buyer-side tool responses retain tolerance for legacy sellers that predate
// the v3 breakdown identifiers. These aliases must stay distinct from the
// strict canonical authoring types above.
type _CompatContentIdIsOptional = Assert<IsOptional<GetMediaBuyDeliveryCatalogItemMetrics, 'content_id'>>;
type _CompatKeywordIsOptional = Assert<IsOptional<GetMediaBuyDeliveryKeywordMetrics, 'keyword'>>;
type _CompatMatchTypeIsOptional = Assert<IsOptional<GetMediaBuyDeliveryKeywordMetrics, 'match_type'>>;
type _CompatGeoLevelIsOptional = Assert<IsOptional<GetMediaBuyDeliveryGeoMetrics, 'geo_level'>>;
type _CompatGeoCodeIsOptional = Assert<IsOptional<GetMediaBuyDeliveryGeoMetrics, 'geo_code'>>;
