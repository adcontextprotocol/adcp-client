// Smoke test for the @adcp/sdk/compliance umbrella export.
//
// TypeScript's TS2308 catches re-export collisions at compile time, so this
// test isn't about collision detection — it's about visibility. If a symbol
// gets accidentally removed from one of the four source modules during a
// refactor, the umbrella silently drops it; this test surfaces that as a
// failing assertion rather than a missing import in a downstream consumer.
//
// Lists are representative, not exhaustive — adding new symbols to the
// source modules does not require updating this test, only removing one
// that's listed here does.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const compliance = require('../../dist/lib/compliance/index.js');

describe('@adcp/sdk/compliance umbrella', () => {
  test('re-exports key testing symbols', () => {
    for (const name of [
      'testAgent',
      'createTestAgent',
      'TEST_AGENT_TOKEN',
      'comply',
      'runStoryboard',
      'parseStoryboard',
      'createComplyController',
      'expectControllerSuccess',
      'expectControllerError',
      'registerAssertion',
    ]) {
      assert.ok(compliance[name] !== undefined, `Expected umbrella to re-export ${name} from testing/`);
    }
  });

  test('re-exports key conformance symbols', () => {
    for (const name of ['runConformance', 'seedFixtures', 'DEFAULT_TOOLS', 'STATELESS_TIER_TOOLS']) {
      assert.ok(compliance[name] !== undefined, `Expected umbrella to re-export ${name} from conformance/`);
    }
  });

  test('re-exports key compliance-fixtures symbols', () => {
    for (const name of ['COMPLIANCE_FIXTURES', 'COMPLIANCE_COLLECTIONS', 'seedComplianceFixtures']) {
      assert.ok(compliance[name] !== undefined, `Expected umbrella to re-export ${name} from compliance-fixtures/`);
    }
  });

  test('re-exports key signing/testing symbols', () => {
    for (const name of ['InMemorySigningProvider', 'ALLOW_IN_MEMORY_SIGNER_ENV', 'signerKeyToProvider']) {
      assert.ok(compliance[name] !== undefined, `Expected umbrella to re-export ${name} from signing/testing.ts`);
    }
  });
});
