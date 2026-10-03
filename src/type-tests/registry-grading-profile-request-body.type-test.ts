// Type-only regression for the `selectAgentGradingProfile` request body.
//
// Run with `npm run typecheck`. Not part of the library build (`tsconfig.lib.json`
// only includes `src/lib/**`).
//
// The upstream AAO spec declares this operation's body schema with seven required
// properties but omits `requestBody.required: true`. OpenAPI defaults that flag to
// false, so `openapi-typescript` would emit `requestBody?:` and the generated type
// would admit a bodyless call to a revision compare-and-swap mutation.
//
// `scripts/generate-registry-types.ts` corrects the flag on an in-memory copy of the
// spec before generation (see `REQUEST_BODY_REQUIRED_CORRECTIONS` there); the cached
// spec stays byte-identical to what AAO publishes. This file pins the corrected shape
// so the correction cannot silently stop being applied -- if the entry is dropped
// before AAO ships the fix, or the operation is renamed, `npm run typecheck` fails.

import type { operations } from '../lib/registry/types.generated';

type Assert<T extends true> = T;
type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;

type SelectAgentGradingProfile = operations['selectAgentGradingProfile'];

// The mutation cannot be called without a body.
type _RequestBodyIsRequired = Assert<IsRequired<SelectAgentGradingProfile, 'requestBody'>>;

type GradingProfileRequest = SelectAgentGradingProfile['requestBody']['content']['application/json'];

// Every field the spec marks required stays required on the body itself.
type _OrganizationIdRequired = Assert<IsRequired<GradingProfileRequest, 'organization_id'>>;
type _RoleRequired = Assert<IsRequired<GradingProfileRequest, 'role'>>;
type _AdcpVersionRequired = Assert<IsRequired<GradingProfileRequest, 'adcp_version'>>;
type _SelectedProfileRequired = Assert<IsRequired<GradingProfileRequest, 'selected_profile'>>;
type _AssessmentIdRequired = Assert<IsRequired<GradingProfileRequest, 'assessment_id'>>;
type _ExpectedRevisionRequired = Assert<IsRequired<GradingProfileRequest, 'expected_revision'>>;
type _IdempotencyKeyRequired = Assert<IsRequired<GradingProfileRequest, 'idempotency_key'>>;

// The optional escape hatch stays optional, so the correction is not over-broad.
type _AdminOverrideReasonOptional = Assert<
  IsRequired<GradingProfileRequest, 'admin_override_reason'> extends false ? true : false
>;

// A bodyless call must not type-check. Assigning the operation's own `requestBody` type
// from `undefined` is the shape a caller would produce by omitting the body entirely.
type AcceptsMissingBody = undefined extends SelectAgentGradingProfile['requestBody'] ? true : false;
type _BodylessCallIsRejected = Assert<AcceptsMissingBody extends false ? true : false>;

export type {
  _RequestBodyIsRequired,
  _OrganizationIdRequired,
  _RoleRequired,
  _AdcpVersionRequired,
  _SelectedProfileRequired,
  _AssessmentIdRequired,
  _ExpectedRevisionRequired,
  _IdempotencyKeyRequired,
  _AdminOverrideReasonOptional,
  _BodylessCallIsRejected,
};
