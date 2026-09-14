import type {
  CanonicalMediaBuyAction,
  CanonicalProductAction,
  MediaBuyChangeTerm,
  MediaBuyChangeTermConstraints,
  MediaBuyStatus,
} from '../types/core.generated';
import type { MediaBuyActionContext, MediaBuyActionId, MediaBuyActionMode, SLAWindow } from './types';

/** Explicit task vocabulary; update_media_buy is the established 3.1 default. */
export type MediaBuyTask = 'update_media_buy' | 'control_media_buy' | 'refine_proposals' | 'sync_creatives';
/** Includes the rc.3 shared-cap action without adopting unrelated generated schema changes. */
export type MediaBuyAction = MediaBuyActionId | CanonicalMediaBuyAction['action'] | 'update_media_buy_frequency_cap';
export type ProductActionTemplate = Pick<
  CanonicalProductAction,
  'modes' | 'allowed_statuses' | 'sla' | 'constraints' | 'terms_ref'
> & { action: MediaBuyAction };
export type ProposalChangeTerm = Pick<
  MediaBuyChangeTerm,
  | 'term_id'
  | 'service_mode'
  | 'allowed_statuses'
  | 'processing_sla'
  | 'conditions'
  | 'constraints'
  | 'terms_ref'
  | 'description'
  | 'ext'
> & { action: MediaBuyAction };
/** Portable ergonomic view of the schema's anyOf constraint variants. */
export type ChangeTermConstraints =
  | {
      kind: 'budget';
      max_delta_amount?: ChangeMoney;
      max_delta_percent?: number;
      min_result_amount?: ChangeMoney;
      max_result_amount?: ChangeMoney;
    }
  | {
      kind: 'flight';
      max_change?: ChangeDuration;
      earliest_result?: string;
      latest_result?: string;
      minimum_notice?: ChangeDuration;
    }
  | { kind: 'package_count'; max_additions?: number; max_removals?: number; max_result_count?: number }
  | {
      kind: 'effective_timing';
      minimum_notice?: ChangeDuration;
      earliest_effective_at?: string;
      latest_effective_at?: string;
    };
export interface ChangeMoney {
  amount: number;
  currency: string;
}
export interface ChangeDuration {
  interval: number;
  unit: 'seconds' | 'minutes' | 'hours' | 'days' | 'campaign';
}
export type { MediaBuyStatus };

/** A readable wire entry, including the established 3.1 shape without task. */
export interface LiveMediaBuyAction {
  action: MediaBuyAction;
  mode: MediaBuyActionMode;
  task?: MediaBuyTask;
  sla?: SLAWindow;
  /** rc.3 exact package scope. Omission means all relevant packages. */
  applicable_package_ids?: readonly string[];
  change_term_id?: string;
  /** Opaque in 3.1. Equality is checked only with an explicitly declared 3.2 alias projection. */
  terms_ref?: string;
}
export interface ActionProduct {
  product_id?: string;
  allowed_actions?: readonly ProductActionTemplate[];
}
export interface ActionProposal {
  proposal_id?: string;
  proposal_status?: string;
  media_buy_id?: string;
  commercial_terms?: { change_terms?: readonly ProposalChangeTerm[] };
}
export interface ActionBuy extends Omit<MediaBuyActionContext, 'available_actions'> {
  available_actions?: readonly LiveMediaBuyAction[];
  accepted_proposal?: ActionProposal;
  accepted_proposal_id?: string;
}

export type ConstraintAssessment =
  | { status: 'satisfied' }
  | { status: 'unknown'; constraint: string; path: string; message: string }
  | { status: 'exceeded'; constraint: string; path: string; message: string };

export type ProductActionAssessment =
  | { status: 'possible'; template: ProductActionTemplate; binding: false }
  | { status: 'unsupported'; binding: false }
  | { status: 'unknown'; binding: false; message: string };
export type ProposalActionAssessment =
  | { status: 'promised'; term: ProposalChangeTerm }
  | { status: 'not_negotiated' }
  | { status: 'unknown'; message: string };
