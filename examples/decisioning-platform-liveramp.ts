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
} from '@adcp/client/server/decisioning';
import type {
  AudiencePlatform,
  Audience,
  AudienceStatus,
  SyncAudiencesRow,
} from '@adcp/client/server/decisioning';
import type { AccountReference } from '@adcp/client/types';

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
  [key: string]: unknown;
}

/**
 * Internal lifecycle stages — richer than the wire `AudienceStatus` enum
 * (`'processing' | 'ready' | 'too_small'`). The internal stages flow
 * through `publishStatusChange.payload` (freeform JSON) so buyers
 * subscribed to the bus see `matched_count`, `match_rate`, and the
 * stage transitions. The wire-shaped `getAudienceStatus` collapses
 * back to the spec enum.
 */
type LiveRampStage = 'matching' | 'matched' | 'activating' | 'active' | 'failed';

function toWireStatus(stage: LiveRampStage): AudienceStatus {
  switch (stage) {
    case 'active':
      return 'ready';
    case 'failed':
      return 'too_small';
    default:
      return 'processing';
  }
}

type AudienceState = {
  audience_id: string;
  stage: LiveRampStage;
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
        name: `LiveRamp — ${id}`,
        status: 'active',
        operator: 'liveramp.example.com',
        metadata: { ramp_id: 'XR-12345' },
        authInfo: { kind: 'api_key' },
      };
    },
  };

  audiences: AudiencePlatform<LiveRampMeta> = {
    /**
     * Sync acknowledgment: return current state for each audience. Match
     * pipeline + activation pipeline run in background and emit
     * publishStatusChange events as each audience progresses through the
     * richer internal stages (`matching` → `matched` → `activating` →
     * `active`). Buyers subscribed to the status-change bus see the full
     * lifecycle; buyers polling `getAudienceStatus` see the wire-flat
     * `processing | ready | too_small`.
     */
    syncAudiences: async (audiences: Audience[]): Promise<SyncAudiencesRow[]> => {
      const results: SyncAudiencesRow[] = [];
      const accountId = 'liveramp_acc_1';

      for (const aud of audiences) {
        const audienceId = (aud as { audience_id?: string }).audience_id ?? `aud_${Math.random()}`;
        const identifiers = ((aud as { identifiers?: unknown[] }).identifiers ?? []) as unknown[];

        if (identifiers.length < this.capabilities.config.minIdentifiers) {
          this.audienceState.set(audienceId, { audience_id: audienceId, stage: 'failed' });
          results.push({
            audience_id: audienceId,
            action: 'failed',
            status: 'too_small',
          });
          continue;
        }

        const isUpdate = this.audienceState.has(audienceId);
        const initial: AudienceState = { audience_id: audienceId, stage: 'matching' };
        this.audienceState.set(audienceId, initial);

        // Schedule match → matched
        setTimeout(() => {
          const matched = Math.floor(identifiers.length * this.capabilities.config.defaultMatchRate);
          const next: AudienceState = {
            audience_id: audienceId,
            stage: 'matched',
            matched_count: matched,
            match_rate: this.capabilities.config.defaultMatchRate,
          };
          this.audienceState.set(audienceId, next);
          publishStatusChange({
            account_id: accountId,
            resource_type: 'audience',
            resource_id: audienceId,
            payload: {
              stage: 'matched',
              status: 'processing',
              matched_count: matched,
              match_rate: this.capabilities.config.defaultMatchRate,
            },
          });

          // Schedule matched → activating → active
          setTimeout(() => {
            this.audienceState.set(audienceId, { ...next, stage: 'activating' });
            publishStatusChange({
              account_id: accountId,
              resource_type: 'audience',
              resource_id: audienceId,
              payload: { stage: 'activating', status: 'processing' },
            });

            setTimeout(() => {
              this.audienceState.set(audienceId, { ...next, stage: 'active' });
              publishStatusChange({
                account_id: accountId,
                resource_type: 'audience',
                resource_id: audienceId,
                payload: { stage: 'active', status: 'ready' },
              });
            }, this.capabilities.config.activationLatencyMs).unref?.();
          }, 10).unref?.();
        }, this.capabilities.config.matchLatencyMs).unref?.();

        results.push({
          audience_id: audienceId,
          action: isUpdate ? 'updated' : 'created',
          status: 'processing',
          matched_count: 0,
          effective_match_rate: 0,
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
      return toWireStatus(state.stage);
    },
  };
}
