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
  StepInvariantsObject,
  StoryboardPhase,
  StoryboardStep,
  StoryboardValidation,
  StoryboardValidationCheck,
  WebhookFilterSpec,
  WebhookRetryTriggerSpec,
  WebhookAssertionErrorCode,
  ContextOutput,
  ContextInput,
  ContextProvenanceEntry,
  ContextValueRejectedHint,
  FormatMismatchHint,
  StoryboardContext,
  StoryboardRunOptions,
  ValidationResult,
  StoryboardStepPreview,
  StoryboardStepResult,
  StoryboardStepHint,
  StoryboardPhaseResult,
  StoryboardResult,
  AssertionResult,
  StrictValidationSummary,
  StrictValidationVerdict,
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
export {
  runStoryboard,
  runStoryboardStep,
  getFirstStepPreview,
  summarizeStrictValidation,
  listStrictOnlyFailures,
  resolveCapabilityPath,
} from './runner';

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
export {
  CONTEXT_EXTRACTORS,
  extractContext,
  extractContextWithProvenance,
  injectContext,
  applyContextOutputs,
  applyContextOutputsWithProvenance,
  applyContextInputs,
} from './context';
export type { ContextWriteResult } from './context';

// Rejection-hint detection (issue #870)
export { detectContextRejectionHints } from './rejection-hints';

// Format-mismatch hint detection (issue #947)
export { detectFormatMismatchHints } from './format-mismatch-hints';

// Request builder
export { buildRequest, hasRequestBuilder } from './request-builder';

// Validations
export { runValidations } from './validations';

// `./junit` is deliberately NOT re-exported. The CLI requires it
// directly from `dist/lib/testing/storyboard/junit.js` and the function
// is marked `@internal` (stripped from the generated `.d.ts`). Add a
// re-export here only if/when we promote it to a public API surface.

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
