// Type-level gate for the format asset slot types.
//
// This file is type-checked by `npm run typecheck` (root tsconfig includes
// `src/**/*`) but NOT emitted to dist — the library build uses
// `tsconfig.lib.json` with `rootDir: src/lib`, so this path sits outside the
// build surface on purpose.
//
// Each `@ts-expect-error` below asserts that the types reject the exact
// failure modes that scope3data/agentic-adapters#118 surfaced in the five
// social/retail adapters. If any of these stop erroring, the types regressed
// and CI will fail here first.

import type {
  IndividualImageAssetSlot,
  IndividualVideoAssetSlot,
  IndividualAudioAssetSlot,
  RepeatableGroupSlot,
} from '../lib/types/format-asset-slots';

// --- Image: the field is `formats`, not `file_types` ---
const goodImage: IndividualImageAssetSlot = {
  item_type: 'individual',
  asset_type: 'image',
  asset_id: 'hero',
  required: true,
  requirements: { formats: ['jpg', 'png'], aspect_ratio: '1:1' },
};
void goodImage;

const badImage: IndividualImageAssetSlot = {
  item_type: 'individual',
  asset_type: 'image',
  asset_id: 'hero',
  required: true,
  requirements: {
    // @ts-expect-error — `file_types` is not a spec field; the correct name is `formats`
    file_types: ['jpg'],
  },
};
void badImage;

// --- Video: unit is milliseconds, not seconds ---
const goodVideo: IndividualVideoAssetSlot = {
  item_type: 'individual',
  asset_type: 'video',
  asset_id: 'ad',
  required: true,
  requirements: { min_duration_ms: 6000, max_duration_ms: 30000, containers: ['mp4'] },
};
void goodVideo;

const badVideoMinSeconds: IndividualVideoAssetSlot = {
  item_type: 'individual',
  asset_type: 'video',
  asset_id: 'ad',
  required: true,
  // @ts-expect-error — use `min_duration_ms` (spec is milliseconds, not seconds)
  requirements: { min_duration_seconds: 6 },
};
void badVideoMinSeconds;

const badVideoMaxSeconds: IndividualVideoAssetSlot = {
  item_type: 'individual',
  asset_type: 'video',
  asset_id: 'ad',
  required: true,
  // @ts-expect-error — use `max_duration_ms`
  requirements: { max_duration_seconds: 30 },
};
void badVideoMaxSeconds;

// --- Video: containers, not file_types ---
const badVideoFileTypes: IndividualVideoAssetSlot = {
  item_type: 'individual',
  asset_type: 'video',
  asset_id: 'ad',
  required: true,
  requirements: {
    // @ts-expect-error — the field is `containers` for video, not `file_types`
    file_types: ['mp4'],
  },
};
void badVideoFileTypes;

// --- Video: container enum is closed ---
const badVideoContainer: IndividualVideoAssetSlot = {
  item_type: 'individual',
  asset_type: 'video',
  asset_id: 'ad',
  required: true,
  requirements: {
    // @ts-expect-error — 'flv' is not in the spec enum (mp4|webm|mov|avi|mkv)
    containers: ['flv'],
  },
};
void badVideoContainer;

// --- Audio: formats enum is closed ---
const badAudio: IndividualAudioAssetSlot = {
  item_type: 'individual',
  asset_type: 'audio',
  asset_id: 'spot',
  required: true,
  requirements: {
    // @ts-expect-error — 'm4a' is not in the spec enum (mp3|aac|wav|ogg|flac)
    formats: ['m4a'],
  },
};
void badAudio;

// --- min_count / max_count belong on the repeatable_group wrapper ---
// Correct: counts on the group.
const goodGroup: RepeatableGroupSlot = {
  item_type: 'repeatable_group',
  asset_group_id: 'carousel',
  required: true,
  min_count: 2,
  max_count: 5,
  assets: [
    {
      asset_type: 'image',
      asset_id: 'card_image',
      required: true,
      requirements: { aspect_ratio: '1:1' },
    },
  ],
};
void goodGroup;

// Wrong: counts on an individual image slot. Pinterest/TikTok carousels in
// PR #118 tried this shape before the repeatable_group fix.
const badMinCountOnIndividual: IndividualImageAssetSlot = {
  item_type: 'individual',
  asset_type: 'image',
  asset_id: 'card_image',
  required: true,
  // @ts-expect-error — min_count is only valid on a repeatable_group wrapper
  min_count: 2,
};
void badMinCountOnIndividual;

const badMaxCountOnIndividual: IndividualImageAssetSlot = {
  item_type: 'individual',
  asset_type: 'image',
  asset_id: 'card_image',
  required: true,
  // @ts-expect-error — max_count is only valid on a repeatable_group wrapper
  max_count: 5,
};
void badMaxCountOnIndividual;
