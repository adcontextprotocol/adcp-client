import type { TaskResult } from './ConversationTypes';

const PROJECTION_ONLY_REQUEST_PROPOSALS_MESSAGE =
  'request_proposals returned the projection-only products_available outcome from a native compact seller.';

/** Reject compatibility-only proposal projections at every native 3.2 completion boundary. */
export function assertNativeRequestProposalsResult(data: unknown): void {
  if (
    data !== null &&
    typeof data === 'object' &&
    ((data as { outcome?: unknown }).outcome === 'products_available' ||
      (data as { purchase_continuation?: unknown }).purchase_continuation !== undefined)
  ) {
    throw new TypeError(PROJECTION_ONLY_REQUEST_PROPOSALS_MESSAGE);
  }
}

/** Apply the native proposal guard to remote TaskInfo and local TaskState records. */
export function assertNativeRequestProposalsTask<T extends { taskType?: string; taskName?: string; result?: unknown }>(
  task: T
): T {
  if ((task.taskType ?? task.taskName) === 'request_proposals') assertNativeRequestProposalsResult(task.result);
  return task;
}

/** Guard immediate and resumable completions returned by the native task API. */
export function guardNativeRequestProposalsCompletion<T>(completion: TaskResult<T>): TaskResult<T> {
  assertNativeRequestProposalsResult(completion.data);
  if (completion.submitted) {
    const submitted = completion.submitted;
    completion.submitted = {
      ...submitted,
      track: async transport => {
        const task = await submitted.track(transport);
        assertNativeRequestProposalsResult(task.result);
        return task;
      },
      waitForCompletion: async (pollInterval, signal) =>
        guardNativeRequestProposalsCompletion(await submitted.waitForCompletion(pollInterval, signal)),
    };
  }
  if (completion.deferred) {
    const deferred = completion.deferred;
    completion.deferred = {
      ...deferred,
      resume: async resumeInput => guardNativeRequestProposalsCompletion(await deferred.resume(resumeInput)),
    };
  }
  return completion;
}
