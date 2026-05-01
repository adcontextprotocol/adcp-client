#!/usr/bin/env tsx
// Inspect Wonderstruck's tools/list to see the actual `brand` declaration
// so we can write the correct aliasing guard.
import { config as loadEnv } from 'dotenv';
loadEnv();
import { ADCPMultiAgentClient } from '../src/lib';

async function main(): Promise<void> {
  const client = ADCPMultiAgentClient.fromEnv();
  const id = client.getAgentIds().find(id => /wonder/i.test(client.agent(id).getAgent().name));
  if (!id) throw new Error('Wonderstruck not configured');
  const agent = client.agent(id);
  const inner = (agent as any).client;
  await inner.getCapabilities(); // populates cachedToolSchemas
  const schemas = inner.cachedToolSchemas as Map<string, Record<string, unknown>>;
  for (const tool of ['get_products', 'create_media_buy']) {
    const props = schemas.get(tool);
    console.log(`\n=== ${tool} brand declaration ===`);
    console.log(JSON.stringify(props?.brand, null, 2));
  }
}
main().catch(err => {
  console.error(err);
  process.exit(1);
});
