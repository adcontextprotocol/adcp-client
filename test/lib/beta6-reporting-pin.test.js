const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ADCP_VERSION, SingleAgentClient, getCompatibleVersions } = require('../../dist/lib/index.js');
const { resolveAdcpVersion } = require('../../dist/lib/utils/adcp-version-config.js');
const {
  getSchemaDocumentByRef,
  getSchemaValidatorByRef,
  resolveSchemaRoot,
} = require('../../dist/lib/validation/schema-loader.js');

const agent = { id: 'seller', name: 'Seller', agent_uri: 'https://example.com', protocol: 'mcp' };

test('default beta.5 retains inline package creatives while exact beta.6 has its own reporting bundle', () => {
  assert.equal(ADCP_VERSION, '3.3.0-beta.5');
  assert.equal(new SingleAgentClient(agent).getAdcpVersion(), '3.3.0-beta.5');
  assert.equal(new SingleAgentClient(agent, { adcpVersion: '3.3.0-beta.6' }).getAdcpVersion(), '3.3.0-beta.6');

  const beta5Root = resolveSchemaRoot('3.3.0-beta.5');
  const beta6Root = resolveSchemaRoot('3.3.0-beta.6');
  assert.equal(path.basename(beta5Root), '3.3.0-beta.5');
  assert.equal(path.basename(beta6Root), '3.3.0-beta.6');
  assert.notEqual(beta5Root, beta6Root);

  const beta5Package = getSchemaDocumentByRef('media-buy/package-request.json', '3.3.0-beta.5');
  assert.ok(beta5Package.schema.properties.creatives);
  const beta6Reporting = getSchemaDocumentByRef('media-buy/get-reporting-status-request.json', '3.3.0-beta.6');
  assert.equal(beta6Reporting.resolvedVersion, '3.3.0-beta.6');
  assert.equal(
    typeof getSchemaValidatorByRef('media-buy/get-reporting-status-request.json', '3.3.0-beta.6'),
    'function'
  );
});

test('the secondary preview requires an exact pin and does not become global compatibility', () => {
  assert.equal(resolveAdcpVersion('3.3.0-beta.6'), '3.3.0-beta.6');
  assert.throws(() => resolveAdcpVersion('3.3.0-beta.4'), /no schema bundle for that key ships/);
  assert.throws(() => resolveAdcpVersion('3.3-beta'), /moving prerelease-family alias/);
  assert.ok(!getCompatibleVersions().includes('3.3.0-beta.6'));
  assert.ok(!getCompatibleVersions().includes('3.3-beta.6'));
});
