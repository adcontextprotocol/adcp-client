#!/usr/bin/env node
/**
 * Test script to demonstrate PropertyCrawler fixes with real domains
 */

const { PropertyCrawler } = require('./dist/lib/discovery/property-crawler.js');

async function testRealDomains() {
  console.log('🧪 Testing PropertyCrawler with real domains\n');
  console.log('=' .repeat(80));

  const crawler = new PropertyCrawler({ logLevel: 'info' });

  const testDomains = [
    'www.accuweather.com',
    'weather.com',
    'adcontextprotocol.org'
  ];

  for (const domain of testDomains) {
    console.log(`\n📍 Testing: ${domain}`);
    console.log('-'.repeat(80));

    try {
      const result = await crawler.fetchAdAgentsJson(domain);

      console.log(`✅ Successfully fetched adagents.json`);
      console.log(`   Properties found: ${result.properties.length}`);

      if (result.warning) {
        console.log(`   ⚠️  Warning: ${result.warning}`);
      }

      if (result.properties.length > 0) {
        console.log('\n   📦 Properties:');
        result.properties.forEach((prop, idx) => {
          console.log(`      ${idx + 1}. ${prop.name}`);
          console.log(`         Type: ${prop.property_type}`);
          console.log(`         Identifiers: ${prop.identifiers.map(i => `${i.type}:${i.value}`).join(', ')}`);
          console.log(`         Publisher Domain: ${prop.publisher_domain}`);
        });
      }
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n🎯 Full Crawl Test with Multiple Domains\n');

  // Test the full crawl with fetchPublisherProperties
  const { properties, warnings } = await crawler.fetchPublisherProperties(testDomains);

  console.log(`📊 Summary:`);
  console.log(`   Total domains crawled: ${testDomains.length}`);
  console.log(`   Domains with properties: ${Object.keys(properties).length}`);
  console.log(`   Total warnings: ${warnings.length}`);

  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    warnings.forEach(w => {
      console.log(`   - ${w.domain}: ${w.message}`);
    });
  }

  console.log('\n📦 Properties by domain:');
  for (const [domain, props] of Object.entries(properties)) {
    console.log(`   ${domain}: ${props.length} property(ies)`);
    props.forEach(p => {
      console.log(`      - ${p.name}`);
    });
  }
}

// Run the test
testRealDomains().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
