import { compare, valid } from 'semver';
import type { ProposalRefinementVersion } from './types';

/** Supported wire releases. Keep this guard and the public type in sync. */
export function isProposalRefinementVersion(value: unknown): value is ProposalRefinementVersion {
  if (typeof value !== 'string' || !/^3\.[23](?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(value)) return false;
  // The comparator requires SemVer-valid prereleases (no numeric leading
  // zeros or oversized versions); reject hostile wire values before comparison.
  const comparable = value.replace(/^(3\.[23])(?=-|$)/, '$1.0');
  return valid(comparable) === comparable;
}

/** Inputs have already passed the release-precision guard above. */
export function compareProposalRefinementVersions(
  left: ProposalRefinementVersion,
  right: ProposalRefinementVersion
): number {
  const semver = (value: string) => value.replace(/^(3\.[23])(?=-|$)/, '$1.0');
  return compare(semver(left), semver(right));
}

export function describeRefinementVersion(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 160);
  } catch {
    return '[unserializable version]';
  }
}
