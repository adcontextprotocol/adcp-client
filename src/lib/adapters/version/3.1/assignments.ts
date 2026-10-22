import type { VersionAdapter } from '../types';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * AdCP 3.2 `sync_creatives.assignment_operations` adds explicit `unassign`
 * and `replace` to the 3.1 `assignments` upsert. A request whose operations
 * are all `assign` means exactly what 3.1 `assignments` means, so it moves
 * there (appended after any `assignments` the request already carries, in
 * order). 3.2 makes the operations atomic, so the moved request asks for
 * `validation_mode: 'strict'` unless the caller chose a mode. Any `unassign`
 * or `replace` has no 3.1 form; the request is left for the projection,
 * which refuses it as a mutation.
 */
export const syncCreativesAdapter: VersionAdapter = {
  toolName: 'sync_creatives',
  adaptRequest(params) {
    if (!isObject(params) || !Array.isArray(params.assignment_operations)) return { params };
    const operations = params.assignment_operations;
    if (!operations.every(op => isObject(op) && op.operation === 'assign')) return { params };
    const moved = (operations as Json[]).map(({ operation: _, ...assignment }) => assignment);
    const { assignment_operations: _, ...rest } = params;
    const existing = Array.isArray(params.assignments) ? params.assignments : [];
    return {
      params: {
        ...rest,
        assignments: [...existing, ...moved],
        validation_mode: params.validation_mode ?? 'strict',
      },
      drift: {
        type: 'assignment_operations_moved_to_assignments',
        message:
          'assignment_operations (assign only) rewritten as AdCP 3.1 assignments, validated strictly to keep the 3.2 ' +
          'all-or-nothing behavior.',
        movedFields: moved.map((_, index) => ({
          from: `assignment_operations[${index}]`,
          to: `assignments[${existing.length + index}]`,
        })),
      },
    };
  },
};
