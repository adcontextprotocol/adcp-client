import type { ActivateSignalRequest, GetSignalsResponse, SignalID } from '../types/tools.generated';
import { getSignalId, getSignalIssuer } from './signal-id-builders';
import type { MutatingRequestInput } from './idempotency';

export type DiscoveredSignal = NonNullable<GetSignalsResponse['signals']>[number];

export interface NormalizedDiscoveredSignal {
  /** Original get_signals row. Preserved so helpers never hide seller data. */
  raw: DiscoveredSignal;
  /** Canonical value to pass as activate_signal.signal_agent_segment_id. */
  signalAgentSegmentId: string;
  /** Provenance object returned as signal_id, when the seller provides one. */
  signalId?: SignalID;
  /** signal_id.id, when signal_id is present. Not the activation key. */
  signalIdValue?: string;
  /** signal_id.source, when signal_id is present. */
  signalSource?: SignalID['source'];
  /** data_provider_domain for catalog signals, agent_url for agent-native signals. */
  signalIssuer?: string;
  /** pricing_options[].pricing_option_id values in response order. */
  pricingOptionIds: string[];
  /** Governance metadata copied from the signal row when present. */
  restrictedAttributes: string[];
  /** Governance metadata copied from the signal row when present. */
  policyCategories: string[];
}

export type BuildActivateSignalRequestOptions = Omit<
  MutatingRequestInput<ActivateSignalRequest>,
  'signal_agent_segment_id' | 'pricing_option_id'
> & {
  /** Snake-case wire field. Takes precedence over pricingOptionId when both are present. */
  pricing_option_id?: string;
  /** Camel-case convenience alias for pricing_option_id. */
  pricingOptionId?: string;
};

/**
 * Normalize one `get_signals` row into the semantic fields buyers need for
 * the next call. The important invariant: `signalAgentSegmentId` is the
 * activation handle; nested `signalId` is provenance and may differ.
 */
export function normalizeDiscoveredSignal(signal: DiscoveredSignal): NormalizedDiscoveredSignal {
  const signalAgentSegmentId = getSignalActivationId(signal);
  const signalId = readSignalId(signal);
  const pricingOptionIds = getSignalPricingOptionIds(signal);

  return {
    raw: signal,
    signalAgentSegmentId,
    ...(signalId && {
      signalId,
      signalIdValue: getSignalId(signalId),
      signalSource: signalId.source,
      signalIssuer: getSignalIssuer(signalId),
    }),
    pricingOptionIds,
    restrictedAttributes: readStringArray(signal, 'restricted_attributes'),
    policyCategories: readStringArray(signal, 'policy_categories'),
  };
}

/**
 * Build an `activate_signal` request from a discovered signal row. The
 * returned object is suitable for `agent.activateSignal(...)`; the SDK will
 * inject `idempotency_key` unless the caller supplied one.
 */
export function buildActivateSignalRequest(
  signal: DiscoveredSignal | NormalizedDiscoveredSignal,
  options: BuildActivateSignalRequestOptions
): MutatingRequestInput<ActivateSignalRequest> {
  const normalized = isNormalizedDiscoveredSignal(signal) ? signal : normalizeDiscoveredSignal(signal);
  const { pricingOptionId, ...wireOptions } = options;
  const pricing_option_id = wireOptions.pricing_option_id ?? pricingOptionId;

  return {
    ...wireOptions,
    signal_agent_segment_id: normalized.signalAgentSegmentId,
    ...(pricing_option_id !== undefined && { pricing_option_id }),
  };
}

/** Return the canonical activation handle from one `get_signals` row. */
export function getSignalActivationId(signal: DiscoveredSignal): string {
  const value = (signal as { signal_agent_segment_id?: unknown }).signal_agent_segment_id;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error('getSignalActivationId: signal.signal_agent_segment_id is required.');
}

/** Return pricing option ids from one discovered signal, preserving response order. */
export function getSignalPricingOptionIds(signal: DiscoveredSignal): string[] {
  const pricingOptions = (signal as { pricing_options?: unknown }).pricing_options;
  if (!Array.isArray(pricingOptions)) return [];
  return pricingOptions
    .map(option =>
      option && typeof option === 'object' ? (option as { pricing_option_id?: unknown }).pricing_option_id : undefined
    )
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function isNormalizedDiscoveredSignal(
  signal: DiscoveredSignal | NormalizedDiscoveredSignal
): signal is NormalizedDiscoveredSignal {
  return (
    signal != null &&
    typeof signal === 'object' &&
    'raw' in signal &&
    typeof (signal as { signalAgentSegmentId?: unknown }).signalAgentSegmentId === 'string'
  );
}

function readSignalId(signal: DiscoveredSignal): SignalID | undefined {
  const value = (signal as { signal_id?: unknown }).signal_id;
  if (isSignalId(value)) return value;
  return undefined;
}

function isSignalId(value: unknown): value is SignalID {
  if (!value || typeof value !== 'object') return false;
  const source = (value as { source?: unknown }).source;
  if (source === 'catalog') {
    return (
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { data_provider_domain?: unknown }).data_provider_domain === 'string'
    );
  }
  if (source === 'agent') {
    return (
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { agent_url?: unknown }).agent_url === 'string'
    );
  }
  return false;
}

function readStringArray(signal: DiscoveredSignal, field: 'restricted_attributes' | 'policy_categories'): string[] {
  const value = (signal as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
