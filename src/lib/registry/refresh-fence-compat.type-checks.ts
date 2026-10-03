// Type-only regression tests: SDK 14.0 consumers of the former human-refresh
// fence fields keep compiling within the SDK 14 major. The fields are optional
// and deprecated because the live registry no longer sends them.
//
// Run with `npm run typecheck`. The library build excludes `*.type-checks.ts`.

import type { AgentComplianceDetail, operations } from './types';

declare const detail: AgentComplianceDetail;
const availability = detail.refresh_availability;
if (availability && !availability.available) {
  // SDK 14.0 read-side usage of the removed fence metadata.
  const fenced: boolean = availability.code === 'refresh_authorization_provenance_required';
  const retryable: boolean | undefined = availability.retryable;
  const scope: 'platform' | undefined = availability.scope;
  const appliesTo: 'human_session' | undefined = availability.applies_to;
  const notice: string | undefined = availability.notice;
  const action: 'monitoring_requeue' | undefined = availability.alternative_action;
  const actionDescription: string | undefined = availability.alternative_description;
  void [fenced, retryable, scope, appliesTo, notice, action, actionDescription];
}

type RefreshUnavailable = operations['refreshAgent']['responses']['503']['content']['application/json'];
declare const unavailable: RefreshUnavailable;
// The standard registry Error shape is the supported contract.
const errorCode: string = unavailable.error;
// SDK 14.0 narrowing on the former fence arms still compiles.
if (unavailable.error === 'admin_authorization_unavailable') {
  const message: string | undefined = unavailable.message;
  void message;
}
if (unavailable.code === 'refresh_authorization_provenance_required') {
  const retryable: false | undefined = unavailable.retryable;
  const trackingIssue: string | undefined = unavailable.tracking_issue;
  void [retryable, trackingIssue];
}
void errorCode;

// New registry payloads (without the removed fields) remain assignable.
const current: NonNullable<AgentComplianceDetail['refresh_availability']> = { available: true };
const currentUnavailable: RefreshUnavailable = { error: 'refresh_unavailable' };
void [current, currentUnavailable];
