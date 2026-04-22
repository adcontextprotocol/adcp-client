/**
 * Storyboard-driven testing for AdCP agents.
 *
 * Storyboards are YAML-defined workflows that map directly to
 * SingleAgentClient methods, enabling step-by-step agent testing.
 * The canonical storyboard set lives in the AdCP compliance tarball
 * and is pulled into `compliance/cache/{version}/` via `npm run sync-schemas`.
 */

// Side-effect import: registers the default cross-step assertions that
// upstream storyboards reference by id (idempotency.conflict_no_payload_leak,
// context.no_secret_echo, governance.denial_blocks_mutation). Without this
// import here, any `runStoryboard` call against a storyboard declaring
// `invariants: [...]` would throw at start on unresolved ids. Consumers who
// want to replace the defaults can `clearAssertionRegistry()` first.
import './default-invariants';

// Types
export type {
  Storyboard,
  StoryboardInvariants,
  StoryboardInvariantsObject,
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
  AssertionResult,
} from './types';
export { WEBHOOK_IDEMPOTENCY_KEY_PATTERN } from './types';

// Cross-step assertion registry (adcontextprotocol/adcp#2639)
export {
  registerAssertion,
  getAssertion,
  listAssertions,
  listDefaultAssertions,
  clearAssertionRegistry,
  resolveAssertions,
} from './assertions';
export type { AssertionSpec, AssertionContext, RegisterAssertionOptions } from './assertions';

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
  CapabilityResolutionError,
  PROTOCOL_TO_PATH,
} from './compliance';
export type {
  AgentCapabilities,
  BundleKind,
  BundleRef,
  CapabilityResolutionCode,
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
export {
  buildRequest,
  hasRequestBuilder,
  listRequestBuilders,
  INLINE_SAMPLE_REQUEST_BUILDERS,
} from './request-builder';

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
