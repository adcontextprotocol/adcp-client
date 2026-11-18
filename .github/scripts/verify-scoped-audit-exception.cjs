'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const advisoryUrl = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const expiry = Date.parse('2026-11-25T00:00:00Z');
const permittedFullHigh = new Set([
  '@changesets/apply-release-plan',
  '@changesets/cli',
  '@changesets/config',
  '@changesets/git',
  '@changesets/pre',
  '@changesets/read',
  '@manypkg/find-root',
  '@manypkg/get-packages',
  '@manypkg/tools',
  '@oclif/core',
  '@typescript-eslint/typescript-estree',
  'fdir',
  'json-schema-to-typescript',
  'picomatch',
  'sucrase',
  'tinyglobby',
  'tsup',
]);
const permittedProductionHigh = new Set(['picomatch', 'fdir', 'tinyglobby', '@typescript-eslint/typescript-estree']);
const permittedFullPaths = [
  '@changesets/cli > @changesets/config > picomatch',
  '@changesets/cli > @changesets/git > picomatch',
  'json-schema-to-typescript > tinyglobby > fdir > picomatch',
  'json-schema-to-typescript > tinyglobby > picomatch',
].sort();
const permittedProductionPaths = [
  '@adcp/eslint-plugin > @typescript-eslint/utils > @typescript-eslint/typescript-estree > tinyglobby > fdir > picomatch',
  '@adcp/eslint-plugin > @typescript-eslint/utils > @typescript-eslint/typescript-estree > tinyglobby > picomatch',
].sort();

function highFindings(audit) {
  assert.ok(
    audit && !audit.error && audit.metadata?.vulnerabilities && audit.vulnerabilities,
    'npm audit did not return a vulnerability report'
  );
  const findings = new Map(
    Object.entries(audit.vulnerabilities).filter(
      ([, finding]) => finding.severity === 'high' || finding.severity === 'critical'
    )
  );
  assert.equal(
    findings.size,
    audit.metadata.vulnerabilities.high + audit.metadata.vulnerabilities.critical,
    'npm audit high and critical counts do not match its findings'
  );
  return findings;
}

function verifyAdvisoryRoot(findings) {
  const root = findings.get('picomatch');
  assert.ok(root, 'High findings are not rooted in picomatch');
  assert.equal(root.range, '*');
  assert.deepEqual(root.nodes, ['node_modules/picomatch']);
  assert.ok(Array.isArray(root.via), 'picomatch advisory details are absent');
  const direct = root.via.filter(item => typeof item === 'object');
  assert.equal(direct.length, 1, 'picomatch has additional direct advisories');
  assert.equal(direct[0].name, 'picomatch');
  assert.equal(direct[0].url, advisoryUrl);
  assert.equal(direct[0].severity, 'high');
  assert.equal(direct[0].range, '<=4.0.7');
}

function followsOnlyException(findings, name, seen = new Set()) {
  if (name === 'picomatch') return;
  assert.ok(!seen.has(name), 'Unexpected npm audit dependency cycle');
  seen.add(name);
  const finding = findings.get(name);
  assert.ok(finding && Array.isArray(finding.via), 'Missing high-severity dependency in audit graph');
  const directHigh = finding.via.filter(
    item => typeof item === 'object' && (item.severity === 'high' || item.severity === 'critical')
  );
  assert.equal(directHigh.length, 0, 'Additional direct high or critical advisory');
  const parents = finding.via.filter(item => typeof item === 'string' && findings.has(item));
  assert.ok(parents.length > 0, 'High finding has no path to scoped advisory');
  for (const parent of parents) followsOnlyException(findings, parent, new Set(seen));
}

function assertValidDependencyNode(tree) {
  assert.ok(
    tree && typeof tree === 'object' && !tree.error && !tree.invalid && !tree.missing,
    'npm ls returned an invalid dependency tree'
  );
  assert.ok(
    tree.problems === undefined || (Array.isArray(tree.problems) && tree.problems.length === 0),
    'npm ls reported dependency problems'
  );
}

function picomatchPaths(tree, prefix = []) {
  assertValidDependencyNode(tree);
  const paths = [];
  for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
    assertValidDependencyNode(dependency);
    const current = [...prefix, name];
    if (name === 'picomatch') {
      assert.equal(dependency.version, '4.0.7', 'Production picomatch version changed');
      paths.push(current.join(' > '));
    } else {
      paths.push(...picomatchPaths(dependency, current));
    }
  }
  return paths;
}

function verifyAuditReports(input, now = Date.now()) {
  const { full, production, sdkTree, fullTree, productionTree, lock, availableVersions } = input;
  const high = highFindings(full);
  const productionHigh = highFindings(production);
  if (high.size === 0) {
    assert.equal(productionHigh.size, 0, 'Production audit has a high finding absent from full audit');
    return { exceptionUsed: false, inheritedFindings: [] };
  }

  assert.ok(now < expiry, 'GHSA-fc5q-39xc-vjpf exception expired');
  assert.equal(
    lock.packages?.['node_modules/picomatch']?.version,
    '4.0.7',
    'Exception applies only to locked picomatch 4.0.7'
  );
  assertValidDependencyNode(sdkTree);
  assert.equal(sdkTree.name, '@adcp/sdk');
  assert.ok(
    !sdkTree.dependencies || Object.keys(sdkTree.dependencies).length === 0,
    'picomatch appeared in the SDK production dependency tree'
  );
  assert.equal(fullTree.name, '@adcp/sdk');
  assert.deepEqual(picomatchPaths(fullTree).sort(), permittedFullPaths, 'Installed picomatch dependency paths changed');
  assert.equal(productionTree.name, '@adcp/sdk');
  assert.deepEqual(
    picomatchPaths(productionTree).sort(),
    permittedProductionPaths,
    'Production picomatch dependency paths changed'
  );

  assert.ok(Array.isArray(availableVersions), 'Could not check the npm picomatch release list');
  const newerStable = availableVersions.some(version => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    return major > 4 || (major === 4 && (minor > 0 || (minor === 0 && patch > 7)));
  });
  assert.ok(!newerStable, 'A newer stable picomatch release exists; review and update the dependency');

  verifyAdvisoryRoot(high);
  for (const name of high.keys()) {
    assert.ok(permittedFullHigh.has(name), 'New high finding needs review');
    followsOnlyException(high, name);
  }
  verifyAdvisoryRoot(productionHigh);
  for (const name of productionHigh.keys()) {
    assert.ok(permittedProductionHigh.has(name), 'New production high finding needs review');
    assert.ok(high.has(name), 'Production high finding absent from full audit');
    followsOnlyException(productionHigh, name);
  }
  return { exceptionUsed: true, inheritedFindings: [...high.keys()] };
}

function readReports(directory) {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  return {
    full: read('audit-full.json'),
    production: read('audit-production.json'),
    sdkTree: read('sdk-picomatch-tree.json'),
    fullTree: read('full-picomatch-tree.json'),
    productionTree: read('production-picomatch-tree.json'),
    lock: read('package-lock.json'),
    availableVersions: read('picomatch-versions.json'),
  };
}

if (require.main === module) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Pass the directory containing audit JSON files');
  const result = verifyAuditReports(readReports(directory));
  if (result.exceptionUsed) {
    console.log('Temporary scoped exception: GHSA-fc5q-39xc-vjpf, locked picomatch 4.0.7');
    console.log('Applies only to the published lint plugin paths; expires 2026-11-25 UTC');
    console.log('Inherited high findings:', result.inheritedFindings.join(', '));
  } else {
    console.log('Security audit passed: no high or critical findings');
  }
}

module.exports = { verifyAuditReports };
