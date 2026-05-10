// Hand-authored Zod v4 schemas for format asset slot shapes.
//
// Companion to `format-asset-slots.ts` (TS types) and `schemas.generated.ts`
// (*AssetRequirementsSchema). The Zod codegen pipeline (generate-zod-from-ts.ts)
// only processes core.generated.ts + tools.generated.ts; format-asset-slots.ts
// uses mapped types (GroupSlotOf<T>) that ts-to-zod cannot handle, so these
// schemas are hand-authored and kept in sync with the TS types manually.
//
// Consumers:
//   - Runtime validation of Format.assets[] from listCreativeFormats() responses
//   - Type narrowing via slot.asset_type after z.union discrimination

import { z } from 'zod';
import {
  AudioAssetRequirementsSchema,
  CSSAssetRequirementsSchema,
  CatalogRequirementsSchema,
  DAASTAssetRequirementsSchema,
  HTMLAssetRequirementsSchema,
  ImageAssetRequirementsSchema,
  JavaScriptAssetRequirementsSchema,
  MarkdownAssetRequirementsSchema,
  OverlaySchema,
  TextAssetRequirementsSchema,
  URLAssetRequirementsSchema,
  VASTAssetRequirementsSchema,
  VideoAssetRequirementsSchema,
  WebhookAssetRequirementsSchema,
} from './schemas.generated';

// ---------- Shared base schemas ----------

export const BaseIndividualAssetSlotSchema = z
  .object({
    item_type: z.literal('individual'),
    asset_id: z.string(),
    asset_role: z.string().optional(),
    required: z.boolean(),
    overlays: z.array(OverlaySchema).optional(),
  })
  .passthrough();

// Group slots inherit BaseGroupAssetSlot fields (asset_id, asset_role, required,
// overlays) but omit item_type — groups are always inside a RepeatableGroupSlot.
export const BaseGroupAssetSlotSchema = z
  .object({
    asset_id: z.string(),
    asset_role: z.string().optional(),
    required: z.boolean(),
    overlays: z.array(OverlaySchema).optional(),
  })
  .passthrough();

// ---------- Per-asset-type individual slot schemas ----------

export const IndividualImageAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('image'), requirements: ImageAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualVideoAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('video'), requirements: VideoAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualAudioAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('audio'), requirements: AudioAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualTextAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('text'), requirements: TextAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualMarkdownAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z
    .object({ asset_type: z.literal('markdown'), requirements: MarkdownAssetRequirementsSchema.optional() })
    .passthrough()
);

export const IndividualHtmlAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('html'), requirements: HTMLAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualCssAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('css'), requirements: CSSAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualJavascriptAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z
    .object({ asset_type: z.literal('javascript'), requirements: JavaScriptAssetRequirementsSchema.optional() })
    .passthrough()
);

export const IndividualVastAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('vast'), requirements: VASTAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualDaastAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('daast'), requirements: DAASTAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualUrlAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('url'), requirements: URLAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualWebhookAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('webhook'), requirements: WebhookAssetRequirementsSchema.optional() }).passthrough()
);

export const IndividualBriefAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('brief') }).passthrough()
);

export const IndividualCatalogAssetSlotSchema = BaseIndividualAssetSlotSchema.and(
  z.object({ asset_type: z.literal('catalog'), requirements: CatalogRequirementsSchema.optional() }).passthrough()
);

// Discriminated union over all individual slot types.
// Uses z.union (not z.discriminatedUnion) because the members are ZodIntersection,
// not ZodObject — a limitation of composing with .and().
export const IndividualAssetSlotSchema = z.union([
  IndividualImageAssetSlotSchema,
  IndividualVideoAssetSlotSchema,
  IndividualAudioAssetSlotSchema,
  IndividualTextAssetSlotSchema,
  IndividualMarkdownAssetSlotSchema,
  IndividualHtmlAssetSlotSchema,
  IndividualCssAssetSlotSchema,
  IndividualJavascriptAssetSlotSchema,
  IndividualVastAssetSlotSchema,
  IndividualDaastAssetSlotSchema,
  IndividualUrlAssetSlotSchema,
  IndividualWebhookAssetSlotSchema,
  IndividualBriefAssetSlotSchema,
  IndividualCatalogAssetSlotSchema,
]);

// ---------- Group asset slot schemas (inside a repeatable_group) ----------
//
// GroupSlotOf<T> = Omit<T, 'item_type' | 'overlays'> & BaseGroupAssetSlot
// The result has asset_type + requirements (from the individual) plus
// asset_id, asset_role, required, overlays (from BaseGroupAssetSlot).

export const GroupImageAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('image'), requirements: ImageAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupVideoAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('video'), requirements: VideoAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupAudioAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('audio'), requirements: AudioAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupTextAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('text'), requirements: TextAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupMarkdownAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z
    .object({ asset_type: z.literal('markdown'), requirements: MarkdownAssetRequirementsSchema.optional() })
    .passthrough()
);

export const GroupHtmlAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('html'), requirements: HTMLAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupCssAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('css'), requirements: CSSAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupJavascriptAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z
    .object({ asset_type: z.literal('javascript'), requirements: JavaScriptAssetRequirementsSchema.optional() })
    .passthrough()
);

export const GroupVastAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('vast'), requirements: VASTAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupDaastAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('daast'), requirements: DAASTAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupUrlAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('url'), requirements: URLAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupWebhookAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('webhook'), requirements: WebhookAssetRequirementsSchema.optional() }).passthrough()
);

export const GroupBriefAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('brief') }).passthrough()
);

export const GroupCatalogAssetSlotSchema = BaseGroupAssetSlotSchema.and(
  z.object({ asset_type: z.literal('catalog'), requirements: CatalogRequirementsSchema.optional() }).passthrough()
);

export const GroupAssetSlotSchema = z.union([
  GroupImageAssetSlotSchema,
  GroupVideoAssetSlotSchema,
  GroupAudioAssetSlotSchema,
  GroupTextAssetSlotSchema,
  GroupMarkdownAssetSlotSchema,
  GroupHtmlAssetSlotSchema,
  GroupCssAssetSlotSchema,
  GroupJavascriptAssetSlotSchema,
  GroupVastAssetSlotSchema,
  GroupDaastAssetSlotSchema,
  GroupUrlAssetSlotSchema,
  GroupWebhookAssetSlotSchema,
  GroupBriefAssetSlotSchema,
  GroupCatalogAssetSlotSchema,
]);

// ---------- Repeatable group ----------

export const RepeatableGroupSlotSchema = z
  .object({
    item_type: z.literal('repeatable_group'),
    asset_group_id: z.string(),
    required: z.boolean(),
    min_count: z.number(),
    max_count: z.number(),
    selection_mode: z.enum(['sequential', 'optimize']).optional(),
    assets: z.array(GroupAssetSlotSchema),
  })
  .passthrough();

// ---------- Top-level union for Format.assets[] elements ----------

export const FormatAssetSlotSchema = z.union([IndividualAssetSlotSchema, RepeatableGroupSlotSchema]);
