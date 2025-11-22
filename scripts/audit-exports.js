// Audit SDK exports for internals
const lib = require('../dist/lib/index.js');

const categories = {
  classes: [],
  functions: [],
  constants: [],
  other: [],
};

for (const key in lib) {
  const value = lib[key];
  const type = typeof value;

  if (type === 'function' && value.prototype && value.prototype.constructor === value) {
    categories.classes.push(key);
  } else if (type === 'function') {
    categories.functions.push(key);
  } else if (type === 'object' && value !== null && !Array.isArray(value)) {
    categories.constants.push(key);
  } else {
    categories.other.push(key);
  }
}

console.log('=== SDK Public API Audit ===\n');
console.log(`Total exports: ${Object.keys(lib).length}\n`);

for (const [category, items] of Object.entries(categories)) {
  if (items.length > 0) {
    console.log(`${category} (${items.length}):`);
    items.sort().forEach(item => console.log(`  - ${item}`));
    console.log('');
  }
}

// Check for numbered objects or suspicious patterns
const suspicious = Object.keys(lib).filter(
  key =>
    /^\d/.test(key) || // starts with number
    /_\d+$/.test(key) || // ends with underscore+number
    /^[A-Z][a-z]+\d/.test(key) || // PascalCase with trailing number
    key.includes('Internal') ||
    key.includes('_private') ||
    key.includes('__')
);

if (suspicious.length > 0) {
  console.log('\n⚠️  Suspicious exports (possible internals):');
  suspicious.forEach(key => console.log(`  - ${key}`));
} else {
  console.log('\n✅ No suspicious exports found');
}
