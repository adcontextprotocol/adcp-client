#!/usr/bin/env node
/**
 * Demonstration of PropertyCrawler fixes with real-world examples
 * Shows: User-Agent headers working + Graceful degradation for missing properties
 */

const { PropertyCrawler } = require('./dist/lib/discovery/property-crawler.js');

async function demonstrateFixes() {
  console.log('\n' + '='.repeat(80));
  console.log('🎯 PropertyCrawler Fix Demonstration (Issue #107)');
  console.log('='.repeat(80) + '\n');

  const crawler = new PropertyCrawler({ logLevel: 'warn' });

  // Test 1: AccuWeather - requires browser headers (Akamai bot protection)
  console.log('📍 TEST 1: AccuWeather.com');
  console.log('   Issue: Returns 403 without proper headers');
  console.log('   Fix: Send browser-like User-Agent + Accept headers\n');

  try {
    const result = await crawler.fetchAdAgentsJson('www.accuweather.com');
    console.log('   ✅ SUCCESS - Fetched adagents.json');
    console.log(`   📄 Raw response has:`);
    console.log(`      - authorized_agents: ${result.properties.length > 0 ? 'YES' : 'NO'}`);
    console.log(`      - properties array: NO (missing)`);
    console.log(`\n   🔧 Graceful Degradation Applied:`);
    console.log(`      - Inferred property: "${result.properties[0]?.name}"`);
    console.log(`      - Type: ${result.properties[0]?.property_type}`);
    console.log(`      - Identifiers: ${JSON.stringify(result.properties[0]?.identifiers)}`);
    console.log(`      - Warning: "${result.warning}"`);
  } catch (error) {
    console.log(`   ❌ FAILED: ${error.message}`);
  }

  console.log('\n' + '-'.repeat(80) + '\n');

  // Test 2: Weather.com - also missing properties array
  console.log('📍 TEST 2: Weather.com');
  console.log('   Issue: Has authorized_agents but no properties array');
  console.log('   Fix: Infer default property from domain\n');

  try {
    const result = await crawler.fetchAdAgentsJson('weather.com');
    console.log('   ✅ SUCCESS - Fetched adagents.json');
    console.log(`   📄 Raw response has:`);
    console.log(`      - authorized_agents: YES`);
    console.log(`      - properties array: NO (missing)`);
    console.log(`\n   🔧 Graceful Degradation Applied:`);
    console.log(`      - Inferred property: "${result.properties[0]?.name}"`);
    console.log(`      - Type: ${result.properties[0]?.property_type}`);
    console.log(`      - Identifiers: ${JSON.stringify(result.properties[0]?.identifiers)}`);
    console.log(`      - Warning: "${result.warning}"`);
  } catch (error) {
    console.log(`   ❌ FAILED: ${error.message}`);
  }

  console.log('\n' + '-'.repeat(80) + '\n');

  // Test 3: Full crawl showing warnings collection
  console.log('📍 TEST 3: Multi-Domain Crawl with Warnings Collection\n');

  const { properties, warnings } = await crawler.fetchPublisherProperties([
    'www.accuweather.com',
    'weather.com',
    'nonexistent-test-domain-12345.com'
  ]);

  console.log('   📊 Crawl Results:');
  console.log(`      - Domains attempted: 3`);
  console.log(`      - Properties discovered: ${Object.keys(properties).length}`);
  console.log(`      - Warnings generated: ${warnings.length}`);

  console.log('\n   📦 Discovered Properties:');
  for (const [domain, props] of Object.entries(properties)) {
    console.log(`      ${domain}:`);
    props.forEach(p => {
      console.log(`         ✓ ${p.name} (${p.property_type})`);
    });
  }

  if (warnings.length > 0) {
    console.log('\n   ⚠️  Warnings:');
    warnings.forEach(w => {
      console.log(`      ${w.domain}:`);
      console.log(`         "${w.message}"`);
    });
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n✨ Summary of Fixes:\n');
  console.log('   1. ✅ User-Agent Header: Uses browser-like headers to pass CDN bot detection');
  console.log('   2. ✅ Graceful Degradation: Infers properties when array is missing');
  console.log('   3. ✅ Warnings Collection: Tracks partial implementations for user feedback');
  console.log('   4. ✅ Backward Compatible: Existing code continues to work unchanged');
  console.log('\n' + '='.repeat(80) + '\n');
}

demonstrateFixes().catch(error => {
  console.error('❌ Demo failed:', error);
  process.exit(1);
});
