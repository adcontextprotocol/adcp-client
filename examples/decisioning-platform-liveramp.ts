/**
 * LiveRampAudienceProvider — worked example for `audience-sync`.
 *
 * Identity-graph providers like LiveRamp / Oracle Data Cloud / Salesforce
 * CDP have a long-tail activation pipeline: ingest → match → activate to
 * destinations. Match takes 5-30 minutes; activation per destination
 * takes hours. Buyers can't usefully wait synchronously, but they DO
 * want immediate confirmation that the audience was accepted and to know
 * when it's ready.
 *
 * The v2.1 shape is:
 *
 *   - Sync `syncAudiences` returns per-audience rows with the *current*
 *     state (`pending` / `matching` is fine — the buyer's audience_id
 *     is now known and they can subscribe for updates).
 *   - `publishStatusChange({ resource_type: 'audience', ... })` fires from
 *     the match-pipeline + activation-pipeline as each audience reaches
 *     `matched` → `activating` → `active`.
 *
 * `AdcpError` for buyer-fixable rejection (`AUDIENCE_TOO_SMALL`,
 * insufficient identifiers, etc.).
 *
 * @see `docs/proposals/decisioning-platform-v2-hitl-split.md`
 */

import {
  AdcpError,
  publishStatusChange,
  type DecisioningPlatform,
  type AccountStore,
} from '../src/lib/server/decisioning';
import type {
  AudiencePlatform,
  Audience,
  AudienceStatus,
  AudienceSyncResult,
} from '../src/lib/server/decisioning/specialisms/audiences';
import type { AccountReference } from '../src/lib/types/tools.generated';

// ---------------------------------------------------------------------------
// Config + state
// ---------------------------------------------------------------------------

export interface LiveRampConfig {
  /** Minimum identifier count before activation; audiences below this reject. */
  minIdentifiers: number;
  /** Identity-graph match latency (ms). */
  matchLatencyMs: number;
  /** Per-destination activation latency (ms). */
  activationLatencyMs: number;
  /** Default match rate the demo simulates. */
  defaultMatchRate: number;
}

interface LiveRampMeta {
  ramp_id: string;
}

type AudienceState = {
  audience_id: string;
  status: AudienceStatus;
  matched_count?: number;
  match_rate?: number;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LiveRampAudienceProvider implements DecisioningPlatform<LiveRampConfig, LiveRampMeta> {
  private audienceState = new Map<string, AudienceState>();

  capabilities = {
    specialisms: ['audience-sync'] as const,
    creative_agents: [],
    channels: [] as const,
    pricingModels: ['cpm'] as const,
    config: {
      minIdentifiers: 100,
      matchLatencyMs: 60,
      activationLatencyMs: 80,
      defaultMatchRate: 0.42,
    } satisfies LiveRampConfig,
  };

  statusMappers = {};

  accounts: AccountStore<LiveRampMeta> = {
    resolve: async (ref: AccountReference) => {
      const id = 'account_id' in ref ? ref.account_id : 'liveramp_acc_1';
      return {
        id,
        operator: 'liveramp.example.com',
        metadata: { ramp_id: 'XR-12345' },
        authInfo: { kind: 'api_key' },
      };
    },
    upsert: async () => [],
    list: async () => ({ items: [], nextCursor: null }),
  };

  audiences_platform: AudiencePlatform = {
    /**
     * Sync acknowledgment: return current state for each audience. Match
     * pipeline + activation pipeline run in background and emit
     * publishStatusChange events as each audience progresses.
     */
    syncAudiences: async (audiences: Audience[]): Promise<AudienceSyncResult[]> => {
      const results: AudienceSyncResult[] = [];
      const accountId = 'liveramp_acc_1';

      for (const aud of audiences) {
        const audienceId = (aud as { audience_id?: string }).audience_id ?? `aud_${Math.random()}`;
        const identifiers = ((aud as { identifiers?: unknown[] }).identifiers ?? []) as unknown[];

        if (identifiers.length < this.capabilities.config.minIdentifiers) {
          results.push({
            audience_id: audienceId,
            action: 'rejected',
            status: 'failed',
            reason: `Audience too small: ${identifiers.length} identifiers (minimum ${this.capabilities.config.minIdentifiers})`,
          });
          continue;
        }

        const isUpdate = this.audienceState.has(audienceId);
        const initial: AudienceState = { audience_id: audienceId, status: 'matching' };
        this.audienceState.set(audienceId, initial);

        // Schedule match → matched
        setTimeout(() => {
          const matched = Math.floor(identifiers.length * this.capabilities.config.defaultMatchRate);
          const next: AudienceState = {
            audience_id: audienceId,
            status: 'matched',
            matched_count: matched,
            match_rate: this.capabilities.config.defaultMatchRate,
          };
          this.audienceState.set(audienceId, next);
          publishStatusChange({
            account_id: accountId,
            resource_type: 'audience',
            resource_id: audienceId,
            payload: {
              status: 'matched',
              matched_count: matched,
              match_rate: this.capabilities.config.defaultMatchRate,
            },
          });

          // Schedule matched → activating → active
          setTimeout(() => {
            this.audienceState.set(audienceId, { ...next, status: 'activating' });
            publishStatusChange({
              account_id: accountId,
              resource_type: 'audience',
              resource_id: audienceId,
              payload: { status: 'activating' },
            });

            setTimeout(() => {
              this.audienceState.set(audienceId, { ...next, status: 'active' });
              publishStatusChange({
                account_id: accountId,
                resource_type: 'audience',
                resource_id: audienceId,
                payload: { status: 'active' },
              });
            }, this.capabilities.config.activationLatencyMs).unref?.();
          }, 10).unref?.();
        }, this.capabilities.config.matchLatencyMs).unref?.();

        results.push({
          audience_id: audienceId,
          action: isUpdate ? 'updated' : 'created',
          status: 'matching',
          matched_count: 0,
          match_rate: 0,
        });
      }

      return results;
    },

    getAudienceStatus: async (audienceId: string): Promise<AudienceStatus> => {
      const state = this.audienceState.get(audienceId);
      if (!state) {
        throw new AdcpError('REFERENCE_NOT_FOUND', {
          recovery: 'terminal',
          message: `Audience ${audienceId} not found`,
          field: 'audience_id',
        });
      }
      return state.status;
    },
  };

  // The DecisioningPlatform interface uses the field name `audiences` for
  // the AudiencePlatform — alias the implementation onto that field.
  get audiences(): AudiencePlatform {
    return this.audiences_platform;
  }
}
