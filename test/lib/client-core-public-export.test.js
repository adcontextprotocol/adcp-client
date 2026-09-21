const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const EXPECTED_RUNTIME_EXPORTS = [
  'ADCPMultiAgentClient',
  'AgentClient',
  'CapabilityPreflightError',
  'ConfigurationManager',
  'CreativeAgentClient',
  'InMemoryWebhookRegistrationStore',
  'SingleAgentClient',
  'UnsupportedFeatureError',
  'WebhookDispatchError',
  'createADCPMultiAgentClient',
  'createCreativeAgentClient',
  'createSingleAgentClient',
];

test('@adcp/sdk/client/core exposes the focused client runtime through CommonJS', () => {
  const clientCore = require('@adcp/sdk/client/core');

  for (const name of EXPECTED_RUNTIME_EXPORTS) {
    assert.equal(typeof clientCore[name], 'function', name);
  }
  assert.equal(clientCore.createAdcpServer, undefined);
  assert.equal(clientCore.comply, undefined);
});

function runColdProbe(moduleFormat) {
  const isEsm = moduleFormat === 'esm';
  const load = specifier =>
    isEsm ? `await import(${JSON.stringify(specifier)})` : `require(${JSON.stringify(specifier)})`;
  const script = `
    ${isEsm ? '' : "const { createRequire } = require('node:module');"}
    const core = ${load('@adcp/sdk/client/core')};
    ${
      isEsm
        ? ''
        : `
          const eagerFiles = Object.keys(require.cache);
          for (const excluded of ['schemas.generated.js', 'response-schemas.js', 'tool-request-schemas.js', 'media-buy/compatibility.js']) {
            if (eagerFiles.some(file => file.endsWith(excluded))) throw new Error(excluded + ' loaded eagerly');
          }
        `
    }

    const { unwrapProtocolResponse } = ${load(`./dist/lib/utils/response-unwrapper.${isEsm ? 'mjs' : 'js'}`)};
    const unwrapped = unwrapProtocolResponse(
      { structuredContent: { outcome: 'listed', products: [], feed_version: 'feed-v1', cache_scope: 'public' } },
      'list_products',
      'mcp'
    );
    if (unwrapped.outcome !== 'listed') throw new Error('response schema lazy path failed');

    const { projectV1ProductToV2 } = ${load(`./dist/lib/v2/projection/v1-to-v2.${isEsm ? 'mjs' : 'js'}`)};
    const projected = projectV1ProductToV2(
      {
        product_id: 'custom-product',
        name: 'Custom product',
        description: 'Exercises the lazy generated-schema path',
        format_ids: [{ agent_url: 'https://seller.example/formats', id: 'homepage_takeover' }],
      },
      {
        legacyFormatConverter: () => ({
          format_option_id: 'homepage-takeover',
          format_kind: 'custom',
          format_shape: 'multi_placement_takeover',
          format_schema: {
            uri: 'https://seller.example/formats/homepage_takeover.json',
            digest: 'sha256:' + 'a'.repeat(64),
          },
          params: {},
        }),
      }
    );
    if (projected.diagnostics.length !== 0) throw new Error('projection schema lazy path failed');

    const agent = Object.create(core.AgentClient.prototype);
    agent.getCapabilities = async () => {
      throw new Error('lifecycle module loaded');
    };
    try {
      await agent.negotiateMediaBuyLifecycle();
      throw new Error('expected capability probe');
    } catch (error) {
      if (error.message !== 'lifecycle module loaded') throw error;
    }
  `;
  const args = isEsm ? ['--input-type=module', '--eval', script] : ['--eval', `(async () => {${script}})()`];
  return spawnSync(process.execPath, args, {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
}

for (const moduleFormat of ['cjs', 'esm']) {
  test(`@adcp/sdk/client/core executes on-demand paths in a cold ${moduleFormat.toUpperCase()} process`, () => {
    const result = runColdProbe(moduleFormat);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

test('@adcp/sdk/client/core exposes the focused client runtime through ESM', async () => {
  const clientCore = await import('@adcp/sdk/client/core');

  for (const name of EXPECTED_RUNTIME_EXPORTS) {
    assert.equal(typeof clientCore[name], 'function', name);
  }
  assert.equal(clientCore.createAdcpServer, undefined);
  assert.equal(clientCore.comply, undefined);
});

test('@adcp/sdk/client/core keeps heavy generated-schema surfaces out of its eager graph', () => {
  const entry = path.resolve(__dirname, '../../dist/lib/client/core.mjs');
  const pending = [entry];
  const visited = new Set();
  const staticImport = /(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;

  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    for (const match of readFileSync(file, 'utf8').matchAll(staticImport)) {
      let dependency = path.resolve(path.dirname(file), match[1]);
      if (!path.extname(dependency)) dependency += '.mjs';
      if (existsSync(dependency) && !visited.has(dependency)) pending.push(dependency);
    }
  }

  assert.ok(visited.size <= 210, `focused client eager graph grew to ${visited.size} internal modules`);
  for (const excluded of [
    'types/schemas.generated.mjs',
    'utils/response-schemas.mjs',
    'utils/tool-request-schemas.mjs',
    'media-buy/compatibility.mjs',
  ]) {
    assert.ok(![...visited].some(file => file.endsWith(excluded)), `${excluded} must stay on demand`);
  }
});
