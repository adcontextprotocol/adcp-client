// Typed factory helpers for format asset slots. Companion to
// `asset-builders.ts` (which builds creative INSTANCES). These build the slot
// definitions inside `Format.assets[]` — what a publisher declares it accepts.
//
// Each helper injects `item_type: 'individual'` plus the per-asset-type
// `asset_type` discriminator so callers only supply the meaningful fields.
// The slot's `requirements` object is strictly typed per asset type — misnamed
// fields like `file_types` or wrong units like `min_duration_seconds` become
// compile-time errors, and the Zod schemas catch runtime drift (e.g.
// comma-joined aspect ratios) at validation time.

import type {
  GroupAudioAssetSlot,
  GroupBriefAssetSlot,
  GroupCatalogAssetSlot,
  GroupCssAssetSlot,
  GroupDaastAssetSlot,
  GroupHtmlAssetSlot,
  GroupImageAssetSlot,
  GroupJavascriptAssetSlot,
  GroupMarkdownAssetSlot,
  GroupTextAssetSlot,
  GroupUrlAssetSlot,
  GroupVastAssetSlot,
  GroupVideoAssetSlot,
  GroupWebhookAssetSlot,
  IndividualAudioAssetSlot,
  IndividualBriefAssetSlot,
  IndividualCatalogAssetSlot,
  IndividualCssAssetSlot,
  IndividualDaastAssetSlot,
  IndividualHtmlAssetSlot,
  IndividualImageAssetSlot,
  IndividualJavascriptAssetSlot,
  IndividualMarkdownAssetSlot,
  IndividualTextAssetSlot,
  IndividualUrlAssetSlot,
  IndividualVastAssetSlot,
  IndividualVideoAssetSlot,
  IndividualWebhookAssetSlot,
  RepeatableGroupSlot,
} from '../types/format-asset-slots';

type IndividualFields<T> = Omit<T, 'item_type' | 'asset_type'>;
type GroupFields<T> = Omit<T, 'asset_type'>;

// ---------- Individual asset slot builders ----------

export function imageAssetSlot(fields: IndividualFields<IndividualImageAssetSlot>): IndividualImageAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'image' };
}

export function videoAssetSlot(fields: IndividualFields<IndividualVideoAssetSlot>): IndividualVideoAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'video' };
}

export function audioAssetSlot(fields: IndividualFields<IndividualAudioAssetSlot>): IndividualAudioAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'audio' };
}

export function textAssetSlot(fields: IndividualFields<IndividualTextAssetSlot>): IndividualTextAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'text' };
}

export function markdownAssetSlot(
  fields: IndividualFields<IndividualMarkdownAssetSlot>,
): IndividualMarkdownAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'markdown' };
}

export function htmlAssetSlot(fields: IndividualFields<IndividualHtmlAssetSlot>): IndividualHtmlAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'html' };
}

export function cssAssetSlot(fields: IndividualFields<IndividualCssAssetSlot>): IndividualCssAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'css' };
}

export function javascriptAssetSlot(
  fields: IndividualFields<IndividualJavascriptAssetSlot>,
): IndividualJavascriptAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'javascript' };
}

export function vastAssetSlot(fields: IndividualFields<IndividualVastAssetSlot>): IndividualVastAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'vast' };
}

export function daastAssetSlot(fields: IndividualFields<IndividualDaastAssetSlot>): IndividualDaastAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'daast' };
}

export function urlAssetSlot(fields: IndividualFields<IndividualUrlAssetSlot>): IndividualUrlAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'url' };
}

export function webhookAssetSlot(
  fields: IndividualFields<IndividualWebhookAssetSlot>,
): IndividualWebhookAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'webhook' };
}

export function briefAssetSlot(fields: IndividualFields<IndividualBriefAssetSlot>): IndividualBriefAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'brief' };
}

export function catalogAssetSlot(
  fields: IndividualFields<IndividualCatalogAssetSlot>,
): IndividualCatalogAssetSlot {
  return { ...fields, item_type: 'individual', asset_type: 'catalog' };
}

// ---------- Group asset slot builders (for use inside repeatableGroup) ----------

export function imageGroupAsset(fields: GroupFields<GroupImageAssetSlot>): GroupImageAssetSlot {
  return { ...fields, asset_type: 'image' };
}
export function videoGroupAsset(fields: GroupFields<GroupVideoAssetSlot>): GroupVideoAssetSlot {
  return { ...fields, asset_type: 'video' };
}
export function audioGroupAsset(fields: GroupFields<GroupAudioAssetSlot>): GroupAudioAssetSlot {
  return { ...fields, asset_type: 'audio' };
}
export function textGroupAsset(fields: GroupFields<GroupTextAssetSlot>): GroupTextAssetSlot {
  return { ...fields, asset_type: 'text' };
}
export function markdownGroupAsset(fields: GroupFields<GroupMarkdownAssetSlot>): GroupMarkdownAssetSlot {
  return { ...fields, asset_type: 'markdown' };
}
export function htmlGroupAsset(fields: GroupFields<GroupHtmlAssetSlot>): GroupHtmlAssetSlot {
  return { ...fields, asset_type: 'html' };
}
export function cssGroupAsset(fields: GroupFields<GroupCssAssetSlot>): GroupCssAssetSlot {
  return { ...fields, asset_type: 'css' };
}
export function javascriptGroupAsset(fields: GroupFields<GroupJavascriptAssetSlot>): GroupJavascriptAssetSlot {
  return { ...fields, asset_type: 'javascript' };
}
export function vastGroupAsset(fields: GroupFields<GroupVastAssetSlot>): GroupVastAssetSlot {
  return { ...fields, asset_type: 'vast' };
}
export function daastGroupAsset(fields: GroupFields<GroupDaastAssetSlot>): GroupDaastAssetSlot {
  return { ...fields, asset_type: 'daast' };
}
export function urlGroupAsset(fields: GroupFields<GroupUrlAssetSlot>): GroupUrlAssetSlot {
  return { ...fields, asset_type: 'url' };
}
export function webhookGroupAsset(fields: GroupFields<GroupWebhookAssetSlot>): GroupWebhookAssetSlot {
  return { ...fields, asset_type: 'webhook' };
}
export function briefGroupAsset(fields: GroupFields<GroupBriefAssetSlot>): GroupBriefAssetSlot {
  return { ...fields, asset_type: 'brief' };
}
export function catalogGroupAsset(fields: GroupFields<GroupCatalogAssetSlot>): GroupCatalogAssetSlot {
  return { ...fields, asset_type: 'catalog' };
}

// ---------- Repeatable group builder ----------

/**
 * Wrap asset slots in a `repeatable_group` — the correct home for
 * `min_count` / `max_count`. Use for carousels, collections, story-pin
 * frames, product showcases. The platform repeats the inner `assets` once
 * per item; each repetition must provide all required assets within it.
 */
export function repeatableGroup(
  fields: Omit<RepeatableGroupSlot, 'item_type'>,
): RepeatableGroupSlot {
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
  groupBrief: briefGroupAsset,
  groupCatalog: catalogGroupAsset,
} as const;
