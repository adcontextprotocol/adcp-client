#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function mergeTimingFiles(files) {
  const tests = {};
  for (const file of files.slice().sort(comparePaths)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || parsed.tests === null || typeof parsed.tests !== 'object') {
      throw new Error(`${file}: expected a version 1 object with a tests map`);
    }
    for (const [testPath, durationMs] of Object.entries(parsed.tests)) {
      if (!testPath.endsWith('.test.js') || !Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error(`${file}: invalid timing for ${JSON.stringify(testPath)}`);
      }
      if (tests[testPath] !== undefined) throw new Error(`${testPath} appears in more than one timing artifact`);
      tests[testPath] = durationMs;
    }
  }
  return {
    version: 1,
    tests: Object.fromEntries(Object.entries(tests).sort(([left], [right]) => comparePaths(left, right))),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (!['--input', '--output'].includes(option) || argv[index + 1] === undefined) {
      throw new Error('Usage: merge-node-test-timings.mjs --input <directory> --output <file>');
    }
    options[option.slice(2)] = argv[index + 1];
  }
  if (!options.input || !options.output) throw new Error('Both --input and --output are required');
  return options;
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const files = readdirSync(options.input, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name.startsWith('timings-'))
    .map(entry => path.join(options.input, entry.name));
  if (files.length === 0) throw new Error(`No timings-*.json artifacts found in ${options.input}`);
  const merged = mergeTimingFiles(files);
  if (Object.keys(merged.tests).length === 0) throw new Error('Timing artifacts contained no test files');
  writeFileSync(options.output, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`[node-test-timings] recorded ${Object.keys(merged.tests).length} files from ${files.length} shards`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    run();
  } catch (error) {
    console.error(`[node-test-timings] ${error.message}`);
    process.exitCode = 1;
  }
}
