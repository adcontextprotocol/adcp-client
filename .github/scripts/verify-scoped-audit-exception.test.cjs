'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { verifyAuditReports } = require('./verify-scoped-audit-exception.cjs');

const advisory = {
  name: 'picomatch',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high',
  range: '<=4.0.7',
};

function finding(name, via) {
  return { name, severity: 'high', range: '*', nodes: [`node_modules/${name}`], via };
}

function reports() {
  const vulnerabilities = {
    picomatch: finding('picomatch', [advisory]),
    fdir: finding('fdir', ['picomatch']),
    tinyglobby: finding('tinyglobby', ['fdir', 'picomatch']),
    '@typescript-eslint/typescript-estree': finding('@typescript-eslint/typescript-estree', ['tinyglobby']),
  };
  const audit = { metadata: { vulnerabilities: { high: 4, critical: 0 } }, vulnerabilities };
  return {
    full: structuredClone(audit),
    production: structuredClone(audit),
    sdkTree: { name: '@adcp/sdk' },
    productionTree: {
      name: '@adcp/sdk',
      dependencies: {
        '@adcp/eslint-plugin': {
          dependencies: {
            '@typescript-eslint/utils': {
              dependencies: {
                '@typescript-eslint/typescript-estree': {
                  dependencies: {
                    tinyglobby: {
                      dependencies: {
                        picomatch: { version: '4.0.7' },
                        fdir: { dependencies: { picomatch: { version: '4.0.7' } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    fullTree: {
      name: '@adcp/sdk',
      dependencies: {
        '@changesets/cli': {
          dependencies: {
            '@changesets/config': { dependencies: { picomatch: { version: '4.0.7' } } },
            '@changesets/git': { dependencies: { picomatch: { version: '4.0.7' } } },
          },
        },
        'json-schema-to-typescript': {
          dependencies: {
            tinyglobby: {
              dependencies: {
                picomatch: { version: '4.0.7' },
                fdir: { dependencies: { picomatch: { version: '4.0.7' } } },
              },
            },
          },
        },
      },
    },
    lock: { packages: { 'node_modules/picomatch': { version: '4.0.7' } } },
    availableVersions: ['4.0.6', '4.0.7'],
  };
}

const beforeExpiry = Date.parse('2026-11-18T00:00:00Z');
const afterExpiry = Date.parse('2026-11-25T00:00:00Z');

test('allows only the pinned advisory through its known full and published lint-plugin paths', () => {
  assert.doesNotThrow(() => verifyAuditReports(reports(), beforeExpiry));
});

test('rejects a different high advisory, including one attached to an inherited finding', () => {
  const input = reports();
  input.full.vulnerabilities.tinyglobby.via.push({
    name: 'tinyglobby',
    severity: 'high',
    url: 'https://example.com/other',
  });
  assert.throws(() => verifyAuditReports(input, beforeExpiry));
});

test('rejects an additional inherited high package outside the approved installation', () => {
  const input = reports();
  input.full.vulnerabilities.other = finding('other', ['picomatch']);
  input.full.metadata.vulnerabilities.high += 1;
  assert.throws(() => verifyAuditReports(input, beforeExpiry));
});

test('rejects a new dev-tool path even when its package is already permitted', () => {
  const input = reports();
  input.fullTree.dependencies['@changesets/cli'].dependencies['@changesets/pre'] = {
    dependencies: { picomatch: { version: '4.0.7' } },
  };
  assert.throws(() => verifyAuditReports(input, beforeExpiry));
});

test('rejects a high finding present only in the production audit', () => {
  const input = reports();
  input.production.vulnerabilities.other = finding('other', [
    { name: 'other', severity: 'high', url: 'https://example.com/other' },
  ]);
  input.production.metadata.vulnerabilities.high += 1;
  assert.throws(() => verifyAuditReports(input, beforeExpiry));
});

test('rejects SDK runtime exposure and a changed published plugin dependency path', () => {
  const runtime = reports();
  runtime.sdkTree.dependencies = { picomatch: { version: '4.0.7' } };
  assert.throws(() => verifyAuditReports(runtime, beforeExpiry));

  const plugin = reports();
  delete plugin.productionTree.dependencies['@adcp/eslint-plugin'].dependencies['@typescript-eslint/utils'];
  assert.throws(() => verifyAuditReports(plugin, beforeExpiry));

  const addedPath = reports();
  addedPath.productionTree.dependencies['@adcp/other'] = { dependencies: { picomatch: { version: '4.0.7' } } };
  assert.throws(() => verifyAuditReports(addedPath, beforeExpiry));
});

test('rejects a different lock version or a newer stable release', () => {
  const lock = reports();
  lock.lock.packages['node_modules/picomatch'].version = '4.0.8';
  assert.throws(() => verifyAuditReports(lock, beforeExpiry));

  const release = reports();
  release.availableVersions.push('4.0.8');
  assert.throws(() => verifyAuditReports(release, beforeExpiry));
});

test('rejects the exception at its exact expiry', () => {
  assert.throws(() => verifyAuditReports(reports(), afterExpiry));
});

test('rejects audit and registry failures', () => {
  const audit = reports();
  audit.full = { error: { code: 'ECONNRESET' } };
  assert.throws(() => verifyAuditReports(audit, beforeExpiry));

  const registry = reports();
  registry.availableVersions = { error: { code: 'E500' } };
  assert.throws(() => verifyAuditReports(registry, beforeExpiry));

  const dependencyTree = reports();
  dependencyTree.productionTree.error = { code: 'ELSPROBLEMS' };
  assert.throws(() => verifyAuditReports(dependencyTree, beforeExpiry));

  const problems = reports();
  problems.productionTree.problems = ['invalid: picomatch@4.0.7'];
  assert.throws(() => verifyAuditReports(problems, beforeExpiry));

  const nestedError = reports();
  nestedError.productionTree.dependencies['@adcp/eslint-plugin'].error = { code: 'ELSPROBLEMS' };
  assert.throws(() => verifyAuditReports(nestedError, beforeExpiry));

  const invalidLeaf = reports();
  invalidLeaf.productionTree.dependencies['@adcp/eslint-plugin'].dependencies['@typescript-eslint/utils'].dependencies[
    '@typescript-eslint/typescript-estree'
  ].dependencies.tinyglobby.dependencies.picomatch.invalid = true;
  assert.throws(() => verifyAuditReports(invalidLeaf, beforeExpiry));

  const incompleteAudit = reports();
  incompleteAudit.full.metadata.vulnerabilities.high = 5;
  assert.throws(() => verifyAuditReports(incompleteAudit, beforeExpiry));
});

test('needs no exception when both audits have no high or critical findings', () => {
  const input = reports();
  input.full = { metadata: { vulnerabilities: { high: 0, critical: 0 } }, vulnerabilities: {} };
  input.production = structuredClone(input.full);
  assert.doesNotThrow(() => verifyAuditReports(input, afterExpiry));
});

test('the CLI fails when its audit files cannot be read', () => {
  const script = path.join(__dirname, 'verify-scoped-audit-exception.cjs');
  const result = spawnSync(process.execPath, [script, '/nonexistent-scoped-audit-input'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
