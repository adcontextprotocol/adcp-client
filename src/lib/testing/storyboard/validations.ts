/**
 * Per-step validation engine for storyboard testing.
 *
 * Supports four validation types defined in storyboard YAML:
 * - response_schema: validate against Zod schemas
 * - field_present: check a JSON path exists and is not null/undefined
 * - field_value: check a JSON path equals an expected value
 * - status_code: check the TaskResult status
 */

import { TOOL_RESPONSE_SCHEMAS } from '../../utils/response-schemas';
import type { TaskResult } from '../types';
import type { StoryboardValidation, ValidationResult } from './types';
import { resolvePath } from './path';

/**
 * Run all validations for a storyboard step.
 */
export function runValidations(
  validations: StoryboardValidation[],
  taskName: string,
  taskResult: TaskResult
): ValidationResult[] {
  return validations.map(v => runValidation(v, taskName, taskResult));
}

function runValidation(validation: StoryboardValidation, taskName: string, taskResult: TaskResult): ValidationResult {
  switch (validation.check) {
    case 'response_schema':
      return validateResponseSchema(validation, taskName, taskResult);
    case 'field_present':
      return validateFieldPresent(validation, taskResult);
    case 'field_value':
      return validateFieldValue(validation, taskResult);
    case 'status_code':
      return validateStatusCode(validation, taskResult);
    case 'error_code':
      return validateErrorCode(validation, taskResult);
    default:
      return {
        check: validation.check,
        passed: false,
        description: validation.description,
        error: `Unknown validation check: ${validation.check}`,
      };
  }
}

// ────────────────────────────────────────────────────────────
// response_schema: validate against Zod
// ────────────────────────────────────────────────────────────

function validateResponseSchema(
  validation: StoryboardValidation,
  taskName: string,
  taskResult: TaskResult
): ValidationResult {
  const schema = TOOL_RESPONSE_SCHEMAS[taskName];
  if (!schema) {
    return {
      check: 'response_schema',
      passed: false,
      description: validation.description,
      error: `No schema registered for task "${taskName}"`,
    };
  }

  const parseResult = schema.safeParse(taskResult.data);
  if (parseResult.success) {
    return {
      check: 'response_schema',
      passed: true,
      description: validation.description,
    };
  }

  // Format Zod errors
  const issues = parseResult.error.issues
    .slice(0, 5)
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('; ');

  return {
    check: 'response_schema',
    passed: false,
    description: validation.description,
    error: issues,
  };
}

// ────────────────────────────────────────────────────────────
// field_present: check a path exists
// ────────────────────────────────────────────────────────────

function validateFieldPresent(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  if (!validation.path) {
    return {
      check: 'field_present',
      passed: false,
      description: validation.description,
      path: validation.path,
      error: 'No path specified for field_present validation',
    };
  }

  const value = resolvePath(taskResult.data, validation.path);
  const present = value !== undefined && value !== null;

  return {
    check: 'field_present',
    passed: present,
    description: validation.description,
    path: validation.path,
    error: present ? undefined : `Field not found at path: ${validation.path}`,
  };
}

// ────────────────────────────────────────────────────────────
// field_value: check a path equals expected value
// ────────────────────────────────────────────────────────────

function validateFieldValue(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  if (!validation.path) {
    return {
      check: 'field_value',
      passed: false,
      description: validation.description,
      path: validation.path,
      error: 'No path specified for field_value validation',
    };
  }

  const actual = resolvePath(taskResult.data, validation.path);
  // Use JSON comparison for objects/arrays, strict equality for primitives
  const passed =
    typeof actual === 'object' && actual !== null
      ? JSON.stringify(actual) === JSON.stringify(validation.value)
      : actual === validation.value;

  return {
    check: 'field_value',
    passed,
    description: validation.description,
    path: validation.path,
    error: passed ? undefined : `Expected ${JSON.stringify(validation.value)}, got ${JSON.stringify(actual)}`,
  };
}

// ────────────────────────────────────────────────────────────
// status_code: check TaskResult status
// ────────────────────────────────────────────────────────────

function validateStatusCode(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  // Check success status
  const passed = taskResult.success;

  return {
    check: 'status_code',
    passed,
    description: validation.description,
    error: passed ? undefined : `Task failed: ${taskResult.error || 'unknown error'}`,
  };
}

// ────────────────────────────────────────────────────────────
// error_code: check error code in error response
// ────────────────────────────────────────────────────────────

function validateErrorCode(validation: StoryboardValidation, taskResult: TaskResult): ValidationResult {
  // Extract error code from various locations agents might put it
  const data = taskResult.data as Record<string, unknown> | undefined;
  const errorCode =
    data?.error_code ?? data?.code ?? (data?.error as Record<string, unknown> | undefined)?.code ?? taskResult.error;

  if (!validation.value) {
    // Just check that an error code exists
    const hasCode = errorCode !== undefined && errorCode !== null;
    return {
      check: 'error_code',
      passed: hasCode,
      description: validation.description,
      error: hasCode ? undefined : 'No error code found in response',
    };
  }

  const passed = String(errorCode) === String(validation.value);
  return {
    check: 'error_code',
    passed,
    description: validation.description,
    error: passed ? undefined : `Expected error code "${validation.value}", got "${errorCode}"`,
  };
}

// resolvePath re-exported from ./path for backwards compat
export { resolvePath } from './path';
