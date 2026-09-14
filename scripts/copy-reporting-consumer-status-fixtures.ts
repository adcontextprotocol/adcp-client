#!/usr/bin/env tsx

import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const source = path.resolve('test/fixtures/reporting-reconciliation/consumer-status.json');
const outputDirectory = path.resolve('dist/lib/compliance-fixtures');
const output = path.join(outputDirectory, 'reporting-consumer-status-v1.json');

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(source, output);
console.log(`[reporting-consumer-status-fixtures] copied ${source} → ${output}`);
