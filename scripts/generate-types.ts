#!/usr/bin/env tsx

import { writeFileSync, mkdirSync } from 'fs';
import { compile } from 'json-schema-to-typescript';
import path from 'path';

// AdCP Schema URLs
const ADCP_SCHEMAS = {
  'media-buy': 'https://adcontextprotocol.org/schemas/v1/core/media-buy.json',
  'creative-asset': 'https://adcontextprotocol.org/schemas/v1/core/creative-asset.json',
  'product': 'https://adcontextprotocol.org/schemas/v1/core/product.json',
  'targeting': 'https://adcontextprotocol.org/schemas/v1/core/targeting.json'
};

async function fetchSchema(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch schema from ${url}: ${response.status}`);
  }
  return response.json();
}

async function generateTypes() {
  console.log('🔄 Generating AdCP types from official schemas...');
  
  const outputDir = path.join(__dirname, '../src/types');
  mkdirSync(outputDir, { recursive: true });

  let allTypes = `// Generated AdCP types from official schemas\n// Generated at: ${new Date().toISOString()}\n\n`;

  for (const [name, url] of Object.entries(ADCP_SCHEMAS)) {
    try {
      console.log(`📥 Fetching ${name} schema from ${url}...`);
      const schema = await fetchSchema(url);
      
      console.log(`🔧 Generating TypeScript types for ${name}...`);
      const types = await compile(schema, name, {
        bannerComment: '',
        style: {
          semi: true,
          singleQuote: true
        }
      });
      
      allTypes += `// ${name.toUpperCase()} SCHEMA\n${types}\n`;
      console.log(`✅ Generated types for ${name}`);
    } catch (error) {
      console.error(`❌ Failed to generate types for ${name}:`, error.message);
    }
  }

  // Write combined types file
  const outputPath = path.join(outputDir, 'adcp.generated.ts');
  writeFileSync(outputPath, allTypes);
  
  console.log(`✅ AdCP types generated successfully at ${outputPath}`);
}

if (require.main === module) {
  generateTypes().catch(error => {
    console.error('❌ Failed to generate types:', error);
    process.exit(1);
  });
}

export { generateTypes };