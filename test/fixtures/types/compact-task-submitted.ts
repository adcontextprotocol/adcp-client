// Pins source compatibility of the 3.2.4 `CompactTaskSubmitted` envelope intersection for
// callers written against the 3.2.3 plain interface. Compiled against the built package.
import type {
  CompactTaskSubmitted,
  RefineProposalsAsyncSubmitted,
  RequestProposalsAsyncSubmitted,
} from '@adcp/sdk/types/core.generated';
import {
  CompactTaskSubmitted_StatusValues,
  RefineProposalsAsyncSubmitted_StatusValues,
  RequestProposalsAsyncSubmitted_StatusValues,
} from '@adcp/sdk/enums';
import {
  CompactTaskSubmittedSchema,
  RefineProposalsAsyncSubmittedSchema,
  RequestProposalsAsyncSubmittedSchema,
} from '@adcp/sdk/schemas';
import { z } from 'zod';

// A 3.2.3-shaped literal (status, task_id and the original optional fields) still constructs.
const legacyLiteral: CompactTaskSubmitted = { status: 'submitted', task_id: 't1', message: 'queued', errors: [] };
const request: RequestProposalsAsyncSubmitted = { status: 'submitted', task_id: 't1' };
const refine: RefineProposalsAsyncSubmitted = { status: 'submitted', task_id: 't1' };

// The 3.2.3 interface shape is assignable in both directions.
interface Legacy323Shape {
  status: 'submitted';
  task_id: string;
  message?: string;
  errors?: CompactTaskSubmitted['errors'];
  context?: CompactTaskSubmitted['context'];
  ext?: CompactTaskSubmitted['ext'];
}
declare const legacy: Legacy323Shape;
const upgraded: CompactTaskSubmitted = legacy;
const downgraded: Legacy323Shape = upgraded;

// Extension and generic-constraint call sites keep working.
interface Extended extends CompactTaskSubmitted {
  tenant: string;
}
const takesId = <T extends { status: 'submitted'; task_id: string }>(value: T): string => value.task_id;

// The deprecated enum aliases remain readable constants with the narrow literal type.
const statuses: readonly ['submitted'] = CompactTaskSubmitted_StatusValues;
const proposalStatuses: ReadonlyArray<readonly ['submitted']> = [
  RefineProposalsAsyncSubmitted_StatusValues,
  RequestProposalsAsyncSubmitted_StatusValues,
];

// Public object helpers retain their declaration types as well as runtime methods.
const taskIdSchema = CompactTaskSubmittedSchema.shape.task_id;
const extendedSchema = CompactTaskSubmittedSchema.extend({ tenant: z.string() });
const pickedSchema = RequestProposalsAsyncSubmittedSchema.pick({ task_id: true });
const omittedSchema = RefineProposalsAsyncSubmittedSchema.omit({ message: true });
const partialSchema = CompactTaskSubmittedSchema.partial();

// The wire contract stays strict.
// @ts-expect-error task_id is required
const missingTaskId: CompactTaskSubmitted = { status: 'submitted' };
// @ts-expect-error only the submitted status is valid
const wrongStatus: CompactTaskSubmitted = { status: 'working', task_id: 't1' };

export type { Extended };
export {
  legacyLiteral,
  request,
  refine,
  upgraded,
  downgraded,
  takesId,
  statuses,
  proposalStatuses,
  taskIdSchema,
  extendedSchema,
  pickedSchema,
  omittedSchema,
  partialSchema,
  missingTaskId,
  wrongStatus,
};
