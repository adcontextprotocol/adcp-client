/**
 * Platform compliance profiles.
 *
 * Each profile defines what an agent of that platform type is expected
 * to support, and runs coherence checks against the discovered agent profile.
 */

import type { AgentProfile } from '../types';
import type { ComplianceTrack, PlatformType, CoherenceFinding, InventoryModel, PricingModel } from './types';

export interface PlatformProfile {
  type: PlatformType;
  label: string;
  /** Tracks this platform type is expected to support */
  expected_tracks: ComplianceTrack[];
  /** Tools the agent should have for this platform type */
  expected_tools: string[];
  /** Channels that make sense for this platform type (at least one expected in products) */
  expected_channels?: string[];
  /** How inventory is allocated to buyers */
  inventory_model: InventoryModel;
  /** Pricing models supported by the platform */
  pricing_models: PricingModel[];
  /** Run coherence checks against discovered agent profile */
  checkCoherence: (profile: AgentProfile) => CoherenceFinding[];
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function missingTools(profile: AgentProfile, expected: string[]): string[] {
  return expected.filter(t => !profile.tools.includes(t));
}

function toolFinding(tool: string, context: string): CoherenceFinding {
  return {
    expected: `Agent has ${tool}`,
    actual: `${tool} not found in tool list`,
    guidance: context,
    severity: 'warning',
  };
}

function channelSuggestion(expectedChannels: string[]): CoherenceFinding {
  return {
    expected: `Products include ${expectedChannels.join(' or ')} channel`,
    actual: 'Cannot verify channels without running get_products',
    guidance: `Ensure your products declare ${expectedChannels.join('/')} in their channels array.`,
    severity: 'suggestion',
  };
}

// ────────────────────────────────────────────────────────────
// Sales platform coherence checks
// ────────────────────────────────────────────────────────────

function salesBaseCheck(profile: AgentProfile): CoherenceFinding[] {
  const findings: CoherenceFinding[] = [];
  const coreSalesTools = ['get_products', 'create_media_buy', 'get_media_buy_delivery'];
  for (const tool of missingTools(profile, coreSalesTools)) {
    const guidance =
      tool === 'get_media_buy_delivery'
        ? 'Buyers need delivery data to verify campaign performance and reconcile spend.'
        : `All sales platforms need ${tool} for the buy workflow.`;
    findings.push(toolFinding(tool, guidance));
  }
  return findings;
}

// ────────────────────────────────────────────────────────────
// Profile definitions
// ────────────────────────────────────────────────────────────

export const PLATFORM_PROFILES: Record<PlatformType, PlatformProfile> = {
  // ── Sales platforms ──────────────────────────────────────

  display_ad_server: {
    type: 'display_ad_server',
    label: 'Display Ad Server',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting'],
    expected_tools: ['get_products', 'create_media_buy', 'list_creative_formats', 'sync_creatives', 'get_media_buy_delivery'],
    expected_channels: ['display'],
    inventory_model: 'guaranteed',
    pricing_models: ['cpm', 'flat'],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      for (const tool of missingTools(profile, ['list_creative_formats'])) {
        findings.push(
          toolFinding(
            tool,
            'Display ad servers need list_creative_formats so buyers know what tag/image formats you accept.'
          )
        );
      }
      for (const tool of missingTools(profile, ['sync_creatives'])) {
        findings.push(toolFinding(tool, 'Buyers deliver HTML tags and image assets via sync_creatives.'));
      }
      findings.push(channelSuggestion(['display']));
      return findings;
    },
  },

  video_ad_server: {
    type: 'video_ad_server',
    label: 'Video Ad Server',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting'],
    expected_tools: ['get_products', 'create_media_buy', 'list_creative_formats', 'sync_creatives', 'get_media_buy_delivery'],
    expected_channels: ['ctv', 'olv'],
    inventory_model: 'guaranteed',
    pricing_models: ['cpm', 'flat'],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      for (const tool of missingTools(profile, ['list_creative_formats'])) {
        findings.push(
          toolFinding(tool, 'Video ad servers need list_creative_formats to declare VAST/video format support.')
        );
      }
      for (const tool of missingTools(profile, ['sync_creatives'])) {
        findings.push(toolFinding(tool, 'Buyers deliver VAST tags and video assets via sync_creatives.'));
      }
      findings.push(channelSuggestion(['ctv', 'olv']));
      return findings;
    },
  },

  social_platform: {
    type: 'social_platform',
    label: 'Social Platform',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting', 'audiences'],
    expected_tools: ['get_products', 'create_media_buy', 'list_creative_formats', 'sync_audiences', 'get_media_buy_delivery'],
    expected_channels: ['social'],
    inventory_model: 'auction',
    pricing_models: ['cpm', 'auction'],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      for (const tool of missingTools(profile, ['sync_audiences'])) {
        findings.push(
          toolFinding(tool, 'Social platforms need sync_audiences — audience targeting is core to social advertising.')
        );
      }
      for (const tool of missingTools(profile, ['list_creative_formats'])) {
        findings.push(
          toolFinding(
            tool,
            'Social platforms need list_creative_formats to declare native ad formats (carousel, story, feed).'
          )
        );
      }
      findings.push(channelSuggestion(['social']));
      return findings;
    },
  },

  pmax_platform: {
    type: 'pmax_platform',
    label: 'Performance Max Platform',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting', 'audiences', 'signals'],
    inventory_model: 'auction',
    pricing_models: ['cpm', 'auction'],
    expected_tools: [
      'get_products',
      'create_media_buy',
      'list_creative_formats',
      'build_creative',
      'sync_audiences',
      'get_signals',
      'get_media_buy_delivery',
    ],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      for (const tool of missingTools(profile, ['build_creative'])) {
        findings.push(
          toolFinding(
            tool,
            'pMax platforms generate creative from brand assets — build_creative is the generative entry point.'
          )
        );
      }
      for (const tool of missingTools(profile, ['sync_audiences'])) {
        findings.push(
          toolFinding(
            tool,
            'pMax platforms optimize across audience segments — sync_audiences enables first-party data.'
          )
        );
      }
      for (const tool of missingTools(profile, ['get_signals'])) {
        findings.push(toolFinding(tool, 'pMax platforms use signals for cross-channel optimization.'));
      }
      return findings;
    },
  },

  dsp: {
    type: 'dsp',
    label: 'DSP / Ad Network',
    expected_tracks: ['core', 'products', 'media_buy', 'reporting', 'governance'],
    expected_tools: ['get_products', 'create_media_buy', 'get_media_buy_delivery'],
    inventory_model: 'auction',
    pricing_models: ['auction', 'cpm'],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      const hasGovernance = profile.tools.some(t => ['create_property_list', 'list_content_standards'].includes(t));
      if (!hasGovernance) {
        findings.push({
          expected: 'Governance tools for brand safety controls',
          actual: 'No governance tools found',
          guidance: 'DSPs typically support property lists and content standards for brand safety.',
          severity: 'suggestion',
        });
      }
      return findings;
    },
  },

  retail_media: {
    type: 'retail_media',
    label: 'Retail Media Network',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting', 'audiences'],
    expected_tools: ['get_products', 'create_media_buy', 'list_creative_formats', 'sync_audiences', 'get_media_buy_delivery'],
    expected_channels: ['retail_media'],
    inventory_model: 'hybrid',
    pricing_models: ['cpc', 'cpm', 'flat'],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      for (const tool of missingTools(profile, ['sync_audiences'])) {
        findings.push(toolFinding(tool, 'Retail media networks need sync_audiences for shopper audience segments.'));
      }
      for (const tool of missingTools(profile, ['list_creative_formats'])) {
        findings.push(
          toolFinding(
            tool,
            'Retail media networks need list_creative_formats to declare sponsored product and display formats.'
          )
        );
      }
      findings.push(channelSuggestion(['retail_media']));
      return findings;
    },
  },

  search_platform: {
    type: 'search_platform',
    label: 'Search Platform',
    expected_tracks: ['core', 'products', 'media_buy', 'reporting'],
    expected_tools: ['get_products', 'create_media_buy', 'get_media_buy_delivery'],
    expected_channels: ['search'],
    inventory_model: 'auction',
    pricing_models: ['cpc', 'auction'],

    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      findings.push(channelSuggestion(['search']));
      findings.push({
        expected: 'Products support keyword targeting via targeting_overlay',
        actual: 'Cannot verify without running create_media_buy',
        guidance:
          'Search platforms should accept keyword_targets in the targeting overlay with broad/phrase/exact match types.',
        severity: 'suggestion',
      });
      return findings;
    },
  },

  audio_platform: {
    type: 'audio_platform',
    label: 'Audio / Podcast Platform',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting'],
    expected_tools: ['get_products', 'create_media_buy', 'list_creative_formats', 'get_media_buy_delivery'],
    expected_channels: ['podcast', 'streaming_audio'],
    inventory_model: 'guaranteed',
    pricing_models: ['cpm', 'flat'],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      for (const tool of missingTools(profile, ['list_creative_formats'])) {
        findings.push(
          toolFinding(tool, 'Audio platforms need list_creative_formats to declare audio/DAAST format support.')
        );
      }
      findings.push(channelSuggestion(['podcast', 'streaming_audio']));
      return findings;
    },
  },

  linear_tv_platform: {
    type: 'linear_tv_platform',
    label: 'Linear TV Platform',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting'],
    expected_tools: [
      'get_products',
      'create_media_buy',
      'list_creative_formats',
      'sync_creatives',
      'get_media_buy_delivery',
    ],
    expected_channels: ['linear_tv'],
    inventory_model: 'reserved',
    pricing_models: ['cpp', 'cpm'],

    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      for (const tool of missingTools(profile, ['list_creative_formats'])) {
        findings.push(
          toolFinding(
            tool,
            'Linear TV platforms need list_creative_formats to declare broadcast spot formats and ISCI code requirements.'
          )
        );
      }
      for (const tool of missingTools(profile, ['sync_creatives'])) {
        findings.push(
          toolFinding(tool, 'Buyers deliver traffic instructions and ISCI codes via sync_creatives.')
        );
      }
      findings.push(channelSuggestion(['linear_tv']));
      return findings;
    },
  },

  // ── Creative agents ──────────────────────────────────────

  creative_transformer: {
    type: 'creative_transformer',
    label: 'Creative Transformer',
    expected_tracks: ['core', 'creative'],
    expected_tools: ['build_creative', 'preview_creative', 'list_creative_formats'],
    inventory_model: 'guaranteed',
    pricing_models: ['flat'],
    checkCoherence(profile) {
      const findings: CoherenceFinding[] = [];
      for (const tool of missingTools(profile, ['build_creative'])) {
        findings.push(
          toolFinding(
            tool,
            'Creative transformers need build_creative — it is the core tool for accepting assets and returning transformed creative.'
          )
        );
      }
      for (const tool of missingTools(profile, ['preview_creative'])) {
        findings.push(toolFinding(tool, 'preview_creative lets buyers verify transformed output before going live.'));
      }
      for (const tool of missingTools(profile, ['list_creative_formats'])) {
        findings.push(
          toolFinding(tool, 'list_creative_formats declares what input/output format transformations you support.')
        );
      }
      // Warn if stateful tools present — suggests this is actually a creative_ad_server
      const statefulTools = ['sync_creatives', 'list_creatives'].filter(t => profile.tools.includes(t));
      if (statefulTools.length > 0) {
        findings.push({
          expected: 'Stateless transformer (no creative library)',
          actual: `Agent has stateful tools: ${statefulTools.join(', ')}`,
          guidance:
            'If your agent manages a creative library, consider using creative_ad_server as your platform type.',
          severity: 'suggestion',
        });
      }
      return findings;
    },
  },

  creative_library: {
    type: 'creative_library',
    label: 'Creative Format Library',
    expected_tracks: ['core', 'creative'],
    expected_tools: ['preview_creative', 'list_creative_formats'],
    inventory_model: 'guaranteed',
    pricing_models: ['flat'],
    checkCoherence(profile) {
      const findings: CoherenceFinding[] = [];
      for (const tool of missingTools(profile, ['list_creative_formats'])) {
        findings.push(
          toolFinding(
            tool,
            'Creative libraries need list_creative_formats — it is how buyers discover your available formats.'
          )
        );
      }
      for (const tool of missingTools(profile, ['preview_creative'])) {
        findings.push(toolFinding(tool, 'preview_creative lets buyers see how formats render.'));
      }
      if (profile.tools.includes('build_creative')) {
        findings.push({
          expected: 'Format library (no creative generation)',
          actual: 'Agent has build_creative',
          guidance:
            'If your agent generates creative, consider using creative_transformer or creative_ad_server as your platform type.',
          severity: 'suggestion',
        });
      }
      return findings;
    },
  },

  creative_ad_server: {
    type: 'creative_ad_server',
    label: 'Creative Ad Server',
    expected_tracks: ['core', 'creative'],
    expected_tools: ['build_creative', 'list_creatives', 'sync_creatives', 'preview_creative', 'list_creative_formats'],
    inventory_model: 'guaranteed',
    pricing_models: ['flat'],
    checkCoherence(profile) {
      const findings: CoherenceFinding[] = [];
      const allExpected = [
        'build_creative',
        'list_creatives',
        'sync_creatives',
        'preview_creative',
        'list_creative_formats',
      ];
      for (const tool of missingTools(profile, allExpected)) {
        const descriptions: Record<string, string> = {
          build_creative: 'build_creative handles creative generation and assembly.',
          list_creatives: 'list_creatives lets buyers browse the creative library.',
          sync_creatives: 'sync_creatives manages the creative approval/rejection lifecycle.',
          preview_creative: 'preview_creative lets buyers verify creative before going live.',
          list_creative_formats: 'list_creative_formats declares supported format specifications.',
        };
        findings.push(toolFinding(tool, descriptions[tool] ?? `Creative ad servers need ${tool}.`));
      }
      return findings;
    },
  },

  // ── Sponsored intelligence ───────────────────────────────

  si_platform: {
    type: 'si_platform',
    label: 'Sponsored Intelligence Platform',
    expected_tracks: ['core', 'si'],
    expected_tools: ['si_get_offering', 'si_initiate_session', 'si_send_message', 'si_terminate_session'],
    expected_channels: ['sponsored_intelligence'],
    inventory_model: 'guaranteed',
    pricing_models: ['cpm', 'flat'],
    checkCoherence(profile) {
      const findings: CoherenceFinding[] = [];
      const siTools = ['si_get_offering', 'si_initiate_session', 'si_send_message', 'si_terminate_session'];
      for (const tool of missingTools(profile, siTools)) {
        findings.push(toolFinding(tool, `SI platforms need the full session lifecycle. ${tool} is required.`));
      }
      findings.push(channelSuggestion(['sponsored_intelligence']));
      return findings;
    },
  },

  // ── AI-native platforms ──────────────────────────────────

  ai_ad_network: {
    type: 'ai_ad_network',
    label: 'AI Ad Network',
    expected_tracks: ['core', 'products', 'media_buy', 'si', 'reporting', 'governance'],
    inventory_model: 'hybrid',
    pricing_models: ['cpm', 'auction'],
    expected_tools: [
      'get_products',
      'create_media_buy',
      'get_media_buy_delivery',
      'si_get_offering',
      'si_initiate_session',
      'si_send_message',
      'si_terminate_session',
    ],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      const siTools = ['si_get_offering', 'si_initiate_session', 'si_send_message', 'si_terminate_session'];
      for (const tool of missingTools(profile, siTools)) {
        findings.push(
          toolFinding(
            tool,
            'AI ad networks aggregate AI-powered inventory — SI tools enable conversational ad surfaces.'
          )
        );
      }
      const hasGovernance = profile.tools.some(t => ['create_property_list', 'list_content_standards'].includes(t));
      if (!hasGovernance) {
        findings.push({
          expected: 'Governance tools for cross-property brand safety',
          actual: 'No governance tools found',
          guidance: 'AI ad networks routing across properties should support governance for brand safety controls.',
          severity: 'suggestion',
        });
      }
      return findings;
    },
  },

  ai_platform: {
    type: 'ai_platform',
    label: 'AI Platform',
    expected_tracks: ['core', 'products', 'media_buy', 'si', 'reporting'],
    inventory_model: 'hybrid',
    pricing_models: ['cpm', 'auction'],
    expected_tools: [
      'get_products',
      'create_media_buy',
      'get_media_buy_delivery',
      'si_get_offering',
      'si_initiate_session',
      'si_send_message',
      'si_terminate_session',
    ],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      const siTools = ['si_get_offering', 'si_initiate_session', 'si_send_message', 'si_terminate_session'];
      for (const tool of missingTools(profile, siTools)) {
        findings.push(
          toolFinding(
            tool,
            'AI platforms monetize via sponsored conversations — SI tools are the conversational ad surface.'
          )
        );
      }
      return findings;
    },
  },

  generative_dsp: {
    type: 'generative_dsp',
    label: 'Generative DSP',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'reporting', 'audiences', 'governance'],
    expected_tools: ['get_products', 'create_media_buy', 'build_creative', 'sync_audiences', 'get_media_buy_delivery'],
    inventory_model: 'auction',
    pricing_models: ['auction', 'cpm'],
    checkCoherence(profile) {
      const findings = salesBaseCheck(profile);
      for (const tool of missingTools(profile, ['build_creative'])) {
        findings.push(
          toolFinding(
            tool,
            'Generative DSPs create creative on the fly — build_creative is the generative entry point.'
          )
        );
      }
      for (const tool of missingTools(profile, ['sync_audiences'])) {
        findings.push(
          toolFinding(
            tool,
            'Generative DSPs optimize across audience segments — sync_audiences enables first-party data.'
          )
        );
      }
      return findings;
    },
  },
};

/**
 * Get the compliance profile for a platform type.
 */
export function getPlatformProfile(type: PlatformType): PlatformProfile {
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_PROFILES, type)) {
    throw new Error(`Unknown platform type: ${type}`);
  }
  return PLATFORM_PROFILES[type];
}

/**
 * Get all available platform types.
 */
export function getAllPlatformTypes(): PlatformType[] {
  return Object.keys(PLATFORM_PROFILES) as PlatformType[];
}

/**
 * Get all available platform types with their labels.
 */
export function getPlatformTypesWithLabels(): Array<{ id: PlatformType; label: string }> {
  return (Object.keys(PLATFORM_PROFILES) as PlatformType[]).map(type => ({
    id: type,
    label: PLATFORM_PROFILES[type].label,
  }));
}
