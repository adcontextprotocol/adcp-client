#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  BasicSourceBatchManifestV1JsonSchema,
  ReportingEvidenceReasonV1JsonSchema,
  SourceBatchManifestReferenceV1JsonSchema,
  SourceBatchManifestV1JsonSchema,
} from '../src/lib/reporting/source/manifest';
import {
  ReportingSourceCapabilitiesV1JsonSchema,
  ReportingSourceErrorV1JsonSchema,
  ReportingSourceExecutionResponseV1JsonSchema,
  ReportingSourceOfferingV1JsonSchema,
  ReportingSourceSliceRequestV1JsonSchema,
} from '../src/lib/reporting/source/source';
import { ReportingCrossFinalityBridgeV1JsonSchema } from '../src/lib/reporting/source/conformance';

const output = path.resolve('dist/lib/reporting/source/schemas');
mkdirSync(output, { recursive: true });

const schemas: ReadonlyArray<readonly [string, unknown]> = [
  ['reporting-source-capabilities-v1.json', ReportingSourceCapabilitiesV1JsonSchema],
  ['reporting-source-offering-v1.json', ReportingSourceOfferingV1JsonSchema],
  ['reporting-source-slice-request-v1.json', ReportingSourceSliceRequestV1JsonSchema],
  ['reporting-source-execution-response-v1.json', ReportingSourceExecutionResponseV1JsonSchema],
  ['reporting-source-error-v1.json', ReportingSourceErrorV1JsonSchema],
  ['source-batch-manifest-reference-v1.json', SourceBatchManifestReferenceV1JsonSchema],
  ['source-batch-manifest-basic-v1.json', BasicSourceBatchManifestV1JsonSchema],
  ['source-batch-manifest-v1.json', SourceBatchManifestV1JsonSchema],
  ['reporting-cross-finality-bridge-v1.json', ReportingCrossFinalityBridgeV1JsonSchema],
  ['reporting-evidence-reason-v1.json', ReportingEvidenceReasonV1JsonSchema],
];

for (const [file, schema] of schemas) {
  writeFileSync(path.join(output, file), `${JSON.stringify(schema, null, 2)}\n`);
}

console.log(`[reporting-source-schemas] copied ${schemas.length} schemas to ${output}`);
