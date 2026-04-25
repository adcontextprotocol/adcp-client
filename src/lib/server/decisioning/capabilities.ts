/**
 * DecisioningCapabilities — single source of truth for `get_adcp_capabilities`
 * response and any admin UI surface a host wants to render.
 *
 * Adopters declare once. Framework wires the wire-protocol response;
 * adopters' admin tools (or the SDK CLI's `validate_platform_config`) consume
 * the same dataclass so there's no drift between "what the agent says it
 * supports" and "what it actually does."
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { ZodSchema } from 'zod';
import type { AdCPSpecialism, MediaChannel, PricingModel } from '../../types/tools.generated';

export interface DecisioningCapabilities<TConfig = unknown> {
  /** Specialisms claimed; framework type-checks these against implemented platform interfaces. */
  specialisms: AdCPSpecialism[];

  /**
   * Creative agents this seller composes with. Framework fetches format catalogs
   * from each (1h cache) and unions them on `list_creative_formats`. Self-hosting
   * sellers point at their own `agent_url`; framework calls into their
   * `CreativePlatform.listFormats()` locally instead of HTTP-fetching.
   *
   * `format_ids` filter (optional) subsets a single creative agent's catalog.
   * Useful when a creative agent hosts 50 formats but this seller only accepts
   * 10 of them. Filter scope is per-creative-agent: `[{ agent_url: A, format_ids: ['x'] }, { agent_url: B }]`
   * means "from A only format x; from B all formats."
   */
  creative_agents: CreativeAgentRef[];

  /** Channels this platform sells. */
  channels: MediaChannel[];

  /** Pricing models this platform supports. */
  pricingModels: PricingModel[];

  /** Targeting capabilities. Optional — framework infers reasonable defaults if omitted. */
  targeting?: TargetingCapabilities;

  /** Reporting capabilities. Optional — framework infers reasonable defaults if omitted. */
  reporting?: ReportingCapabilities;

  /**
   * Platform-specific config. Strongly typed when the adopter uses the generic.
   * Example: `class GAM extends DecisioningPlatform<{ networkId: string }>`.
   */
  config: TConfig;

  /**
   * Optional Zod schema for runtime validation of `config`. When provided,
   * framework validates at platform construction time; missing or wrong-shaped
   * config rejects the agent at boot rather than at first request.
   */
  configSchema?: ZodSchema<TConfig>;
}

export interface CreativeAgentRef {
  agent_url: string;
  /** Human-readable label for this creative agent. */
  name?: string;
  /** Optional allowlist of `format_id.id` values from THIS agent's catalog. Omit to include all. */
  format_ids?: string[];
}

export interface TargetingCapabilities {
  geos?: ('country' | 'region' | 'metro' | 'city' | 'postal_code')[];
  audiences?: 'first_party' | 'third_party' | 'both' | 'none';
  dayparting?: 'hour' | 'half-hour' | 'minute';
  frequency_capping?: boolean;
  contextual?: boolean;
  device_targeting?: boolean;
}

export interface ReportingCapabilities {
  frequencies: ('hourly' | 'daily' | 'weekly')[];
  expected_delay_minutes: number;
  timezone: string;
  metrics: string[];
  date_range_support: 'date_range' | 'fixed_only';
  supports_webhooks: boolean;
}
