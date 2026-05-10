// Typed factory helpers for format asset slots. Companion to
// `asset-builders.ts` (which builds creative INSTANCES). These build the slot
// definitions inside `Format.assets[]` — what a publisher declares it accepts.
//
// Each helper injects `item_type: 'individual'` plus the per-asset-type
// `asset_type` discriminator so callers only supply the meaningful fields.
// The slot's `requirements` object is strictly typed per asset type — misnamed
// fields like `file_types` or wrong units like `min_duration_seconds` become
// compile-time errors at the authorship site.

import type {
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
} from '../types/tools.generated';

type IndividualFields<T> = Omit<T, 'item_type' | 'asset_type'>;
type GroupFields<T> = Omit<T, 'asset_type'>;

// ---------- Individual asset slot builders ----------

export function imageAssetSlot(fields: IndividualFields<IndividualImageAsset>): IndividualImageAsset {
  return { ...fields, item_type: 'individual', asset_type: 'image' };
}

export function videoAssetSlot(fields: IndividualFields<IndividualVideoAsset>): IndividualVideoAsset {
  return { ...fields, item_type: 'individual', asset_type: 'video' };
}

export function audioAssetSlot(fields: IndividualFields<IndividualAudioAsset>): IndividualAudioAsset {
  return { ...fields, item_type: 'individual', asset_type: 'audio' };
}

export function textAssetSlot(fields: IndividualFields<IndividualTextAsset>): IndividualTextAsset {
  return { ...fields, item_type: 'individual', asset_type: 'text' };
}

export function markdownAssetSlot(fields: IndividualFields<IndividualMarkdownAsset>): IndividualMarkdownAsset {
  return { ...fields, item_type: 'individual', asset_type: 'markdown' };
}

export function htmlAssetSlot(fields: IndividualFields<IndividualHtmlAsset>): IndividualHtmlAsset {
  return { ...fields, item_type: 'individual', asset_type: 'html' };
}

export function cssAssetSlot(fields: IndividualFields<IndividualCssAsset>): IndividualCssAsset {
  return { ...fields, item_type: 'individual', asset_type: 'css' };
}

export function javascriptAssetSlot(fields: IndividualFields<IndividualJavaScriptAsset>): IndividualJavaScriptAsset {
  return { ...fields, item_type: 'individual', asset_type: 'javascript' };
}

export function vastAssetSlot(fields: IndividualFields<IndividualVastAsset>): IndividualVastAsset {
  return { ...fields, item_type: 'individual', asset_type: 'vast' };
}

export function daastAssetSlot(fields: IndividualFields<IndividualDaastAsset>): IndividualDaastAsset {
  return { ...fields, item_type: 'individual', asset_type: 'daast' };
}

export function urlAssetSlot(fields: IndividualFields<IndividualUrlAsset>): IndividualUrlAsset {
  return { ...fields, item_type: 'individual', asset_type: 'url' };
}

export function webhookAssetSlot(fields: IndividualFields<IndividualWebhookAsset>): IndividualWebhookAsset {
  return { ...fields, item_type: 'individual', asset_type: 'webhook' };
}

export function briefAssetSlot(fields: IndividualFields<IndividualBriefAsset>): IndividualBriefAsset {
  return { ...fields, item_type: 'individual', asset_type: 'brief' };
}

export function catalogAssetSlot(fields: IndividualFields<IndividualCatalogAsset>): IndividualCatalogAsset {
  return { ...fields, item_type: 'individual', asset_type: 'catalog' };
}

// ---------- Group asset slot builders (for use inside repeatableGroup) ----------

export function imageGroupAsset(fields: GroupFields<GroupImageAsset>): GroupImageAsset {
  return { ...fields, asset_type: 'image' };
}
export function videoGroupAsset(fields: GroupFields<GroupVideoAsset>): GroupVideoAsset {
  return { ...fields, asset_type: 'video' };
}
export function audioGroupAsset(fields: GroupFields<GroupAudioAsset>): GroupAudioAsset {
  return { ...fields, asset_type: 'audio' };
}
export function textGroupAsset(fields: GroupFields<GroupTextAsset>): GroupTextAsset {
  return { ...fields, asset_type: 'text' };
}
export function markdownGroupAsset(fields: GroupFields<GroupMarkdownAsset>): GroupMarkdownAsset {
  return { ...fields, asset_type: 'markdown' };
}
export function htmlGroupAsset(fields: GroupFields<GroupHtmlAsset>): GroupHtmlAsset {
  return { ...fields, asset_type: 'html' };
}
export function cssGroupAsset(fields: GroupFields<GroupCssAsset>): GroupCssAsset {
  return { ...fields, asset_type: 'css' };
}
export function javascriptGroupAsset(fields: GroupFields<GroupJavaScriptAsset>): GroupJavaScriptAsset {
  return { ...fields, asset_type: 'javascript' };
}
export function vastGroupAsset(fields: GroupFields<GroupVastAsset>): GroupVastAsset {
  return { ...fields, asset_type: 'vast' };
}
export function daastGroupAsset(fields: GroupFields<GroupDaastAsset>): GroupDaastAsset {
  return { ...fields, asset_type: 'daast' };
}
export function urlGroupAsset(fields: GroupFields<GroupUrlAsset>): GroupUrlAsset {
  return { ...fields, asset_type: 'url' };
}
export function webhookGroupAsset(fields: GroupFields<GroupWebhookAsset>): GroupWebhookAsset {
  return { ...fields, asset_type: 'webhook' };
}

// ---------- Repeatable group builder ----------

/**
 * Wrap asset slots in a `repeatable_group` — the correct home for
 * `min_count` / `max_count`. Use for carousels, collections, story-pin
 * frames, product showcases. The platform repeats the inner `assets` once
 * per item; each repetition must provide all required assets within it.
 */
export function repeatableGroup(fields: Omit<RepeatableGroupAsset, 'item_type'>): RepeatableGroupAsset {
  return { ...fields, item_type: 'repeatable_group' };
}

/**
 * Grouped accessor for format-slot builders. `FormatAsset.image({...})`
 * reads well in format declarations. The individual named exports remain
 * the primary entry points.
 */
export const FormatAsset = {
  image: imageAssetSlot,
  video: videoAssetSlot,
  audio: audioAssetSlot,
  text: textAssetSlot,
  markdown: markdownAssetSlot,
  html: htmlAssetSlot,
  css: cssAssetSlot,
  javascript: javascriptAssetSlot,
  vast: vastAssetSlot,
  daast: daastAssetSlot,
  url: urlAssetSlot,
  webhook: webhookAssetSlot,
  brief: briefAssetSlot,
  catalog: catalogAssetSlot,
  group: repeatableGroup,
  groupImage: imageGroupAsset,
  groupVideo: videoGroupAsset,
  groupAudio: audioGroupAsset,
  groupText: textGroupAsset,
  groupMarkdown: markdownGroupAsset,
  groupHtml: htmlGroupAsset,
  groupCss: cssGroupAsset,
  groupJavascript: javascriptGroupAsset,
  groupVast: vastGroupAsset,
  groupDaast: daastGroupAsset,
  groupUrl: urlGroupAsset,
  groupWebhook: webhookGroupAsset,
} as const;
