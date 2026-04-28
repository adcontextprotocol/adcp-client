#!/usr/bin/env node
'use strict';

// @adcp/client has been renamed to @adcp/sdk.
// This wrapper delegates the `adcp` CLI to the new package so existing
// `npx @adcp/client@latest …` invocations keep working.

const path = require('path');

// The SDK's `--version` flag reads this to print
// `@adcp/sdk@<v> (invoked via @adcp/client compat shim)` so users know which
// package they're actually running.
process.env.ADCP_INVOKED_VIA_SHIM = '1';

let sdkPackageJsonPath;
try {
  sdkPackageJsonPath = require.resolve('@adcp/sdk/package.json');
} catch (err) {
  console.error('@adcp/client could not locate @adcp/sdk. Install it with:');
  console.error('  npm install @adcp/sdk');
  console.error('or migrate your CLI invocation to:');
  console.error('  npx @adcp/sdk@latest …');
  process.exit(1);
}

const sdkRoot = path.dirname(sdkPackageJsonPath);
require(path.join(sdkRoot, 'bin', 'adcp.js'));
