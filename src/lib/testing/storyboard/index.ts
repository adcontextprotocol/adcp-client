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
  PROTOCOL_TO_DOMAIN,
  PROTOCOLS_WITHOUT_BASELINE,
} from './compliance';
export type {
  AgentCapabilities,
  BundleKind,
  BundleRef,
  ComplianceIndex,
  ComplianceIndexDomain,
  ComplianceIndexSpecialism,
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
