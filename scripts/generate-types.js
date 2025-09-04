#!/usr/bin/env tsx
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTypes = generateTypes;
const fs_1 = require("fs");
const json_schema_to_typescript_1 = require("json-schema-to-typescript");
const path_1 = __importDefault(require("path"));
// AdCP Schema URLs
const ADCP_SCHEMAS = {
    'media-buy': 'https://adcontextprotocol.org/schemas/v1/core/media-buy.json',
    'creative-asset': 'https://adcontextprotocol.org/schemas/v1/core/creative-asset.json',
    'product': 'https://adcontextprotocol.org/schemas/v1/core/product.json',
    'targeting': 'https://adcontextprotocol.org/schemas/v1/core/targeting.json'
};
async function fetchSchema(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch schema from ${url}: ${response.status}`);
    }
    return response.json();
}
async function generateTypes() {
    console.log('🔄 Generating AdCP types from official schemas...');
    const outputDir = path_1.default.join(__dirname, '../src/types');
    (0, fs_1.mkdirSync)(outputDir, { recursive: true });
    let allTypes = `// Generated AdCP types from official schemas\n// Generated at: ${new Date().toISOString()}\n\n`;
    for (const [name, url] of Object.entries(ADCP_SCHEMAS)) {
        try {
            console.log(`📥 Fetching ${name} schema from ${url}...`);
            const schema = await fetchSchema(url);
            console.log(`🔧 Generating TypeScript types for ${name}...`);
            const types = await (0, json_schema_to_typescript_1.compile)(schema, name, {
                bannerComment: '',
                style: {
                    semi: true,
                    singleQuote: true
                }
            });
            allTypes += `// ${name.toUpperCase()} SCHEMA\n${types}\n`;
            console.log(`✅ Generated types for ${name}`);
        }
        catch (error) {
            console.error(`❌ Failed to generate types for ${name}:`, error.message);
        }
    }
    // Write combined types file
    const outputPath = path_1.default.join(outputDir, 'adcp.generated.ts');
    (0, fs_1.writeFileSync)(outputPath, allTypes);
    console.log(`✅ AdCP types generated successfully at ${outputPath}`);
}
if (require.main === module) {
    generateTypes().catch(error => {
        console.error('❌ Failed to generate types:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=generate-types.js.map