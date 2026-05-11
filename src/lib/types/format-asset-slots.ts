// Backwards-compatible aliases for the format asset slot types. The strict
// per-asset-type slot shapes (with `asset_type` discriminator + per-type
// `requirements`) are now produced by the codegen post-processor in
// scripts/generate-types.ts and live in tools.generated.ts. These aliases
// keep the prior `*Slot`-suffixed names working for downstream consumers.

import type {
  BaseGroupAsset,
  BaseIndividualAsset,
  GroupAudioAsset,
  GroupCssAsset,
  GroupDaastAsset,
  GroupHtmlAsset,
  GroupImageAsset,
  GroupJavaScriptAsset,
  GroupMarkdownAsset,
  GroupTextAsset,
  GroupUrlAsset,
  GroupVastAsset,
  GroupVideoAsset,
  GroupWebhookAsset,
  IndividualAudioAsset,
  IndividualBriefAsset,
  IndividualCatalogAsset,
  IndividualCssAsset,
  IndividualDaastAsset,
  IndividualHtmlAsset,
  IndividualImageAsset,
  IndividualJavaScriptAsset,
  IndividualMarkdownAsset,
  IndividualTextAsset,
  IndividualUrlAsset,
  IndividualVastAsset,
  IndividualVideoAsset,
  IndividualWebhookAsset,
  RepeatableGroupAsset,
} from './tools.generated';

// Re-export the codegen-produced slot unions so consumers importing from
// `@adcp/sdk` continue to find them under the same names.
export type { FormatAssetSlot, GroupAssetSlot, IndividualAssetSlot } from './tools.generated';

export type BaseIndividualAssetSlot = BaseIndividualAsset;
export type BaseGroupAssetSlot = BaseGroupAsset;

export type IndividualImageAssetSlot = IndividualImageAsset;
export type IndividualVideoAssetSlot = IndividualVideoAsset;
export type IndividualAudioAssetSlot = IndividualAudioAsset;
export type IndividualTextAssetSlot = IndividualTextAsset;
export type IndividualMarkdownAssetSlot = IndividualMarkdownAsset;
export type IndividualHtmlAssetSlot = IndividualHtmlAsset;
export type IndividualCssAssetSlot = IndividualCssAsset;
export type IndividualJavascriptAssetSlot = IndividualJavaScriptAsset;
export type IndividualVastAssetSlot = IndividualVastAsset;
export type IndividualDaastAssetSlot = IndividualDaastAsset;
export type IndividualUrlAssetSlot = IndividualUrlAsset;
export type IndividualWebhookAssetSlot = IndividualWebhookAsset;
export type IndividualBriefAssetSlot = IndividualBriefAsset;
export type IndividualCatalogAssetSlot = IndividualCatalogAsset;

export type GroupImageAssetSlot = GroupImageAsset;
export type GroupVideoAssetSlot = GroupVideoAsset;
export type GroupAudioAssetSlot = GroupAudioAsset;
export type GroupTextAssetSlot = GroupTextAsset;
export type GroupMarkdownAssetSlot = GroupMarkdownAsset;
export type GroupHtmlAssetSlot = GroupHtmlAsset;
export type GroupCssAssetSlot = GroupCssAsset;
export type GroupJavascriptAssetSlot = GroupJavaScriptAsset;
export type GroupVastAssetSlot = GroupVastAsset;
export type GroupDaastAssetSlot = GroupDaastAsset;
export type GroupUrlAssetSlot = GroupUrlAsset;
export type GroupWebhookAssetSlot = GroupWebhookAsset;

export type RepeatableGroupSlot = RepeatableGroupAsset;
