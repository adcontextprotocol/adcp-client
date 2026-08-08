import type { ComplianceResult, TestedTrackEntry, TrackResult } from './index';
import { buildComplianceSummary, type TestedTrackEntry as TestingBarrelEntry } from '../index';

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
