/**
 * Webhook-assertion pseudo-tasks.
 *
 * Three step `task` values graded by observing the runner's webhook
 * receiver rather than by calling the agent:
 *
 *   - `expect_webhook`
 *       Assert at least one matching webhook arrived carrying a
 *       well-formed `idempotency_key`. Optional: body-schema validation and
 *       max-deliveries-per-logical-event cap (catches duplicate-side-effect
 *       bugs on replay).
 *
 *   - `expect_webhook_retry_keys_stable`
 *       Configure the receiver to reject the first N deliveries with 5xx so
 *       the sender retries, then assert every delivery within the window
 *       carries the byte-identical `idempotency_key` (a key rotation across
 *       retries breaks at-least-once delivery semantics).
 *
 *   - `expect_webhook_signature_valid`
 *       Delegate to the @adcp/client 9421 webhook verifier (pending; grades
 *       `not_applicable` until the client verifier lands). Asserts the
 *       arriving webhook verifies under the `adcp/webhook-signing/v1` profile.
 *
 * Spec: adcontextprotocol/adcp#2431 (storyboard-schema.yaml webhook section).
 */

import { randomUUID } from 'node:crypto';
import { injectContext, type RunnerVariables } from './context';
import type {
  HttpProbeResult,
  RunnerExtractionRecord,
  RunnerRequestRecord,
  Storyboard,
  StoryboardContext,
  StoryboardRunOptions,
  StoryboardStep,
  StoryboardStepPreview,
  StoryboardStepResult,
  ValidationResult,
  WebhookAssertionErrorCode,
} from './types';
import { WEBHOOK_IDEMPOTENCY_KEY_PATTERN } from './types';
import type { CapturedWebhook, RetryReplayPolicy, WebhookFilter, WebhookReceiver } from './webhook-receiver';
import { verifyWebhookSignature } from '../../signing/webhook-verifier';
import { WebhookSignatureError } from '../../signing/errors';
import { InMemoryReplayStore, type ReplayStore } from '../../signing/replay';
import { InMemoryRevocationStore, type RevocationStore } from '../../signing/revocation';
import type { RequestLike } from '../../signing/canonicalize';

const RUN_STATE_REPLAY_KEY = '__webhook_signing_replay_store';
const RUN_STATE_REVOCATION_KEY = '__webhook_signing_revocation_store';

/**
 * Return a replay store that's shared for the rest of this run, so a
 * replayed `(keyid, nonce)` across two deliveries of the same event is
 * detected. Lazy-constructed on first use so runs without signature
 * assertions pay zero cost. Explicit caller-supplied stores take
 * precedence — operators who want durable cross-run detection wire their
 * own store via `options.webhook_signing.replayStore`.
 */
function getSharedReplayStore(
  runnerVars: RunnerVariables,
  override: ReplayStore | undefined
): ReplayStore {
  if (override) return override;
  const existing = runnerVars.runState.get(RUN_STATE_REPLAY_KEY);
  if (existing) return existing as ReplayStore;
  const store = new InMemoryReplayStore();
  runnerVars.runState.set(RUN_STATE_REPLAY_KEY, store);
  return store;
}

function getSharedRevocationStore(
  runnerVars: RunnerVariables,
  override: RevocationStore | undefined
): RevocationStore {
  if (override) return override;
  const existing = runnerVars.runState.get(RUN_STATE_REVOCATION_KEY);
  if (existing) return existing as RevocationStore;
  const store = new InMemoryRevocationStore();
  runnerVars.runState.set(RUN_STATE_REVOCATION_KEY, store);
  return store;
}

export const WEBHOOK_ASSERTION_TASKS: Set<string> = new Set([
  'expect_webhook',
  'expect_webhook_retry_keys_stable',
  'expect_webhook_signature_valid',
]);

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_RETRY_REPLAY_TIMEOUT_SECONDS = 90;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_HTTP_STATUS = 503;
const DEFAULT_MIN_DELIVERIES = 2;
const DEFAULT_WEBHOOK_SIGNING_TAG = 'adcp/webhook-signing/v1';

/**
 * Caps on storyboard-declared knobs. Storyboards are data; treat their
 * fields as untrusted when they drive network behavior against a real
 * seller. A typo'd `retry_trigger.count: 1_000_000` would otherwise turn
 * the runner into a DoS amplifier; a `timeout_seconds: 86400` would wedge
 * CI for a day. Clamps here fail-safe (use the max, don't reject) so a
 * compliance run never dies on a storyboard author's fat-fingered YAML.
 */
const MAX_RETRY_REPLAY_COUNT = 10;
const MAX_TIMEOUT_SECONDS = 300;
/** HTTP statuses the retry-replay policy may return. 429 + 5xx are the
 * shapes any conformant at-least-once sender treats as retryable. */
const ALLOWED_RETRY_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

function clampTimeoutSeconds(raw: number | undefined, fallback: number): number {
  const resolved = typeof raw === 'number' && raw > 0 ? raw : fallback;
  return Math.min(resolved, MAX_TIMEOUT_SECONDS);
}

function clampRetryPolicy(spec: { count?: number; http_status?: number } | undefined): {
  count: number;
  http_status: number;
} {
  const requestedCount = spec?.count ?? DEFAULT_RETRY_COUNT;
  const count = Math.max(1, Math.min(requestedCount, MAX_RETRY_REPLAY_COUNT));
  const requestedStatus = spec?.http_status ?? DEFAULT_RETRY_HTTP_STATUS;
  const http_status = ALLOWED_RETRY_HTTP_STATUSES.has(requestedStatus) ? requestedStatus : DEFAULT_RETRY_HTTP_STATUS;
  return { count, http_status };
}

interface WebhookAssertionRunState {
  contributions: Set<string>;
  priorStepResults: Map<string, StoryboardStepResult>;
  priorProbes: Map<string, HttpProbeResult>;
  agentUrl: string;
  webhookReceiver?: WebhookReceiver;
  runnerVars?: RunnerVariables;
}

interface FlatStep {
  step: StoryboardStep;
  phaseId: string;
  globalIndex: number;
}

type GetNextPreview = (currentStepId: string) => StoryboardStepPreview | undefined;

/**
 * Pre-mint operation ids and install retry-replay policies for every
 * `expect_webhook_retry_keys_stable` step declared by the storyboard.
 *
 * Called once at runStoryboard init — ordering matters: the receiver must
 * be armed BEFORE the triggering step runs or the first delivery will be
 * accepted and the sender won't retry.
 */
export function armWebhookAssertions(
  storyboard: Storyboard,
  runnerVars: RunnerVariables,
  receiver: WebhookReceiver
): void {
  for (const phase of storyboard.phases) {
    for (const step of phase.steps) {
      if (step.task !== 'expect_webhook_retry_keys_stable') continue;
      if (!step.triggered_by) continue;

      // Pre-mint operation_id so the triggering step's {{runner.webhook_url:<id>}}
      // expansion matches the retry-policy key here.
      let opId = runnerVars.stepOperationIds.get(step.triggered_by);
      if (!opId) {
        opId = randomUUID();
        runnerVars.stepOperationIds.set(step.triggered_by, opId);
      }
      const policy: RetryReplayPolicy = clampRetryPolicy(step.retry_trigger);
      receiver.set_retry_replay({ step_id: step.triggered_by, operation_id: opId }, policy);
    }
  }
}

/**
 * Dispatch any of the three webhook-assertion pseudo-tasks.
 *
 * Called by runner.executeStep when the step's `task` is in
 * `WEBHOOK_ASSERTION_TASKS`. Every path returns a `StoryboardStepResult`
 * with validations that carry the spec error codes in `actual.code`.
 */
export async function executeWebhookAssertionStep(
  step: StoryboardStep,
  phaseId: string,
  context: StoryboardContext,
  allSteps: FlatStep[],
  options: StoryboardRunOptions,
  runState: WebhookAssertionRunState,
  getNextPreview?: GetNextPreview
): Promise<StoryboardStepResult> {
  const start = Date.now();
  const next = getNextPreview?.(step.id);
  const requestRecord: RunnerRequestRecord = {
    transport: 'http',
    operation: step.task,
    payload: null,
  };
  const extraction: RunnerExtractionRecord = { path: 'none', note: 'webhook-assertion step' };

  // `requires_contract` skip — assertion opts out cleanly when the harness
  // contract the author depended on isn't configured on this runner.
  if (step.requires_contract) {
    const contracts = new Set(options.contracts ?? []);
    if (!contracts.has(step.requires_contract)) {
      return skippedResult(step, phaseId, context, start, {
        skip_reason: 'unsatisfied_contract',
        detail: `Test-kit contract "${step.requires_contract}" is not configured on this runner.`,
        extraction,
        request: requestRecord,
        next,
      });
    }
  }

  if (!runState.webhookReceiver || !runState.runnerVars) {
    // Webhook receiver isn't enabled — equivalent to "contract not in scope"
    // for compliance reports. Grade as not_applicable, not fail.
    return skippedResult(step, phaseId, context, start, {
      skip_reason: 'unsatisfied_contract',
      detail:
        `Step "${step.task}" requires an ephemeral webhook receiver. Pass ` +
        '`webhook_receiver` on runStoryboard options to enable.',
      extraction,
      request: requestRecord,
      next,
    });
  }

  // If the triggering step failed or was skipped, there's no webhook to
  // observe — surface as prerequisite_failed rather than timing out.
  if (step.triggered_by) {
    const prior = runState.priorStepResults.get(step.triggered_by);
    if (prior && (prior.skipped || !prior.passed)) {
      return skippedResult(step, phaseId, context, start, {
        skip_reason: 'prerequisite_failed',
        detail: `Triggering step "${step.triggered_by}" did not complete successfully.`,
        extraction,
        request: requestRecord,
        next,
      });
    }
  }

  const receiver = runState.webhookReceiver;
  const runnerVars = runState.runnerVars;
  const filter = buildFilter(step, context, runnerVars);

  let validations: ValidationResult[];
  let passed: boolean;

  switch (step.task) {
    case 'expect_webhook': {
      const outcome = await runExpectWebhook(step, filter, receiver);
      validations = outcome.validations;
      passed = outcome.passed;
      break;
    }
    case 'expect_webhook_retry_keys_stable': {
      const outcome = await runExpectRetryKeysStable(step, filter, receiver);
      validations = outcome.validations;
      passed = outcome.passed;
      break;
    }
    case 'expect_webhook_signature_valid': {
      const outcome = await runExpectSignatureValid(step, filter, receiver, options, runnerVars);
      validations = outcome.validations;
      passed = outcome.passed;
      // When the verifier isn't configured, the spec says not_applicable
      // rather than fail. Return the skipped shape.
      if (outcome.skipped) {
        return skippedResult(step, phaseId, context, start, {
          skip_reason: 'unsatisfied_contract',
          detail: outcome.skipReason ?? 'Signature verifier not configured.',
          extraction,
          request: requestRecord,
          next,
        });
      }
      break;
    }
    default: {
      // Defensive — this function is only called for tasks in WEBHOOK_ASSERTION_TASKS.
      validations = [];
      passed = false;
    }
  }

  return {
    step_id: step.id,
    phase_id: phaseId,
    title: step.title,
    task: step.task,
    passed,
    expect_error: step.expect_error,
    duration_ms: Date.now() - start,
    validations,
    context,
    ...(next && { next }),
    request: requestRecord,
    extraction,
  };
}

// ────────────────────────────────────────────────────────────
// Filter construction
// ────────────────────────────────────────────────────────────

function buildFilter(
  step: StoryboardStep,
  context: StoryboardContext,
  runnerVars: RunnerVariables
): WebhookFilter {
  const filter: WebhookFilter = {};

  // Default: scope to the triggering step's URL. Authors can override via
  // an explicit `filter.operation_id` (useful for fan-in tests).
  if (step.triggered_by) {
    filter.step_id = step.triggered_by;
    const priorOpId = runnerVars.stepOperationIds.get(step.triggered_by);
    if (priorOpId) filter.operation_id = priorOpId;
  }

  if (step.filter) {
    // Resolve any `{{prior_step.<id>.operation_id}}` / `$context.*` tokens
    // before matching — the storyboard may author operation_id this way.
    const resolved = injectContext({ __f: { ...step.filter } }, context, runnerVars).__f as Record<string, unknown>;
    if (resolved && typeof resolved === 'object') {
      if (typeof resolved.operation_id === 'string') {
        filter.operation_id = resolved.operation_id;
      }
      if (resolved.body && typeof resolved.body === 'object' && !Array.isArray(resolved.body)) {
        filter.body = resolved.body as Record<string, unknown>;
      }
    }
  }
  return filter;
}

// ────────────────────────────────────────────────────────────
// expect_webhook
// ────────────────────────────────────────────────────────────

async function runExpectWebhook(
  step: StoryboardStep,
  filter: WebhookFilter,
  receiver: WebhookReceiver
): Promise<{ validations: ValidationResult[]; passed: boolean }> {
  const timeoutMs = clampTimeoutSeconds(step.timeout_seconds, DEFAULT_TIMEOUT_SECONDS) * 1000;
  const checkIdempotency = step.expect_idempotency_key !== false;
  const capCount = step.expect_max_deliveries_per_logical_event;

  // When we're asserting a cap (e.g., "at most 1 logical event on replay"),
  // wait the full window to let any duplicate delivery arrive before judging.
  // When we just need ≥1 delivery, resolve on first match.
  let matches: CapturedWebhook[];
  if (typeof capCount === 'number') {
    matches = await receiver.wait_all(filter, timeoutMs);
  } else {
    const first = await receiver.wait(filter, timeoutMs);
    matches = first.webhook ? [first.webhook] : [];
  }

  if (matches.length === 0) {
    return singleFailure(
      step,
      'no_webhook_received',
      `No webhook matching filter arrived within ${timeoutMs}ms.`,
      'webhook delivery matching filter',
      null
    );
  }

  const first = matches[0]!;
  if (first.parse_error !== undefined) {
    return singleFailure(
      step,
      'schema_violation',
      `Webhook body was not valid JSON: ${first.parse_error}`,
      'JSON object body',
      first.raw_body.slice(0, 256)
    );
  }

  if (checkIdempotency) {
    const idempotencyCheck = assertIdempotencyKey(first);
    if (idempotencyCheck) return { validations: [idempotencyCheck], passed: false };
  }

  if (typeof capCount === 'number') {
    const distinctKeys = new Set(matches.map(m => extractIdempotencyKey(m)).filter((k): k is string => !!k));
    if (distinctKeys.size > capCount) {
      return singleFailure(
        step,
        'duplicate_webhook_on_replay',
        `Observed ${distinctKeys.size} distinct logical events in the window (idempotency_keys); expected ≤ ${capCount}.`,
        `≤ ${capCount} distinct idempotency_keys`,
        Array.from(distinctKeys)
      );
    }
  }

  return {
    validations: [
      {
        check: 'expect_webhook',
        passed: true,
        description: `Webhook arrived at ${filter.step_id ?? 'receiver'} with valid idempotency_key.`,
        json_pointer: '/idempotency_key',
      },
    ],
    passed: true,
  };
}

// ────────────────────────────────────────────────────────────
// expect_webhook_retry_keys_stable
// ────────────────────────────────────────────────────────────

async function runExpectRetryKeysStable(
  step: StoryboardStep,
  filter: WebhookFilter,
  receiver: WebhookReceiver
): Promise<{ validations: ValidationResult[]; passed: boolean }> {
  const timeoutMs = clampTimeoutSeconds(step.timeout_seconds, DEFAULT_RETRY_REPLAY_TIMEOUT_SECONDS) * 1000;
  const minDeliveries = step.expect_min_deliveries ?? DEFAULT_MIN_DELIVERIES;

  const matches = await receiver.wait_all(filter, timeoutMs);

  if (matches.length < minDeliveries) {
    return singleFailure(
      step,
      'insufficient_retries',
      `Observed ${matches.length} deliveries; expected at least ${minDeliveries}. ` +
        'The sender may not be retrying on 5xx responses.',
      `≥ ${minDeliveries} deliveries`,
      matches.length
    );
  }

  const keys = matches.map(m => extractIdempotencyKey(m));
  const missingKey = matches.find((_, i) => !keys[i]);
  if (missingKey) {
    return singleFailure(
      step,
      'missing_idempotency_key',
      `Delivery ${missingKey.delivery_index} carried no idempotency_key.`,
      'every delivery carries idempotency_key',
      null
    );
  }

  const firstKey = keys[0]!;
  const formatValid = keys.every(k => k && WEBHOOK_IDEMPOTENCY_KEY_PATTERN.test(k));
  if (!formatValid) {
    const bad = keys.find(k => !k || !WEBHOOK_IDEMPOTENCY_KEY_PATTERN.test(k));
    return singleFailure(
      step,
      'idempotency_key_format_changed',
      `One or more deliveries carried a malformed idempotency_key. Required pattern: ${WEBHOOK_IDEMPOTENCY_KEY_PATTERN.source}`,
      WEBHOOK_IDEMPOTENCY_KEY_PATTERN.source,
      bad ?? null
    );
  }

  const rotated = keys.some(k => k !== firstKey);
  if (rotated) {
    return singleFailure(
      step,
      'idempotency_key_rotated',
      'idempotency_key rotated across retries. Senders MUST reuse the first delivery\'s key for every retry of the same logical event.',
      'byte-identical idempotency_key on every delivery',
      keys
    );
  }

  return {
    validations: [
      {
        check: 'expect_webhook_retry_keys_stable',
        passed: true,
        description: `${matches.length} deliveries observed; all carried byte-identical idempotency_key.`,
        json_pointer: '/idempotency_key',
      },
    ],
    passed: true,
  };
}

// ────────────────────────────────────────────────────────────
// expect_webhook_signature_valid
// ────────────────────────────────────────────────────────────

async function runExpectSignatureValid(
  step: StoryboardStep,
  filter: WebhookFilter,
  receiver: WebhookReceiver,
  options: StoryboardRunOptions,
  runnerVars: RunnerVariables
): Promise<{ validations: ValidationResult[]; passed: boolean; skipped?: boolean; skipReason?: string }> {
  const config = options.webhook_signing;
  if (!config) {
    return {
      validations: [],
      passed: true,
      skipped: true,
      skipReason:
        '`expect_webhook_signature_valid` requires `webhook_signing` on runStoryboard options ' +
        '(pass a JwksResolver; replay + revocation stores default to in-memory).',
    };
  }

  const timeoutMs = clampTimeoutSeconds(step.timeout_seconds, DEFAULT_TIMEOUT_SECONDS) * 1000;
  const wait = await receiver.wait(filter, timeoutMs);
  if (wait.timed_out || !wait.webhook) {
    return singleFailure(
      step,
      'no_webhook_received',
      `No webhook matching filter arrived within ${timeoutMs}ms.`,
      'signed webhook delivery matching filter',
      null
    );
  }

  const webhook = wait.webhook;
  void runnerVars;
  const requestLike = toRequestLike(webhook, receiver);
  const requiredTag = step.require_tag ?? config.required_tag ?? DEFAULT_WEBHOOK_SIGNING_TAG;

  try {
    await verifyWebhookSignature(requestLike, {
      jwks: config.jwks,
      replayStore: getSharedReplayStore(runnerVars, config.replayStore),
      revocationStore: getSharedRevocationStore(runnerVars, config.revocationStore),
      requiredTag,
    });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      return singleFailure(
        step,
        mapSignatureErrorCode(err.code),
        err.message,
        `checklist step ${err.failedStep} passes`,
        { code: err.code, step: err.failedStep }
      );
    }
    return singleFailure(
      step,
      'signature_invalid',
      err instanceof Error ? err.message : String(err),
      '9421 webhook signature verification',
      null
    );
  }

  return {
    validations: [
      {
        check: 'expect_webhook_signature_valid',
        passed: true,
        description: `9421 webhook signature verified under ${requiredTag}.`,
      },
    ],
    passed: true,
  };
}

/**
 * Translate a captured webhook into the `RequestLike` shape the shared
 * canonicalizer expects. The receiver's `base_url` plus `step_id` /
 * `operation_id` reconstruct the `@target-uri` the publisher signed.
 */
function toRequestLike(webhook: CapturedWebhook, receiver: WebhookReceiver): RequestLike {
  const url = `${receiver.base_url}/step/${webhook.step_id}/${webhook.operation_id}`;
  return {
    method: webhook.method,
    url,
    headers: webhook.headers,
    body: webhook.raw_body,
  };
}

/**
 * Map the verifier's `webhook_signature_*` error codes to the storyboard-side
 * `signature_*` codes defined by adcontextprotocol/adcp#2431. Exhaustive so
 * that adding a new verifier code without a mapping is a TS compile error
 * rather than a silent collapse onto `signature_invalid` — distinct
 * remediation paths deserve distinct codes (a revoked key needs rotation,
 * a malformed window is a signer bug, etc.).
 */
function mapSignatureErrorCode(
  code: import('../../signing/errors').WebhookSignatureErrorCode
): WebhookAssertionErrorCode {
  switch (code) {
    case 'webhook_signature_header_malformed':
      return 'signature_header_malformed';
    case 'webhook_signature_params_incomplete':
      return 'signature_params_incomplete';
    case 'webhook_signature_tag_invalid':
      return 'signature_tag_invalid';
    case 'webhook_signature_alg_not_allowed':
      return 'signature_alg_not_allowed';
    case 'webhook_signature_window_invalid':
      return 'signature_window_invalid';
    case 'webhook_signature_components_incomplete':
      return 'signature_components_incomplete';
    case 'webhook_signature_key_unknown':
      return 'signature_key_unknown';
    case 'webhook_signature_key_purpose_invalid':
      return 'signature_key_purpose_invalid';
    case 'webhook_signature_key_revoked':
      return 'signature_key_revoked';
    case 'webhook_signature_revocation_stale':
      return 'signature_revocation_stale';
    case 'webhook_signature_rate_abuse':
      return 'signature_rate_abuse';
    case 'webhook_signature_digest_mismatch':
      return 'signature_digest_mismatch';
    case 'webhook_signature_replayed':
      return 'signature_replayed';
    case 'webhook_signature_invalid':
      return 'signature_invalid';
    default: {
      // Exhaustiveness: any unhandled code is a compile error.
      const _exhaustive: never = code;
      void _exhaustive;
      return 'signature_invalid';
    }
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function extractIdempotencyKey(webhook: CapturedWebhook): string | undefined {
  const body = webhook.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const key = (body as Record<string, unknown>).idempotency_key;
  return typeof key === 'string' ? key : undefined;
}

function assertIdempotencyKey(webhook: CapturedWebhook): ValidationResult | undefined {
  const body = webhook.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return failure('schema_violation', 'Webhook body was not a JSON object.', 'JSON object body', null);
  }
  const key = (body as Record<string, unknown>).idempotency_key;
  if (typeof key !== 'string' || key.length === 0) {
    return failure(
      'missing_idempotency_key',
      'Webhook body is missing a non-empty `idempotency_key` — required by AdCP 3.0.',
      'non-empty string',
      key ?? null
    );
  }
  if (!WEBHOOK_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return failure(
      'invalid_idempotency_key_format',
      `idempotency_key "${key}" does not match required pattern ${WEBHOOK_IDEMPOTENCY_KEY_PATTERN.source}.`,
      WEBHOOK_IDEMPOTENCY_KEY_PATTERN.source,
      key
    );
  }
  return undefined;
}

function failure(
  code: WebhookAssertionErrorCode,
  message: string,
  expected: unknown,
  actual: unknown
): ValidationResult {
  return {
    check: 'expect_webhook',
    passed: false,
    description: 'Webhook conformance assertion failed.',
    error: message,
    json_pointer: '/idempotency_key',
    expected,
    actual: { code, actual },
  };
}

function singleFailure(
  step: StoryboardStep,
  code: WebhookAssertionErrorCode,
  message: string,
  expected: unknown,
  actual: unknown
): { validations: ValidationResult[]; passed: boolean } {
  return {
    validations: [
      {
        check: step.task,
        passed: false,
        description: step.expected ?? step.title,
        error: message,
        json_pointer: '/idempotency_key',
        expected,
        actual: { code, actual },
      },
    ],
    passed: false,
  };
}

function skippedResult(
  step: StoryboardStep,
  phaseId: string,
  context: StoryboardContext,
  start: number,
  opts: {
    skip_reason: 'unsatisfied_contract' | 'prerequisite_failed';
    detail: string;
    extraction: RunnerExtractionRecord;
    request: RunnerRequestRecord;
    next?: StoryboardStepPreview;
  }
): StoryboardStepResult {
  return {
    step_id: step.id,
    phase_id: phaseId,
    title: step.title,
    task: step.task,
    passed: true,
    skipped: true,
    skip_reason: opts.skip_reason,
    skip: { reason: opts.skip_reason, detail: opts.detail },
    duration_ms: Date.now() - start,
    validations: [],
    context,
    error: opts.detail,
    ...(opts.next && { next: opts.next }),
    request: opts.request,
    extraction: opts.extraction,
  };
}
