/**
 * Drift alarm for the snake_case → kebab-case protocol mapping.
 *
 * When upstream adds a new value to the `supported_protocols` enum in
 * `get-adcp-capabilities-response.json`, the runner's PROTOCOL_TO_DOMAIN map
 * or PROTOCOLS_WITHOUT_BASELINE set must be updated in lockstep. This test
 * reads the enum straight from the cached schema and fails loudly when
 * something's missing.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  PROTOCOL_TO_DOMAIN,
  PROTOCOLS_WITHOUT_BASELINE,
  loadComplianceIndex,
} = require('../../dist/lib/testing/storyboard/index.js');

const SCHEMA_PATH = join(__dirname, '../../schemas/cache/latest/protocol/get-adcp-capabilities-response.json');

function loadSupportedProtocolsEnum() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const items = schema?.properties?.supported_protocols?.items;
  assert.ok(Array.isArray(items?.enum), 'supported_protocols enum missing from response schema');
  return items.enum;
}

describe('protocol→domain mapping drift alarm', () => {
  const enumValues = loadSupportedProtocolsEnum();

  test('every supported_protocols enum value is handled', () => {
    const unknown = enumValues.filter(v => !(v in PROTOCOL_TO_DOMAIN) && !PROTOCOLS_WITHOUT_BASELINE.has(v));
    assert.deepEqual(
      unknown,
      [],
      `These supported_protocols values are not in PROTOCOL_TO_DOMAIN or PROTOCOLS_WITHOUT_BASELINE: ` +
        `${unknown.join(', ')}. Update src/lib/testing/storyboard/compliance.ts when upstream ` +
        `adds a new protocol.`
    );
  });

  test('every mapped domain actually has a baseline in the compliance cache', () => {
    const index = loadComplianceIndex();
    const knownDomainIds = new Set(index.domains.filter(d => d.has_baseline).map(d => d.id));
    const missing = Object.entries(PROTOCOL_TO_DOMAIN)
      .filter(([, domainId]) => !knownDomainIds.has(domainId))
      .map(([protocol, domainId]) => `${protocol} → ${domainId}`);
    assert.deepEqual(
      missing,
      [],
      `These protocols map to domains that have no baseline in the compliance cache: ${missing.join(', ')}. ` +
        `Either upstream doesn't ship the baseline yet, or the mapping points at the wrong domain id.`
    );
  });
});
