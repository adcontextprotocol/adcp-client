export interface MockTemplate {
  template_id: string;
  name: string;
  description: string;
  channel: 'display' | 'video' | 'audio' | 'ctv' | 'native';
  dimensions?: { width: number; height: number };
  duration_seconds?: { min: number; max: number };
  output_kind: 'html_tag' | 'javascript_tag' | 'vast_xml' | 'audio_url';
  slots: MockTemplateSlot[];
  sample_inputs?: Record<string, unknown>;
}

export interface MockTemplateSlot {
  slot_id: string;
  asset_type: 'image' | 'video' | 'audio' | 'text' | 'click_url';
  required: boolean;
  constraints?: Record<string, unknown>;
}

export interface MockWorkspace {
  workspace_id: string;
  display_name: string;
  /** AdCP-side identifier the adapter uses to map principal → workspace.
   * The adapter receives this value via the AdCP request (e.g.,
   * `account.advertiser` or principal lookup) and must translate it to
   * `workspace_id` for outbound URL composition. */
  adcp_advertiser: string;
  visible_template_ids: string[];
}

/**
 * Templates seeded across both workspaces. Each represents a common creative
 * shape (display medium rectangle, leaderboard, mobile banner, video
 * preroll). The slot definitions intentionally use upstream vocabulary
 * (`slot_id`) rather than AdCP's `asset_role` so the adapter has to
 * translate during list_creative_formats projection.
 */
export const TEMPLATES: MockTemplate[] = [
  {
    template_id: 'tpl_celtra_display_medrec_v2',
    name: 'Display Medium Rectangle (300x250)',
    description: 'Standard IAB medium rectangle with brand-aware text overlay and CTA.',
    channel: 'display',
    dimensions: { width: 300, height: 250 },
    output_kind: 'html_tag',
    slots: [
      {
        slot_id: 'image',
        asset_type: 'image',
        required: true,
        constraints: { width: 300, height: 250, mime_types: ['image/jpeg', 'image/png', 'image/webp'] },
      },
      {
        slot_id: 'headline',
        asset_type: 'text',
        required: true,
        constraints: { max_chars: 40 },
      },
      {
        slot_id: 'cta',
        asset_type: 'text',
        required: true,
        constraints: { max_chars: 20 },
      },
      {
        slot_id: 'click_through',
        asset_type: 'click_url',
        required: true,
      },
    ],
    sample_inputs: {
      image_url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/hero-300x250.jpg',
      headline: 'Built for the trail.',
      cta: 'Shop Gear',
    },
  },
  {
    template_id: 'tpl_celtra_display_leaderboard_v2',
    name: 'Display Leaderboard (728x90)',
    description:
      'Standard IAB leaderboard with brand-aware text overlay and CTA. JS tag output (carries impression macros, viewability shims, MRAID/SafeFrame hooks per IAB OpenRTB 2.6 §3.2.4).',
    channel: 'display',
    dimensions: { width: 728, height: 90 },
    output_kind: 'javascript_tag',
    slots: [
      {
        slot_id: 'image',
        asset_type: 'image',
        required: true,
        constraints: { width: 728, height: 90, mime_types: ['image/jpeg', 'image/png', 'image/webp'] },
      },
      {
        slot_id: 'headline',
        asset_type: 'text',
        required: true,
        constraints: { max_chars: 60 },
      },
      {
        slot_id: 'cta',
        asset_type: 'text',
        required: true,
        constraints: { max_chars: 20 },
      },
      {
        slot_id: 'click_through',
        asset_type: 'click_url',
        required: true,
      },
    ],
  },
  {
    template_id: 'tpl_celtra_mobile_banner_v2',
    name: 'Mobile Banner (320x50)',
    description: 'Standard IAB mobile banner. JS tag output for in-app/MRAID compatibility.',
    channel: 'display',
    dimensions: { width: 320, height: 50 },
    output_kind: 'javascript_tag',
    slots: [
      {
        slot_id: 'image',
        asset_type: 'image',
        required: true,
        constraints: { width: 320, height: 50, mime_types: ['image/jpeg', 'image/png', 'image/webp'] },
      },
      {
        slot_id: 'cta',
        asset_type: 'text',
        required: true,
        constraints: { max_chars: 16 },
      },
      {
        slot_id: 'click_through',
        asset_type: 'click_url',
        required: true,
      },
    ],
  },
  {
    template_id: 'tpl_celtra_video_preroll_v1',
    name: 'Video Preroll (15s)',
    description: 'In-stream video preroll with 15-second cap and end card.',
    channel: 'video',
    duration_seconds: { min: 6, max: 15 },
    output_kind: 'vast_xml',
    slots: [
      {
        slot_id: 'video',
        asset_type: 'video',
        required: true,
        constraints: { duration_max_seconds: 15, mime_types: ['video/mp4', 'video/webm'] },
      },
      {
        slot_id: 'click_through',
        asset_type: 'click_url',
        required: true,
      },
    ],
  },
  // Audio template — TTS / mix / master pattern. Mirrors AudioStack /
  // ElevenLabs / Resemble shape: text script in, audio file out.
  // No dimensions (audio has no width/height); the renderer's queued →
  // running → complete state machine simulates the multi-minute TTS
  // pipeline production audio platforms run.
  {
    template_id: 'tpl_audiostack_spot_30s_v1',
    name: 'Audio Spot (30s, voiceover + music bed)',
    description:
      'Text-to-speech voiceover mixed with a music bed and mastered to 30-second spot. No visual dimensions.',
    channel: 'audio',
    duration_seconds: { min: 15, max: 30 },
    output_kind: 'audio_url',
    slots: [
      {
        slot_id: 'script',
        asset_type: 'text',
        required: true,
        constraints: { max_chars: 600 },
      },
      {
        slot_id: 'voice',
        asset_type: 'text',
        required: false,
        constraints: { allowed_values: ['narrator-warm', 'narrator-energetic', 'announcer-classic'] },
      },
      {
        slot_id: 'music_bed',
        asset_type: 'audio',
        required: false,
        constraints: { mime_types: ['audio/mpeg', 'audio/wav'] },
      },
      {
        slot_id: 'click_through',
        asset_type: 'click_url',
        required: false,
      },
    ],
    sample_inputs: {
      script: 'Built for the trail. Acme Outdoor — premium gear for every adventure.',
      voice: 'narrator-warm',
    },
  },
];

export const WORKSPACES: MockWorkspace[] = [
  {
    workspace_id: 'ws_acme_studio',
    display_name: 'Acme Outdoor Creative Studio',
    adcp_advertiser: 'acmeoutdoor.example',
    visible_template_ids: TEMPLATES.map(t => t.template_id),
  },
  {
    workspace_id: 'ws_summit_studio',
    display_name: 'Summit Media Creative Studio',
    adcp_advertiser: 'summit-media.example',
    // Summit's workspace doesn't have video access — only display templates.
    visible_template_ids: TEMPLATES.filter(t => t.channel === 'display').map(t => t.template_id),
  },
];

/** Default static API key. Override via `--api-key` at boot. */
export const DEFAULT_API_KEY = 'mock_creative_template_key_do_not_use_in_prod';
