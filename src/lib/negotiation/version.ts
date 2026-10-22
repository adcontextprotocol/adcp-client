import { compare, valid } from 'semver';
import type { ProposalRefinementVersion } from './types';
import { toReleasePrecisionVersion } from '../version';

/** Supported wire releases. Keep this guard and the public type in sync. */
export function isProposalRefinementVersion(value: unknown): value is ProposalRefinementVersion {
  if (typeof value !== 'string' || !/^3\.[23](?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(value)) return false;
  // The comparator requires SemVer-valid prereleases (no numeric leading
  // zeros or oversized versions); reject hostile wire values before comparison.
  const comparable = value.replace(/^(3\.[23])(?=-|$)/, '$1.0');
  return valid(comparable) === comparable;
}

/** @internal Discovery evidence only constrains requests whose ceiling can serve it. */
export function applicableRefinementServedVersion(
  served: unknown,
  ceiling: unknown,
  discoveryCeiling: unknown = ceiling
): string | undefined {
  if (!isProposalRefinementVersion(discoveryCeiling)) return undefined;
  if (!isProposalRefinementVersion(ceiling) || compareProposalRefinementVersions(ceiling, discoveryCeiling) > 0)
    return undefined;
  if (typeof served !== 'string' || !isProposalRefinementVersion(ceiling)) return undefined;
  // Accept exact artifact versions as metadata, but never normalize invalid
  // SemVer (such as a leading-zero patch/prerelease) into valid evidence.
  if (!isProposalRefinementVersion(served) && valid(served) !== served) return undefined;
  const release = toReleasePrecisionVersion(served);
  return isProposalRefinementVersion(release) && compareProposalRefinementVersions(release, ceiling) <= 0
    ? served
    : undefined;
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
