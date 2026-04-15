/**
 * Storyboard-driven testing for AdCP agents.
 *
 * Storyboards are YAML-defined workflows that map directly to
 * SingleAgentClient methods, enabling step-by-step agent testing.
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

// Loader
export {
  parseStoryboard,
  loadStoryboardFile,
  loadBundledStoryboards,
  loadBundledScenarios,
  getStoryboardById,
  getScenarioById,
  resolveRequiredScenarios,
  getStoryboardsForPlatformType,
  getComplianceStoryboards,
  getComplianceStoryboardsForTrack,
  getApplicableComplianceStoryboards,
  listStoryboards,
} from './loader';

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
export { BrandJsonSchema } from './brand-json-schema';
export {
  getSandboxEntities,
  getSandboxBrands,
  getSandboxBrand,
  isSandboxDomain,
  clearSandboxCache,
} from './sandbox-entities';
