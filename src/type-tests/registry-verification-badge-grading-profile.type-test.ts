// Type-only regression for the required `grading_profile` on a verification badge.
//
// Run with `npm run typecheck`. Not part of the library build (`tsconfig.lib.json`
// only includes `src/lib/**`).
//
// The live AAO spec lists `grading_profile` in the `required` set of
// `VerificationBadge`, so the generated type requires it. That is a breaking change for
// code constructing a badge literal, and `.changeset/registry-grading-profile-sync.md`
// carries the major bump that discloses it. This file pins the shape so the requirement
// cannot be relaxed back to optional without the disclosure being revisited, and so the
// nested reachability from the package-root `AgentComplianceDetail` stays visible.

import type { AgentComplianceDetail, components } from '../lib/registry/types.generated';

type Assert<T extends true> = T;
type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;

type VerificationBadge = components['schemas']['VerificationBadge'];

// The badge cannot be constructed without the grading profile it was issued under.
type _GradingProfileIsRequired = Assert<IsRequired<VerificationBadge, 'grading_profile'>>;
type _GradingProfileIsExactUnion = Assert<
  VerificationBadge['grading_profile'] extends 'legacy' | 'spec' ? true : false
>;

// The revision and failure-clock companions stay optional, so the requirement is narrow.
type _RevisionOptional = Assert<IsRequired<VerificationBadge, 'grading_profile_revision'> extends false ? true : false>;
type _FirstFailingOptional = Assert<
  IsRequired<VerificationBadge, 'first_failing_spec_at'> extends false ? true : false
>;

// This is the path by which the requirement reaches a package-root type.
type _BadgesReachableFromDetail = Assert<
  NonNullable<AgentComplianceDetail['verified_badges']>[number] extends VerificationBadge ? true : false
>;

// The additive selection roster stays optional, so existing detail literals still compile.
type _SelectedStatusesOptional = Assert<
  IsRequired<AgentComplianceDetail, 'selected_grading_statuses'> extends false ? true : false
>;

export type {
  _GradingProfileIsRequired,
  _GradingProfileIsExactUnion,
  _RevisionOptional,
  _FirstFailingOptional,
  _BadgesReachableFromDetail,
  _SelectedStatusesOptional,
};
