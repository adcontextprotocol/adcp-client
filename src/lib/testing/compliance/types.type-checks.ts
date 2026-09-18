import type { ComplianceResult, TestedTrackEntry, TrackResult } from './index';
import { buildComplianceSummary, type TestedTrackEntry as TestingBarrelEntry } from '../index';
import type {
  ComplyOptions as ComplyOptionsFromBarrel,
  StoryboardValidation as StoryboardValidationFromBarrel,
} from '../index';
import type { StoryboardValidationCheck as StoryboardValidationCheckAlias } from '../storyboard';

declare const result: ComplianceResult;
declare const testingBarrelEntry: TestingBarrelEntry;

const referenceView: TestedTrackEntry['_view'] = 'reference';
const canonicalView: TrackResult['_view'] = 'canonical';
const complianceBarrelEntry: TestedTrackEntry = testingBarrelEntry;

void referenceView;
void canonicalView;
void complianceBarrelEntry;
void buildComplianceSummary;

// Scenario detail is available only from the canonical track collection.
void result.tracks[0]?.scenarios;

// @ts-expect-error tested_tracks entries intentionally omit scenario payloads.
void result.tested_tracks[0]?.scenarios;

// @ts-expect-error TrackResult is the canonical view and cannot be marked as a reference.
const invalidTrackView: TrackResult['_view'] = 'reference';

void invalidTrackView;

// ── Public surface added for the request-signing conformance fixes ──────────
// adcp-client#2954/#2955/#2956. These assert what the changeset claims is
// additive *public* surface, reached through the `@adcp/sdk/testing` barrel
// rather than a deep path — the check that would have caught the export-surface
// miss on #2959.

declare const complyOptions: ComplyOptionsFromBarrel;

// `ComplyOptions.request_signing` is the typed passthrough the CLI populates.
const signingKnobs: NonNullable<ComplyOptionsFromBarrel['request_signing']> = {
  transport: 'mcp',
  skipVectors: ['025-jwk-alg-crv-mismatch'],
  skipRateAbuse: true,
  onlyVectors: ['001-no-signature-header'],
  rateAbuseCap: 100,
};
void signingKnobs;
void complyOptions.request_signing;

// @ts-expect-error `a2a` is not a vector framing: the fixtures have no A2A shape.
const invalidSigningTransport: NonNullable<ComplyOptionsFromBarrel['request_signing']>['transport'] = 'a2a';
void invalidSigningTransport;

// `probe_passed` is accepted by the public `StoryboardValidation.check`
// surface. That field carries a `(string & {})` arm, so this assignment alone
// cannot prove union membership — the second assertion pins it against the
// `StoryboardValidationCheck` alias itself, which the storyboard barrel
// exports.
const probePassedCheck: StoryboardValidationFromBarrel['check'] = 'probe_passed';
const probePassedMember: StoryboardValidationCheckAlias = 'probe_passed';
void probePassedCheck;
void probePassedMember;
