import type { Storyboard, StoryboardStep } from '../types';
import { loadRequestSigningVectors, type LoadVectorsOptions } from './vector-loader';
import type { NegativeVector, PositiveVector } from './types';

export const REQUEST_SIGNING_PROBE_TASK = 'request_signing_probe';
export const POSITIVE_STEP_PREFIX = 'positive-';
export const NEGATIVE_STEP_PREFIX = 'negative-';

export interface SynthesizeOptions extends LoadVectorsOptions {
  /** Vector IDs to omit (e.g., capability-profile mismatches). */
  skipVectors?: string[];
}

/**
 * Expand the `positive_vectors` and `negative_vectors` phases of the
 * signed-requests specialism with one synthesized step per fixture. The YAML
 * deliberately ships these phases with empty step lists — steps are generated
 * from the cached test-vector fixtures so a runner can grade any advertising
 * agent without duplicating fixture data in the spec.
 *
 * Returns the input storyboard unchanged if it isn't signed-requests.
 */
export function synthesizeRequestSigningSteps(storyboard: Storyboard, options: SynthesizeOptions = {}): Storyboard {
  if (storyboard.id !== 'signed_requests') return storyboard;

  const loaded = loadRequestSigningVectors(options);
  const skip = new Set(options.skipVectors ?? []);

  const phases = storyboard.phases.map(phase => {
    if (phase.id === 'positive_vectors') {
      return { ...phase, steps: loaded.positive.filter(v => !skip.has(v.id)).map(synthesizePositiveStep) };
    }
    if (phase.id === 'negative_vectors') {
      return { ...phase, steps: loaded.negative.filter(v => !skip.has(v.id)).map(synthesizeNegativeStep) };
    }
    return phase;
  });

  return { ...storyboard, phases };
}

function synthesizePositiveStep(vector: PositiveVector): StoryboardStep {
  return {
    id: `${POSITIVE_STEP_PREFIX}${vector.id}`,
    title: `Positive: ${vector.name}`,
    task: REQUEST_SIGNING_PROBE_TASK,
    narrative: `Sign vector ${vector.id} per its component list and send to the agent; accept on 2xx.`,
    validations: [
      {
        check: 'http_status_in',
        allowed_values: [200, 201, 202, 203, 204],
        description: `Agent accepts positive vector ${vector.id}`,
      },
    ],
  };
}

function synthesizeNegativeStep(vector: NegativeVector): StoryboardStep {
  return {
    id: `${NEGATIVE_STEP_PREFIX}${vector.id}`,
    title: `Negative: ${vector.name}`,
    task: REQUEST_SIGNING_PROBE_TASK,
    narrative:
      `Build vector ${vector.id} with its documented mutation and send to the agent; ` +
      `expect 401 with WWW-Authenticate: Signature error="${vector.expected_error_code}".`,
    validations: [
      {
        check: 'http_status',
        value: 401,
        description: `Rejection status for ${vector.id}`,
      },
    ],
  };
}

/**
 * Parse the synthesized step ID back into the vector id + kind so the probe
 * dispatch can look up the fixture.
 */
export function parseRequestSigningStepId(
  stepId: string
): { kind: 'positive' | 'negative'; vector_id: string } | undefined {
  if (stepId.startsWith(POSITIVE_STEP_PREFIX)) {
    return { kind: 'positive', vector_id: stepId.slice(POSITIVE_STEP_PREFIX.length) };
  }
  if (stepId.startsWith(NEGATIVE_STEP_PREFIX)) {
    return { kind: 'negative', vector_id: stepId.slice(NEGATIVE_STEP_PREFIX.length) };
  }
  return undefined;
}
