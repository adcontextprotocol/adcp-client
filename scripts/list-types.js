// List type exports from the SDK
const lib = require('../dist/lib/index.js');

const allExports = Object.keys(lib);
console.log(`\n=== Total Exports: ${allExports.length} ===\n`);

// Categorize exports
const functions = allExports.filter(k => typeof lib[k] === 'function');
const classes = allExports.filter(k => typeof lib[k] === 'function' && lib[k].prototype && lib[k].prototype.constructor === lib[k]);
const objects = allExports.filter(k => typeof lib[k] === 'object' && lib[k] !== null);
const zodSchemas = allExports.filter(k => k.endsWith('Schema'));

console.log(`Functions: ${functions.length}`);
console.log(`Classes: ${classes.length}`);
console.log(`Objects/Constants: ${objects.length}`);
console.log(`Zod Schemas: ${zodSchemas.length}\n`);

// Show Zod schemas
console.log('=== Zod Schema Exports ===');
zodSchemas.forEach(s => console.log(`  - ${s}`));

console.log('\n=== Type Exports (likely from type-only exports) ===');
console.log('TypeScript type exports are not visible at runtime.');
console.log('Check src/lib/index.ts for "export type" statements.\n');
