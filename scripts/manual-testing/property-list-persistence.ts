#!/usr/bin/env tsx
/**
 * Reproduces the property list persistence bug on the test agent.
 *
 * Creates a property list, then immediately tries to retrieve it by ID.
 * The create call succeeds and returns a list_id, but the get call
 * returns "not_found" for that same ID.
 *
 * Usage:
 *   npx tsx scripts/manual-testing/property-list-persistence.ts
 *
 * Expected: get_property_list returns the list we just created.
 * Actual:   get_property_list returns adcp_error code "not_found".
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const AGENT_URL = process.env.ADCP_TEST_URL ?? 'https://test-agent.adcontextprotocol.org/mcp/';
const AUTH_TOKEN = process.env.ADCP_TEST_TOKEN;

if (!AUTH_TOKEN) {
  console.error('Set ADCP_TEST_TOKEN to the public test agent token (same as bin/adcp.js test-mcp alias)');
  process.exit(1);
}

async function main() {
  // Connect
  const transport = new StreamableHTTPClientTransport(new URL(AGENT_URL), {
    requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
  });
  const client = new Client({ name: 'property-list-repro', version: '1.0.0' });
  await client.connect(transport);
  console.log('Connected to', AGENT_URL);

  // Step 1: Create a property list
  const createResult = await client.callTool({
    name: 'create_property_list',
    arguments: {
      name: `Repro Test List ${Date.now()}`,
      description: 'Testing property list persistence',
      base_properties: [
        {
          selection_type: 'identifiers',
          identifiers: [
            { type: 'domain', value: 'outdoormagazine.example' },
            { type: 'domain', value: 'hikingtrails.example' },
          ],
        },
      ],
      brand: { domain: 'acmeoutdoor.example' },
      context: { correlation_id: 'repro-create' },
    },
  });

  const createData = JSON.parse(
    (createResult.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  const listId = createData?.list?.list_id;
  console.log('\n=== CREATE ===');
  console.log('list_id:', listId);
  console.log('Response:', JSON.stringify(createData, null, 2).slice(0, 400));

  if (!listId) {
    console.error('\nFAIL: create_property_list did not return a list_id');
    await client.close();
    process.exit(1);
  }

  // Step 2: Immediately retrieve it — same MCP session, same connection
  const getResult = await client.callTool({
    name: 'get_property_list',
    arguments: {
      list_id: listId,
      brand: { domain: 'acmeoutdoor.example' },
      context: { correlation_id: 'repro-get' },
    },
  });

  const getData = JSON.parse(
    (getResult.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  console.log('\n=== GET (same session, with brand) ===');
  console.log('Response:', JSON.stringify(getData, null, 2).slice(0, 400));

  // Step 3: Try without brand — tests if session key differs
  const getResultNoBrand = await client.callTool({
    name: 'get_property_list',
    arguments: {
      list_id: listId,
      context: { correlation_id: 'repro-get-no-brand' },
    },
  });

  const getDataNoBrand = JSON.parse(
    (getResultNoBrand.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  console.log('\n=== GET (same session, without brand) ===');
  console.log('Response:', JSON.stringify(getDataNoBrand, null, 2).slice(0, 400));

  // Step 4: Try with wrong brand — tests cross-brand isolation
  const getResultWrongBrand = await client.callTool({
    name: 'get_property_list',
    arguments: {
      list_id: listId,
      brand: { domain: 'test.example' },
      context: { correlation_id: 'repro-get-wrong-brand' },
    },
  });

  const getDataWrongBrand = JSON.parse(
    (getResultWrongBrand.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  console.log('\n=== GET (same session, brand=test.example) ===');
  console.log('Response:', JSON.stringify(getDataWrongBrand, null, 2).slice(0, 400));

  // Step 5: List all — should include our list
  const listResult = await client.callTool({
    name: 'list_property_lists',
    arguments: {
      brand: { domain: 'acmeoutdoor.example' },
      context: { correlation_id: 'repro-list' },
    },
  });

  const listData = JSON.parse(
    (listResult.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  console.log('\n=== LIST (brand=acmeoutdoor.example) ===');
  console.log('lists count:', listData?.lists?.length ?? 0);
  console.log('Response:', JSON.stringify(listData, null, 2).slice(0, 400));

  // Verdict
  const getFound = !getData?.adcp_error;
  const getNoBrandFound = !getDataNoBrand?.adcp_error;
  const getWrongBrandFound = !getDataWrongBrand?.adcp_error;
  const listFound = (listData?.lists?.length ?? 0) > 0;

  console.log('\n=== VERDICT ===');
  console.log(`CREATE brand:               acmeoutdoor.example`);
  console.log(`GET brand=acmeoutdoor:      ${getFound ? 'FOUND ✓' : 'NOT FOUND ✗'}`);
  console.log(`GET no brand:               ${getNoBrandFound ? 'FOUND ✓' : 'NOT FOUND ✗'}`);
  console.log(`GET brand=test.example:     ${getWrongBrandFound ? 'FOUND ✓' : 'NOT FOUND ✗'}`);
  console.log(`LIST brand=acmeoutdoor:     ${listFound ? 'HAS ENTRIES ✓' : 'EMPTY ✗'}`);

  if (getFound && !getNoBrandFound) {
    console.log('\nSESSION KEY MISMATCH: brand in args determines lookup scope.');
    console.log('The storyboard request builders must pass brand on every call,');
    console.log('not just create. This is a client bug, not an agent bug.');
  } else if (!getFound) {
    console.log('\nBUG: list not found even with matching brand. Agent persistence issue.');
  } else {
    console.log('\nAll lookups work. No persistence issue.');
  }

  await client.close();

  // ════════════════════════════════════════════════════════════
  // Test 2: Same brand everywhere (test.example)
  //
  // This isolates whether persistence works at all when brand
  // is consistent across create → get → list → delete.
  // ════════════════════════════════════════════════════════════

  console.log('\n\n════════════════════════════════════════════════════');
  console.log('TEST 2: Consistent brand (test.example) throughout');
  console.log('════════════════════════════════════════════════════');

  const transport2 = new StreamableHTTPClientTransport(new URL(AGENT_URL), {
    requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
  });
  const client2 = new Client({ name: 'property-list-repro-2', version: '1.0.0' });
  await client2.connect(transport2);
  console.log('Connected (new session)');

  const BRAND = { domain: 'test.example' };

  // Create
  const cr2 = await client2.callTool({
    name: 'create_property_list',
    arguments: {
      name: `Repro Test.example List ${Date.now()}`,
      description: 'Testing persistence with test.example brand',
      base_properties: [
        {
          selection_type: 'identifiers',
          identifiers: [{ type: 'domain', value: 'test.example' }],
        },
      ],
      brand: BRAND,
      context: { correlation_id: 'repro2-create' },
    },
  });
  const cd2 = JSON.parse(
    (cr2.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  const lid2 = cd2?.list?.list_id;
  console.log('\n--- CREATE (brand=test.example) ---');
  console.log('list_id:', lid2);

  if (!lid2) {
    console.error('FAIL: create did not return list_id');
    await client2.close();
    process.exit(1);
  }

  // Get — same brand
  const gr2 = await client2.callTool({
    name: 'get_property_list',
    arguments: {
      list_id: lid2,
      brand: BRAND,
      context: { correlation_id: 'repro2-get' },
    },
  });
  const gd2 = JSON.parse(
    (gr2.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  const getOk2 = !gd2?.adcp_error;
  console.log(`--- GET (brand=test.example) → ${getOk2 ? 'FOUND ✓' : 'NOT FOUND ✗'} ---`);
  if (!getOk2) console.log('   ', JSON.stringify(gd2).slice(0, 200));

  // List — same brand
  const lr2 = await client2.callTool({
    name: 'list_property_lists',
    arguments: {
      brand: BRAND,
      context: { correlation_id: 'repro2-list' },
    },
  });
  const ld2 = JSON.parse(
    (lr2.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  const listOk2 = (ld2?.lists?.length ?? 0) > 0;
  const ourList = ld2?.lists?.find((l: Record<string, unknown>) => l.list_id === lid2);
  console.log(`--- LIST (brand=test.example) → ${listOk2 ? `${ld2.lists.length} entries` : 'EMPTY ✗'} ---`);
  console.log(`    Our list (${lid2}): ${ourList ? 'PRESENT ✓' : 'MISSING ✗'}`);

  // Delete — same brand
  const dr2 = await client2.callTool({
    name: 'delete_property_list',
    arguments: {
      list_id: lid2,
      brand: BRAND,
      context: { correlation_id: 'repro2-delete' },
    },
  });
  const dd2 = JSON.parse(
    (dr2.content as Array<{ type: string; text?: string }>).find(c => c.type === 'text')?.text ?? '{}'
  );
  const deleteOk2 = !dd2?.adcp_error;
  console.log(`--- DELETE (brand=test.example) → ${deleteOk2 ? 'OK ✓' : 'FAILED ✗'} ---`);
  if (!deleteOk2) console.log('   ', JSON.stringify(dd2).slice(0, 200));

  console.log('\n=== TEST 2 VERDICT ===');
  console.log(`CREATE:  ✓ (list_id: ${lid2})`);
  console.log(`GET:     ${getOk2 ? '✓' : '✗ — agent cannot find list it just created'}`);
  console.log(`LIST:    ${ourList ? '✓' : '✗ — list missing from listing'}`);
  console.log(`DELETE:  ${deleteOk2 ? '✓' : '✗ — agent cannot delete list it just created'}`);

  if (getOk2 && ourList && deleteOk2) {
    console.log('\nPersistence works with consistent brand. The issue is brand mismatch between calls.');
  } else {
    console.log('\nPersistence broken even with consistent brand. This is an agent bug.');
    console.log('All calls used brand: { domain: "test.example" } — no mismatch possible.');
  }

  await client2.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
