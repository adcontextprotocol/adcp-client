const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// The reporting-interop orchestrators run the TypeScript seller on the SDK's
// own adcp_version, NOT on pins.adcp_schema_version — that pin records the
// protocol an immutable, independently verified Python artifact was validated
// against, and the two legitimately diverge whenever this SDK adopts a newer
// bundle. `typescript_protocol()` is what keeps that split honest, so it needs
// its own fail-closed coverage: it replaced an identity assertion, and an
// identity gate with no negative tests is indistinguishable from no gate.

const INTEROP = path.resolve(__dirname, '../../scripts/reporting-interop');

/** Invoke the shared `typescript_protocol` gate against a synthetic checkout. */
function callGate({ checkout, installed }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interop-identity-'));
  try {
    // parents[2] of <root>/scripts/reporting-interop/core.py is <root>.
    const scriptDir = path.join(root, 'scripts', 'reporting-interop');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify(checkout === undefined ? {} : { adcp_version: checkout })
    );
    const pkg = installed === undefined ? {} : { adcp_version: installed };
    const driver = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("pi", ${JSON.stringify(path.join(INTEROP, 'protocol_identity.py'))})
pi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pi)
print(pi.typescript_protocol(json.loads(sys.argv[1]), ${JSON.stringify(path.join(scriptDir, 'core.py'))}))
`;
    return {
      ok: true,
      value: execFileSync('python3', ['-I', '-c', driver, JSON.stringify(pkg)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    };
  } catch (error) {
    return { ok: false, stderr: String(error.stderr || error.message) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('matching checkout and installed protocols resolve to the seller protocol', () => {
  const result = callGate({ checkout: '3.2.5', installed: '3.2.5' });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.value, '3.2.5');
});

test('a seller protocol that differs from the immutable Python pin is allowed', () => {
  // This is the whole point of the split: pins.json records 3.2.4 for the
  // verified Python wheel while the SDK has adopted 3.2.5. Before the split
  // this combination was exactly what failed CI.
  const pins = require('../../scripts/reporting-interop/pins.json');
  const result = callGate({ checkout: '3.2.5', installed: '3.2.5' });
  assert.equal(result.ok, true, result.stderr);
  assert.notEqual(result.value, pins.adcp_schema_version, 'fixture must exercise a real divergence');
  assert.equal(pins.adcp_schema_version, '3.2.4', 'the Python artifact pin must not be relabelled');
});

test('a stale or substituted install fails closed', () => {
  const result = callGate({ checkout: '3.2.5', installed: '3.2.4' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /installed SDK adcp_version 3\.2\.4 must equal checkout 3\.2\.5/);
});

for (const [name, input] of [
  ['checkout', { checkout: undefined, installed: '3.2.5' }],
  ['installed', { checkout: '3.2.5', installed: undefined }],
]) {
  test(`a missing ${name} adcp_version fails closed`, () => {
    const result = callGate(input);
    assert.equal(result.ok, false);
    assert.match(result.stderr, new RegExp(`missing adcp_version`));
  });
}

test('both protocols missing fails closed rather than comparing undefined to undefined', () => {
  // Without the presence assertions this case passes vacuously: two absent
  // values are equal, so the gate would succeed against no protocol at all.
  const result = callGate({ checkout: undefined, installed: undefined });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /missing adcp_version/);
});
