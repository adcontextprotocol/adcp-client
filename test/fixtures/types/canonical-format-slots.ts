import type {
  CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement,
  CanonicalFormatBase,
  CanonicalFormatDAASTAudio,
  CanonicalFormatDisplayTag,
  CanonicalFormatHostedAudio,
  CanonicalFormatHostedVideo,
  CanonicalFormatHTML5Banner,
  CanonicalFormatImageCarousel,
  CanonicalFormatNativeInFeed,
  CanonicalFormatResponsiveCreative,
  CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven,
  CanonicalFormatVASTVideo,
} from '../../../src/lib/types/core.generated';

const slots = [{ asset_group_id: 'audio_main', asset_type: 'audio' as const, required: true }] satisfies NonNullable<
  CanonicalFormatBase['slots']
>;

const assignments: [
  Pick<CanonicalFormatDisplayTag, 'slots'>,
  Pick<CanonicalFormatImageCarousel, 'slots'>,
  Pick<CanonicalFormatHostedVideo, 'slots'>,
  Pick<CanonicalFormatVASTVideo, 'slots'>,
  Pick<CanonicalFormatHostedAudio, 'slots'>,
  Pick<CanonicalFormatDAASTAudio, 'slots'>,
  Pick<CanonicalFormatSponsoredPlacementRetailMediaCatalogDriven, 'slots'>,
  Pick<CanonicalFormatNativeInFeed, 'slots'>,
  Pick<CanonicalFormatResponsiveCreative, 'slots'>,
  Pick<CanonicalFormatAgentPlacementAISurfaceSponsoredPlacement, 'slots'>,
  Pick<CanonicalFormatHTML5Banner, 'slots'>,
] = [
  { slots },
  { slots },
  { slots },
  { slots },
  { slots },
  { slots },
  { slots },
  { slots },
  { slots },
  { slots },
  { slots },
];

void assignments;
