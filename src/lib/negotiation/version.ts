import type { ProposalRefinementVersion } from './types';

/** Proposal refinement starts at AdCP 3.2 and continues within major 3.
 * Wire pins have release precision; patches belong to schema bundle pins. */
export function isProposalRefinementVersion(value: unknown): value is ProposalRefinementVersion {
  if (typeof value !== 'string') return false;
  const match = /^3\.(0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.exec(value);
  return match !== null && Number.isSafeInteger(Number(match[1])) && Number(match[1]) >= 2;
}
