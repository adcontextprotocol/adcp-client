// Strict types for the asset slots inside a Format definition (Format.assets[]).
//
// These describe what a publisher/platform SELLS — the slots buyers must fill
// when building a creative for the format. They are distinct from the creative
// instance types (ImageAsset, VideoAsset, …) in `tools.generated.ts`, which
// describe the assets a buyer DELIVERS.
//
// The generated `Format.assets[]` collapses to `BaseIndividualAsset` (no
// per-asset-type discriminator, no `requirements` field) — the json-schema-to-
// typescript codegen loses the `oneOf` branching when all branches share a
// `$ref` base. The per-asset-type `*AssetRequirements` interfaces already
// exist in `core.generated.ts`; these hand-authored slot types wire them in
// so misnamed fields (`file_types` vs `formats`), wrong units (`_seconds` vs
// `_ms`), and misplaced `min_count` (on an individual asset instead of a
// repeatable_group) become TypeScript errors at the authorship site.
//
// Source of truth: schemas/cache/{version}/bundled/{creative,media-buy}/list-creative-formats-response.json

import type {
  AudioAssetRequirements,
  CSSAssetRequirements,
  CatalogRequirements,
  DAASTAssetRequirements,
  HTMLAssetRequirements,
  ImageAssetRequirements,
  JavaScriptAssetRequirements,
  MarkdownAssetRequirements,
  TextAssetRequirements,
  URLAssetRequirements,
  VASTAssetRequirements,
  VideoAssetRequirements,
  WebhookAssetRequirements,
} from './core.generated';
import type { Overlay } from './tools.generated';

// ---------- Shared base ----------

export interface BaseIndividualAssetSlot {
  item_type: 'individual';
  /** Unique identifier for this asset. Creative manifests MUST use this exact value as the key in the assets object. */
  asset_id: string;
  /** Descriptive label for this asset's purpose (for documentation / UI only). */
  asset_role?: string;
  /** Whether this asset is required for a valid creative. */
  required: boolean;
  /** Publisher-controlled overlay elements rendered over buyer content at this asset's position. */
  overlays?: Overlay[];
}

export interface BaseGroupAssetSlot {
  /** Identifier within the group. */
  asset_id: string;
  asset_role?: string;
  /** Whether this asset is required within each repetition of the group. */
  required: boolean;
  overlays?: Overlay[];
}

// ---------- Per-asset-type individual slot shapes ----------

export interface IndividualImageAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'image';
  requirements?: ImageAssetRequirements;
}

export interface IndividualVideoAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'video';
  requirements?: VideoAssetRequirements;
}

export interface IndividualAudioAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'audio';
  requirements?: AudioAssetRequirements;
}

export interface IndividualTextAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'text';
  requirements?: TextAssetRequirements;
}

export interface IndividualMarkdownAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'markdown';
  requirements?: MarkdownAssetRequirements;
}

export interface IndividualHtmlAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'html';
  requirements?: HTMLAssetRequirements;
}

export interface IndividualCssAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'css';
  requirements?: CSSAssetRequirements;
}

export interface IndividualJavascriptAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'javascript';
  requirements?: JavaScriptAssetRequirements;
}

export interface IndividualVastAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'vast';
  requirements?: VASTAssetRequirements;
}

export interface IndividualDaastAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'daast';
  requirements?: DAASTAssetRequirements;
}

export interface IndividualUrlAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'url';
  requirements?: URLAssetRequirements;
}

export interface IndividualWebhookAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'webhook';
  requirements?: WebhookAssetRequirements;
}

export interface IndividualBriefAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'brief';
}

export interface IndividualCatalogAssetSlot extends BaseIndividualAssetSlot {
  asset_type: 'catalog';
  requirements?: CatalogRequirements;
}

export type IndividualAssetSlot =
  | IndividualImageAssetSlot
  | IndividualVideoAssetSlot
  | IndividualAudioAssetSlot
  | IndividualTextAssetSlot
  | IndividualMarkdownAssetSlot
  | IndividualHtmlAssetSlot
  | IndividualCssAssetSlot
  | IndividualJavascriptAssetSlot
  | IndividualVastAssetSlot
  | IndividualDaastAssetSlot
  | IndividualUrlAssetSlot
  | IndividualWebhookAssetSlot
  | IndividualBriefAssetSlot
  | IndividualCatalogAssetSlot;

// ---------- Group asset slot shapes (inside a repeatable_group) ----------

type GroupSlotOf<T extends IndividualAssetSlot> = Omit<T, 'item_type' | 'overlays'> & BaseGroupAssetSlot;

export type GroupImageAssetSlot = GroupSlotOf<IndividualImageAssetSlot>;
export type GroupVideoAssetSlot = GroupSlotOf<IndividualVideoAssetSlot>;
export type GroupAudioAssetSlot = GroupSlotOf<IndividualAudioAssetSlot>;
export type GroupTextAssetSlot = GroupSlotOf<IndividualTextAssetSlot>;
export type GroupMarkdownAssetSlot = GroupSlotOf<IndividualMarkdownAssetSlot>;
export type GroupHtmlAssetSlot = GroupSlotOf<IndividualHtmlAssetSlot>;
export type GroupCssAssetSlot = GroupSlotOf<IndividualCssAssetSlot>;
export type GroupJavascriptAssetSlot = GroupSlotOf<IndividualJavascriptAssetSlot>;
export type GroupVastAssetSlot = GroupSlotOf<IndividualVastAssetSlot>;
export type GroupDaastAssetSlot = GroupSlotOf<IndividualDaastAssetSlot>;
export type GroupUrlAssetSlot = GroupSlotOf<IndividualUrlAssetSlot>;
export type GroupWebhookAssetSlot = GroupSlotOf<IndividualWebhookAssetSlot>;
export type GroupBriefAssetSlot = GroupSlotOf<IndividualBriefAssetSlot>;
export type GroupCatalogAssetSlot = GroupSlotOf<IndividualCatalogAssetSlot>;

export type GroupAssetSlot =
  | GroupImageAssetSlot
  | GroupVideoAssetSlot
  | GroupAudioAssetSlot
  | GroupTextAssetSlot
  | GroupMarkdownAssetSlot
  | GroupHtmlAssetSlot
  | GroupCssAssetSlot
  | GroupJavascriptAssetSlot
  | GroupVastAssetSlot
  | GroupDaastAssetSlot
  | GroupUrlAssetSlot
  | GroupWebhookAssetSlot
  | GroupBriefAssetSlot
  | GroupCatalogAssetSlot;

// ---------- Repeatable group ----------

/**
 * Wrapper for asset groups that repeat (carousels, collections, story-pin
 * frames, product showcases). `min_count` and `max_count` live here — NOT on
 * individual assets inside `assets[]`. Putting count constraints on an
 * individual asset slot violates the spec.
 */
export interface RepeatableGroupSlot {
  item_type: 'repeatable_group';
  /** Identifier for this asset group (e.g., 'product', 'slide', 'card'). */
  asset_group_id: string;
  /** Whether this asset group is required. If true, at least `min_count` repetitions must be provided. */
  required: boolean;
  /** Minimum number of repetitions. */
  min_count: number;
  /** Maximum number of repetitions. */
  max_count: number;
  /** Display semantics: 'sequential' (carousel) or 'optimize' (platform selects best-performing). */
  selection_mode?: 'sequential' | 'optimize';
  /** Assets within each repetition of this group. */
  assets: GroupAssetSlot[];
}

export type FormatAssetSlot = IndividualAssetSlot | RepeatableGroupSlot;
