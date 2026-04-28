/**
 * Assertion helpers for unit tests that exercise
 * {@link handleTestControllerRequest} directly.
 */

import type {
  ComplyTestControllerResponse,
  ControllerError,
  ListScenariosSuccess,
  StateTransitionSuccess,
  SimulationSuccess,
  ForcedDirectiveSuccess,
  SeedSuccess,
} from '../types/tools.generated';

type AnyControllerSuccess =
  | ListScenariosSuccess
  | StateTransitionSuccess
  | SimulationSuccess
  | ForcedDirectiveSuccess
  | SeedSuccess;

/**
 * `ControllerError` with `error_detail` guaranteed to be present. The SDK's
 * internal `controllerError` constructor always populates it, so in practice
 * every error returned by the dispatcher satisfies this narrower type —
 * returning it lets callers assert on detail without `!` or `?.`.
 */
export type ControllerErrorWithDetail = ControllerError & { error_detail: string };

/**
 * Narrow a `ComplyTestControllerResponse` to the `ControllerError` arm and
 * assert its `error` code. Throws an `Error` with a descriptive message when
 * the response is success-shaped or when the code does not match.
 *
 * Returns the narrowed error so callers can make further assertions on
 * `error_detail` / `current_state` without re-casting.
 *
 * ```ts
 * const result = await handleTestControllerRequest(store, {
 *   scenario: 'force_account_status',
 *   params: {},
 * });
 * const err = expectControllerError(result, 'INVALID_PARAMS');
 * assert.match(err.error_detail, /account_id/);
 * ```
 */
export function expectControllerError(
  result: ComplyTestControllerResponse,
  code: ControllerError['error']
): ControllerErrorWithDetail {
  if (result.success !== false) {
    throw new Error(
      `expectControllerError(${code}): expected a ControllerError response but got success-shaped result: ${JSON.stringify(
        result
      )}`
    );
  }
  if (result.error !== code) {
    throw new Error(
      `expectControllerError(${code}): expected error code "${code}" but got "${result.error}" (detail: ${
        result.error_detail ?? 'n/a'
      })`
    );
  }
  // error_detail is always populated by the SDK's controllerError() constructor.
  return result as ControllerErrorWithDetail;
}

/**
 * Narrow a `ComplyTestControllerResponse` to its success arm and optionally
 * assert which success shape it is (`'list'`, `'transition'`, or `'simulation'`).
 * Throws when the response is an error or when the arm doesn't match.
 *
 * Returns the narrowed success value so callers skip the `if (result.success)`
 * boilerplate and access arm-specific fields directly.
 *
 * ```ts
 * const result = await handleTestControllerRequest(store, {
 *   scenario: 'force_account_status',
 *   params: { account_id: 'acct-1', status: 'suspended' },
 * });
 * const ok = expectControllerSuccess(result, 'transition');
 * assert.strictEqual(ok.current_state, 'suspended');
 * ```
 */
export function expectControllerSuccess(result: ComplyTestControllerResponse, kind?: 'list'): ListScenariosSuccess;
export function expectControllerSuccess(
  result: ComplyTestControllerResponse,
  kind: 'transition'
): StateTransitionSuccess;
export function expectControllerSuccess(result: ComplyTestControllerResponse, kind: 'simulation'): SimulationSuccess;
export function expectControllerSuccess(result: ComplyTestControllerResponse, kind: 'forced'): ForcedDirectiveSuccess;
/**
 * Narrow to the `SeedSuccess` arm (3.0.1+ message-only seed acknowledgement).
 *
 * Every `seed_*` scenario returns `SeedSuccess` (`{ success: true, message? }`)
 * — both responses produced by the SDK's own `dispatchSeed` and responses
 * from third-party sellers. Force_* scenarios continue to return
 * `StateTransitionSuccess` (`previous_state` / `current_state`) under
 * `kind: 'transition'`.
 */
export function expectControllerSuccess(result: ComplyTestControllerResponse, kind: 'seed'): SeedSuccess;
export function expectControllerSuccess(result: ComplyTestControllerResponse): AnyControllerSuccess;
export function expectControllerSuccess(
  result: ComplyTestControllerResponse,
  kind?: 'list' | 'transition' | 'simulation' | 'forced' | 'seed'
): AnyControllerSuccess {
  if (result.success !== true) {
    throw new Error(
      `expectControllerSuccess: expected a success response but got ControllerError ${result.error}${
        result.error_detail ? ` (${result.error_detail})` : ''
      }`
    );
  }

  if (kind === undefined) {
    return result;
  }

  // Discriminate by required field — every success arm has exactly one
  // distinguishing key. `seed` is the message-only fallback when no other
  // arm's required field is present.
  const actual: 'list' | 'transition' | 'simulation' | 'forced' | 'seed' =
    'scenarios' in result
      ? 'list'
      : 'previous_state' in result
        ? 'transition'
        : 'simulated' in result
          ? 'simulation'
          : 'forced' in result
            ? 'forced'
            : 'seed';
  if (actual !== kind) {
    throw new Error(`expectControllerSuccess(${kind}): expected "${kind}" arm but got "${actual}"`);
  }
  return result;
}
