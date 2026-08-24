const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

function createTestKitCache(version, { declaredVersion = version, publishedVersion } = {}) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-test-kit-line-'));
  const complianceDir = path.join(tempRoot, 'compliance', 'cache', version);
  const testKitDir = path.join(complianceDir, 'test-kits');
  mkdirSync(testKitDir, { recursive: true });
  writeFileSync(
    path.join(complianceDir, 'index.json'),
    JSON.stringify({
      adcp_version: declaredVersion,
      ...(publishedVersion && { published_version: publishedVersion }),
      generated_at: new Date(0).toISOString(),
      universal: [],
      protocols: [],
      specialisms: [],
    })
  );
  const testKitPath = path.join(testKitDir, 'seller.yaml');
  writeFileSync(testKitPath, '{}\n');
  const storyboardPath = path.join(tempRoot, 'storyboard.yaml');
  writeFileSync(
    storyboardPath,
    [
      'id: test-kit-line',
      'title: Test-kit compliance line',
      'protocol: media-buy',
      'phases:',
      '  - id: phase',
      '    title: Phase',
      '    steps:',
      '      - id: capabilities',
      '        title: Capabilities',
      '        task: get_adcp_capabilities',
      '        request: {}',
      '',
    ].join('\n')
  );
  return { tempRoot, complianceDir, testKitPath, storyboardPath };
}

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

describe('storyboard run --test-kit compliance-line selection', () => {
  test('rejects an explicit mixed line before contacting the agent', () => {
    const fixture = createTestKitCache('3.1.13');
    try {
      const result = runCli([
        'storyboard',
        'run',
        'https://127.0.0.1:1/mcp',
        '--protocol',
        'mcp',
        '--test-kit',
        fixture.testKitPath,
        '--compliance-version',
        '3.0.12',
      ]);

      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /targets AdCP 3\.1\.13/);
      assert.match(result.stderr, /--compliance-version 3\.0\.12/);
      assert.match(result.stderr, new RegExp(fixture.testKitPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(result.stderr, /ECONNREFUSED|Failed to detect protocol/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('reports both lines and paths as structured JSON', () => {
    const fixture = createTestKitCache('3.1.13');
    try {
      const result = runCli([
        'storyboard',
        'run',
        'https://127.0.0.1:1/mcp',
        '--protocol',
        'mcp',
        '--test-kit',
        fixture.testKitPath,
        '--compliance-version',
        '3.0.12',
        '--json',
      ]);

      assert.strictEqual(result.status, 2);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.success, false);
      assert.strictEqual(payload.error.code, 'TEST_KIT_COMPLIANCE_VERSION_MISMATCH');
      assert.strictEqual(payload.error.test_kit_version, '3.1.13');
      assert.strictEqual(payload.error.compliance_version, '3.0.12');
      assert.strictEqual(payload.error.test_kit_path, fixture.testKitPath);
      assert.strictEqual(payload.error.compliance_version_source, '--compliance-version');
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('infers the cache line from published_version for a dry-run', () => {
    const fixture = createTestKitCache('3.0.12', { declaredVersion: 'latest', publishedVersion: '3.0.12' });
    try {
      const result = runCli([
        'storyboard',
        'run',
        'test-mcp',
        '--file',
        fixture.storyboardPath,
        '--test-kit',
        fixture.testKitPath,
        '--dry-run',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /Running storyboard: Test-kit compliance line/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('repairs latest metadata from an explicit schema root before selecting the line', () => {
    const fixture = createTestKitCache('latest', { declaredVersion: 'latest', publishedVersion: 'latest' });
    const schemaRoot = path.join(fixture.tempRoot, 'external-schemas');
    mkdirSync(schemaRoot, { recursive: true });
    writeFileSync(path.join(schemaRoot, 'index.json'), JSON.stringify({ adcp_version: '3.0.12' }));
    try {
      const result = runCli([
        'storyboard',
        'run',
        'test-mcp',
        '--file',
        fixture.storyboardPath,
        '--test-kit',
        fixture.testKitPath,
        '--schema-root',
        schemaRoot,
        '--dry-run',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /Running storyboard: Test-kit compliance line/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('repairs latest metadata when published_version is malformed', () => {
    const fixture = createTestKitCache('latest', { declaredVersion: 'latest', publishedVersion: 'unknown' });
    const schemaRoot = path.join(fixture.tempRoot, 'external-schemas');
    mkdirSync(schemaRoot, { recursive: true });
    writeFileSync(path.join(schemaRoot, 'index.json'), JSON.stringify({ adcp_version: '3.0.12' }));
    try {
      const result = runCli([
        'storyboard',
        'run',
        'test-mcp',
        '--file',
        fixture.storyboardPath,
        '--test-kit',
        fixture.testKitPath,
        '--schema-root',
        schemaRoot,
        '--dry-run',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /Running storyboard: Test-kit compliance line/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('repairs latest metadata from a sibling schema bundle before selecting the line', () => {
    const fixture = createTestKitCache('latest', { declaredVersion: 'latest', publishedVersion: 'latest' });
    const siblingSchemaRoot = path.join(fixture.tempRoot, 'schemas', 'cache', '3.0.12');
    mkdirSync(siblingSchemaRoot, { recursive: true });
    writeFileSync(path.join(siblingSchemaRoot, 'index.json'), JSON.stringify({ adcp_version: '3.0.12' }));
    try {
      const result = runCli([
        'storyboard',
        'run',
        'test-mcp',
        '--file',
        fixture.storyboardPath,
        '--test-kit',
        fixture.testKitPath,
        '--dry-run',
      ]);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stderr, /Running storyboard: Test-kit compliance line/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects an explicit compliance directory without version metadata before network access', () => {
    const fixture = createTestKitCache('3.1.13');
    const invalidComplianceDir = path.join(fixture.tempRoot, 'invalid-compliance');
    mkdirSync(invalidComplianceDir, { recursive: true });
    try {
      const result = runCli([
        'storyboard',
        'run',
        'https://127.0.0.1:1/mcp',
        '--protocol',
        'mcp',
        '--test-kit',
        fixture.testKitPath,
        '--compliance-dir',
        invalidComplianceDir,
      ]);

      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /has no index\.json with resolvable/);
      assert.doesNotMatch(result.stderr, /ECONNREFUSED|Failed to detect protocol/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects internally inconsistent compliance metadata', () => {
    const fixture = createTestKitCache('3.1.13', {
      declaredVersion: '3.1.13',
      publishedVersion: '3.0.12',
    });
    try {
      const result = runCli([
        'storyboard',
        'run',
        'https://127.0.0.1:1/mcp',
        '--protocol',
        'mcp',
        '--test-kit',
        fixture.testKitPath,
      ]);

      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /disagrees internally/);
      assert.match(result.stderr, /adcp_version is 3\.1\.13/);
      assert.match(result.stderr, /published_version is 3\.0\.12/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects cache metadata with no declared version', () => {
    const fixture = createTestKitCache('missing-version');
    writeFileSync(
      path.join(fixture.complianceDir, 'index.json'),
      JSON.stringify({ generated_at: new Date(0).toISOString(), universal: [], protocols: [], specialisms: [] })
    );
    try {
      const result = runCli([
        'storyboard',
        'run',
        'https://127.0.0.1:1/mcp',
        '--protocol',
        'mcp',
        '--test-kit',
        fixture.testKitPath,
      ]);

      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /missing adcp_version and published_version/);
      assert.doesNotMatch(result.stderr, /ECONNREFUSED|Failed to detect protocol/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('finds cache metadata above deeply nested test-kit paths', () => {
    const fixture = createTestKitCache('3.1.13');
    const deepDir = path.join(fixture.complianceDir, 'test-kits', ...Array.from({ length: 15 }, (_, i) => `d${i}`));
    mkdirSync(deepDir, { recursive: true });
    const deepTestKitPath = path.join(deepDir, 'seller.yaml');
    writeFileSync(deepTestKitPath, '{}\n');
    try {
      const result = runCli([
        'storyboard',
        'run',
        'https://127.0.0.1:1/mcp',
        '--protocol',
        'mcp',
        '--test-kit',
        deepTestKitPath,
        '--compliance-version',
        '3.0.12',
      ]);

      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /targets AdCP 3\.1\.13/);
      assert.match(result.stderr, /--compliance-version 3\.0\.12/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('fails clearly when the inferred line has no installed schema bundle', () => {
    const fixture = createTestKitCache('9.9.0-beta.1');
    try {
      const result = runCli([
        'storyboard',
        'run',
        'test-mcp',
        '--file',
        fixture.storyboardPath,
        '--test-kit',
        fixture.testKitPath,
        '--dry-run',
      ]);

      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /AdCP compliance version "9\.9\.0-beta\.1"/);
      assert.match(result.stderr, /--schema-root/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('malformed test-kit YAML never echoes source credentials', () => {
    const fixture = createTestKitCache('3.2.0-beta.6');
    const secret = 'sk-cli-secret-that-must-not-reach-stderr';
    writeFileSync(fixture.testKitPath, `auth: [${secret}`);
    try {
      const result = runCli([
        'storyboard',
        'run',
        'https://127.0.0.1:1/mcp',
        '--protocol',
        'mcp',
        '--test-kit',
        fixture.testKitPath,
      ]);

      assert.strictEqual(result.status, 2);
      assert.match(result.stderr, /failed to parse test-kit.*as YAML/);
      assert.equal(result.stderr.includes(secret), false);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('a falsy parsed --test-kit is forwarded and rejected instead of falling back to disk', () => {
    const fixture = createTestKitCache('3.2.0-beta.6');
    writeFileSync(fixture.testKitPath, 'null\n');
    try {
      const result = runCli([
        'storyboard',
        'run',
        'https://127.0.0.1:1/mcp',
        '--protocol',
        'mcp',
        '--test-kit',
        fixture.testKitPath,
        '--file',
        fixture.storyboardPath,
      ]);

      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /test_kit must be a YAML mapping/);
      assert.doesNotMatch(result.stderr, /ECONNREFUSED|Failed to detect protocol/);
    } finally {
      rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  test('storyboard step forwards an explicit test-kit override instead of silently ignoring it', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adcp-step-test-kit-'));
    const testKitPath = path.join(tempRoot, 'override.yaml');
    writeFileSync(testKitPath, 'null\n');
    try {
      const result = runCli([
        'storyboard',
        'step',
        'https://127.0.0.1:1/mcp',
        'comply_controller_mode_gate',
        'deny_live_caller',
        '--protocol',
        'mcp',
        '--test-kit',
        testKitPath,
      ]);

      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /test_kit must be a YAML mapping/);
      assert.doesNotMatch(result.stderr, /ECONNREFUSED|Failed to detect protocol/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('help documents --test-kit and its relationship to --compliance-version', () => {
    const result = runCli(['storyboard', 'run', '--help']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /--test-kit PATH/);
    assert.match(result.stdout, /--compliance-version VERSION/);
    assert.match(result.stdout, /explicit mismatch is rejected/);
  });
});
