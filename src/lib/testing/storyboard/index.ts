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
  getStoryboardById,
  getStoryboardsForPlatformType,
  getComplianceStoryboards,
  getComplianceStoryboardsForTrack,
  getApplicableComplianceStoryboards,
  listStoryboards,
} from './loader';

// Task mapping
export { TASK_TO_METHOD, executeStoryboardTask } from './task-map';

// Context
export { extractContext, injectContext, applyContextOutputs, applyContextInputs, setPath } from './context';

// Validations
export { runValidations, resolvePath } from './validations';
