/** Run with: npx tsx examples/supply-path-verification.ts */
import { verifySupplyPath } from '@adcp/sdk';

async function main(): Promise<void> {
  const owner = process.env.SUPPLY_PATH_OWNER;
  const host = process.env.SUPPLY_PATH_HOST;
  const agent = process.env.SUPPLY_PATH_AGENT;
  const collection = process.env.SUPPLY_PATH_COLLECTION;
  if (!owner || !host || !agent || !collection) {
    throw new Error('Set SUPPLY_PATH_OWNER, SUPPLY_PATH_HOST, SUPPLY_PATH_AGENT and SUPPLY_PATH_COLLECTION');
  }
  const result = await verifySupplyPath(
    {
      owner_domain: owner,
      host_domain: host,
      agent_url: agent,
      collection_id: collection,
    },
    { source: 'authoritative' }
  );
  console.log(JSON.stringify(result, null, 2));
  // Example policy: only the strongest, authoritative supply-path state passes.
  if (result.state !== 'verified_owner_sold') process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
