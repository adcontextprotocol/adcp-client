import { isDeepStrictEqual } from 'node:util';

import type { TargetingOverlayInput } from '../types/core.generated';

export type TargetingConformanceOperation = 'create' | 'update';
export type TargetingConformanceOutcome = 'accepted' | 'rejected';

export interface TargetingDimensionSample<T> {
  /** Strict configured/stored value used as the vector baseline. */
  initialValue: NonNullable<T>;
  /** Distinct valid request value used to prove complete replacement. */
  replacementValue: NonNullable<T>;
  /** Canonical readback value when it differs from the request value. */
  expectedReplacementValue?: NonNullable<T>;
  /** Whole canonical readback state for cross-dimension materialization. */
  expectedReplacementState?: Record<string, unknown>;
  /** Override for products that cannot execute a clear against inherent scope. */
  expectedNullOutcome?: TargetingConformanceOutcome;
  /** Override for replacements that require renegotiation in the selected fixture. */
  expectedReplacementOutcome?: TargetingConformanceOutcome;
}

export type TargetingDimensionSamples = {
  [K in keyof TargetingOverlayInput]?: TargetingDimensionSample<TargetingOverlayInput[K]>;
};

type RuntimeTargetingDimensionSample = {
  initialValue: unknown;
  replacementValue: unknown;
  expectedReplacementValue?: unknown;
  expectedReplacementState?: Record<string, unknown>;
  expectedNullOutcome?: TargetingConformanceOutcome;
  expectedReplacementOutcome?: TargetingConformanceOutcome;
};

export interface TargetingInputConformanceVector {
  id: string;
  operation: TargetingConformanceOperation;
  dimension?: keyof TargetingOverlayInput & string;
  baseline?: Record<string, unknown>;
  /** Present request overlay; `{}` means this dimension was omitted. */
  input?: Record<string, unknown>;
  expectedOutcome: TargetingConformanceOutcome;
  /** Accepted strict state, unchanged update state, or absent state after a rejected create. */
  expectedState: Record<string, unknown> | undefined;
  description: string;
}

export interface TargetingInputConformanceObservation {
  outcome: TargetingConformanceOutcome;
  /** Strict durable/readback state after the attempted operation. */
  state?: Record<string, unknown>;
  /** Exact request-only overlay observed at the seller/provider dispatch seam. */
  dispatchedInput?: Record<string, unknown>;
}

export interface TargetingInputConformanceAdapter {
  create(vector: TargetingInputConformanceVector): Promise<TargetingInputConformanceObservation>;
  update(vector: TargetingInputConformanceVector): Promise<TargetingInputConformanceObservation>;
}

export interface TargetingInputConformanceOptions {
  /** Override when a seller has a documented canonical ordering/materialization policy. */
  compareState?: (
    observed: Record<string, unknown> | undefined,
    expected: Record<string, unknown> | undefined,
    vector: TargetingInputConformanceVector
  ) => boolean;
}

export interface TargetingInputConformanceCaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  vector: TargetingInputConformanceVector;
  observation?: TargetingInputConformanceObservation;
}

export interface TargetingInputConformanceReport {
  passed: boolean;
  cases: TargetingInputConformanceCaseResult[];
}

/**
 * Generate create/update omit, null, and value vectors for every supplied
 * targeting dimension. Samples are schema-typed and share one multi-dimension
 * baseline so the corpus catches adapters that clear unrelated omitted axes.
 */
export function buildTargetingInputConformanceVectors(
  samples: TargetingDimensionSamples
): TargetingInputConformanceVector[] {
  const entries = Object.entries(samples).filter(([, sample]) => sample !== undefined) as Array<
    [string, RuntimeTargetingDimensionSample]
  >;
  const baseline = Object.fromEntries(entries.map(([dimension, sample]) => [dimension, clone(sample.initialValue)]));
  const vectors: TargetingInputConformanceVector[] = [];

  for (const [dimension, sample] of entries) {
    const clearedState = withoutKey(baseline, dimension);
    const replacementState = sample.expectedReplacementState
      ? clone(sample.expectedReplacementState)
      : {
          ...clone(baseline),
          [dimension]: clone(sample.expectedReplacementValue ?? sample.replacementValue),
        };
    for (const operation of ['create', 'update'] as const) {
      const omittedMeaning = operation === 'create' ? 'inherits configured/product defaults' : 'preserves stored state';
      const nullOutcome = sample.expectedNullOutcome ?? 'accepted';
      const replacementOutcome = sample.expectedReplacementOutcome ?? 'accepted';
      const rejectedState = operation === 'create' ? undefined : baseline;
      vectors.push(
        {
          id: `${operation}/${dimension}/omitted`,
          operation,
          dimension: dimension as keyof TargetingOverlayInput & string,
          baseline: clone(baseline),
          input: {},
          expectedOutcome: 'accepted',
          expectedState: clone(baseline),
          description: `${operation}: omitted ${dimension} ${omittedMeaning}`,
        },
        {
          id: `${operation}/${dimension}/null`,
          operation,
          dimension: dimension as keyof TargetingOverlayInput & string,
          baseline: clone(baseline),
          input: { [dimension]: null },
          expectedOutcome: nullOutcome,
          expectedState: clone(nullOutcome === 'accepted' ? clearedState : rejectedState),
          description: `${operation}: null ${dimension} clears/suppresses only that effective dimension`,
        },
        {
          id: `${operation}/${dimension}/value`,
          operation,
          dimension: dimension as keyof TargetingOverlayInput & string,
          baseline: clone(baseline),
          input: { [dimension]: clone(sample.replacementValue) },
          expectedOutcome: replacementOutcome,
          expectedState: clone(replacementOutcome === 'accepted' ? replacementState : rejectedState),
          description: `${operation}: a non-null ${dimension} value replaces only that complete dimension`,
        }
      );
    }
  }
  return vectors;
}

/**
 * Cross-dimension vectors requested by the targeting command-state contract:
 * an omitted region axis is preserved, and an invalid combined projection is
 * rejected without mutating either stored axis.
 */
export const TARGETING_GEOGRAPHY_CONFORMANCE_VECTORS: readonly TargetingInputConformanceVector[] = deepFreeze([
  {
    id: 'update/geo_countries/preserve-compatible-regions',
    operation: 'update',
    baseline: { geo_countries: ['US'], geo_regions: ['US-NY'] },
    input: { geo_countries: ['US', 'CA'] },
    expectedOutcome: 'accepted',
    expectedState: { geo_countries: ['US', 'CA'], geo_regions: ['US-NY'] },
    description: 'Changing countries preserves an omitted compatible geo_regions dimension.',
  },
  {
    id: 'update/geo_countries/reject-incompatible-preserved-regions',
    operation: 'update',
    baseline: { geo_countries: ['US'], geo_regions: ['US-NY'] },
    input: { geo_countries: ['CA'] },
    expectedOutcome: 'rejected',
    expectedState: { geo_countries: ['US'], geo_regions: ['US-NY'] },
    description: 'An invalid country/region result is rejected atomically instead of clearing the omitted region axis.',
  },
]);

/** Run vectors through distinct create and update adapter seams. */
export async function runTargetingInputConformance(
  vectors: readonly TargetingInputConformanceVector[],
  adapter: TargetingInputConformanceAdapter,
  options: TargetingInputConformanceOptions = {}
): Promise<TargetingInputConformanceReport> {
  if (vectors.length === 0) throw new TypeError('Targeting conformance requires at least one vector.');
  const compareState = options.compareState ?? defaultStateComparison;
  const cases: TargetingInputConformanceCaseResult[] = [];

  for (const sourceVector of vectors) {
    const vector = clone(sourceVector);
    const failures: string[] = [];
    try {
      const observation = await adapter[vector.operation](clone(vector));
      if (observation.outcome !== vector.expectedOutcome) {
        failures.push(`expected ${vector.expectedOutcome}, observed ${observation.outcome}`);
      }
      if (!compareState(observation.state, vector.expectedState, vector)) {
        failures.push(
          `strict state mismatch: expected ${formatDiagnosticValue(vector.expectedState)}, observed ${formatDiagnosticValue(observation.state)}`
        );
      }
      if (containsNull(observation.state)) {
        failures.push('durable/readback state retained a request-only null command');
      }
      if (observation.outcome === 'accepted' && !isDeepStrictEqual(observation.dispatchedInput, vector.input)) {
        failures.push(
          `dispatch changed the request overlay: expected ${formatDiagnosticValue(vector.input)}, observed ${formatDiagnosticValue(observation.dispatchedInput)}`
        );
      }
      cases.push({ id: vector.id, passed: failures.length === 0, failures, vector, observation });
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      failures.push(`adapter execution failed (${name}); inspect adapter logs for details`);
      cases.push({ id: vector.id, passed: false, failures, vector });
    }
  }
  return { passed: cases.every(result => result.passed), cases };
}

function defaultStateComparison(
  observed: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined
): boolean {
  return isDeepStrictEqual(normalizeEmptyState(observed), normalizeEmptyState(expected));
}

function normalizeEmptyState(state: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return state && Object.keys(state).length === 0 ? undefined : state;
}

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  return typeof value === 'object' && Object.values(value).some(containsNull);
}

function withoutKey(state: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const result = Object.fromEntries(Object.entries(state).filter(([candidate]) => candidate !== key));
  return Object.keys(result).length === 0 ? undefined : result;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function formatDiagnosticValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
