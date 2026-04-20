/**
 * Storyboard-driven testing for AdCP agents.
 *
 * Storyboards are YAML-defined workflows that map directly to
 * SingleAgentClient methods, enabling step-by-step agent testing.
 * The canonical storyboard set lives in the AdCP compliance tarball
 * and is pulled into `compliance/cache/{version}/` via `npm run sync-schemas`.
 */

// Types
export type {
  Storyboard,
  StoryboardPhase,
  StoryboardStep,
  StoryboardValidation,
  StoryboardValidationCheck,
  WebhookFilterSpec,
  WebhookRetryTriggerSpec,
  WebhookAssertionErrorCode,
  ContextOutput,
  ContextInput,
  StoryboardContext,
  StoryboardRunOptions,
  ValidationResult,
  StoryboardStepPreview,
  StoryboardStepResult,
  StoryboardPhaseResult,
  StoryboardResult,
} from './types';
export { WEBHOOK_IDEMPOTENCY_KEY_PATTERN } from './types';

// Webhook receiver (outbound-webhook conformance testing per adcontextprotocol/adcp#2431)
export { createWebhookReceiver } from './webhook-receiver';
export type {
  CapturedWebhook,
  CreateWebhookReceiverOptions,
  RetryReplayPolicy,
  WebhookFilter,
  WebhookReceiver,
  WebhookWaitResult,
} from './webhook-receiver';

// Runner-variable substitution (`{{runner.*}}` / `{{prior_step.*.operation_id}}`)
export { createRunnerVariables } from './context';
export type { RunnerVariables } from './context';

// Webhook-assertion pseudo-tasks
export { WEBHOOK_ASSERTION_TASKS } from './webhook-assertions';

// Runner
export { runStoryboard, runStoryboardStep, getFirstStepPreview } from './runner';

// Parser (single-file load for spec evolution / targeted testing)
export { parseStoryboard, loadStoryboardFile } from './loader';

// Compliance cache: capability-driven resolution
export {
  getComplianceCacheDir,
  loadComplianceIndex,
  listBundles,
  loadBundleStoryboards,
  listAllComplianceStoryboards,
  getComplianceStoryboardById,
  findBundleById,
  resolveBundleOrStoryboard,
  resolveStoryboardsForCapabilities,
  PROTOCOL_TO_PATH,
} from './compliance';
export type {
  AgentCapabilities,
  BundleKind,
  BundleRef,
  ComplianceIndex,
  ComplianceIndexProtocol,
  ComplianceIndexSpecialism,
  NotApplicableStoryboard,
  ResolveOptions,
  ResolvedBundle,
  ResolvedStoryboards,
} from './compliance';

// Task mapping
export { TASK_TO_METHOD, executeStoryboardTask } from './task-map';

// Path utilities
export { parsePath, resolvePath, setPath } from './path';

// Context
export { CONTEXT_EXTRACTORS, extractContext, injectContext, applyContextOutputs, applyContextInputs } from './context';

// Request builder
export { buildRequest, hasRequestBuilder } from './request-builder';

// Validations
export { runValidations } from './validations';

// Test-kit schema validation
export { validateTestKit, TestKitValidationError, PROBE_TASK_ALLOWLIST } from './test-kit';

// Sandbox entities
export type { SandboxBrand, SandboxAgent, SandboxEntities, BrandJson } from './sandbox-entities';
export { BrandJsonSchema, AdagentsJsonSchema } from '../../types/wellknown-schemas.generated';
export type { AdagentsJson } from '../../types/wellknown-schemas.generated';
export {
  getSandboxEntities,
  getSandboxBrands,
  getSandboxBrand,
  isSandboxDomain,
  clearSandboxCache,
} from './sandbox-entities';
