'use strict';
/**
 * The interoperability gate drives the installed `@adcp/sdk` and `@adcp/reporting-storage` packages.
 *
 * Before the package split, `@adcp/sdk/reporting/ledger` carried the PostgreSQL store and its migrations.
 * They now live in `@adcp/reporting-storage`. This file gives the gate's seller processes one view of both:
 *
 *   - `mergedLedger(req)` returns the protocol layer plus the storage exports, which is what the gate's own
 *     seller scripts read as `ledger.X`.
 *   - Loaded with `node --require`, it also makes `require('@adcp/sdk/reporting/ledger')` return that merged
 *     view inside the process. That is for the pinned Python harness wrappers
 *     (`ts_core_server.cjs`, `ts_managed_reporting_server.cjs`), which are checked byte-for-byte against an
 *     adcp-client-python commit that predates the split and still read the store from the SDK subpath.
 *     Remove the preload when the pin in `pins.json` advances to a harness that reads
 *     `@adcp/reporting-storage` itself (adcp-client-python#1510).
 *
 * The preload needs `ADCP_INTEROP_INSTALLATION`, the directory the archives were installed into. It touches
 * `require` results only: `require.resolve`, the installed files and their digests are unchanged.
 */
const Module = require('node:module');
const path = require('node:path');

const LEDGER = '@adcp/sdk/reporting/ledger';

function mergedLedger(req) {
  return {
    ...req(LEDGER),
    ...req('@adcp/reporting-storage'),
    ...req('@adcp/reporting-storage/managed'),
    ...req('@adcp/reporting-storage/notifications'),
  };
}

if (require.main !== module && process.env.ADCP_INTEROP_INSTALLATION && process.execArgv.some(arg => arg.includes('storage-compat'))) {
  const installation = path.resolve(process.env.ADCP_INTEROP_INSTALLATION);
  const installed = Module.createRequire(path.join(installation, 'package.json'));
  const original = Module.prototype.require;
  let merged;
  let building = false;
  Module.prototype.require = function patchedRequire(request) {
    const loaded = original.apply(this, arguments);
    // `mergedLedger` itself requires the SDK subpath: let that inner call through unchanged.
    if (request !== LEDGER || building) return loaded;
    if (!merged) {
      building = true;
      try {
        merged = mergedLedger(installed);
      } finally {
        building = false;
      }
    }
    return merged;
  };
}

module.exports = { mergedLedger };
