#!/usr/bin/env node
'use strict';
/**
 * `npx adcp-reporting-storage migrate [--status | --dry-run]`: apply the versioned reporting storage
 * migrations to a PostgreSQL database. See `npx adcp-reporting-storage --help`.
 */
const { runReportingStorageCli } = require('../dist/cli.js');

runReportingStorageCli(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
