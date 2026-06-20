const { existsSync } = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_SCHEMAS_DATA_ROOT = path.join(REPO_ROOT, 'dist', 'lib', 'schemas-data');
const SOURCE_SCHEMAS_CACHE_ROOT = path.join(REPO_ROOT, 'schemas', 'cache');
const BETA_VERSIONS_TO_TRY = ['3.1.0-beta.2', '3.1.0-beta.1', '3.1.0-beta.0', 'latest'];

function findBetaRegistryRoot(root) {
  for (const version of BETA_VERSIONS_TO_TRY) {
    const candidate = path.join(root, version);
    if (existsSync(path.join(candidate, 'registries', 'v1-canonical-mapping.json'))) {
      return candidate;
    }
  }
  return null;
}

function hasAnyBetaRegistry() {
  return Boolean(findBetaRegistryRoot(DIST_SCHEMAS_DATA_ROOT) || findBetaRegistryRoot(SOURCE_SCHEMAS_CACHE_ROOT));
}

function hasDistBetaRegistry() {
  return Boolean(findBetaRegistryRoot(DIST_SCHEMAS_DATA_ROOT));
}

function betaProjectionSkipReason({ catalogPath, distOnly = false } = {}) {
  const missing = [];
  const hasRegistry = distOnly ? hasDistBetaRegistry() : hasAnyBetaRegistry();
  if (!hasRegistry) {
    missing.push(
      distOnly
        ? 'dist/lib/schemas-data/<3.1 beta>/registries/v1-canonical-mapping.json'
        : 'dist/lib/schemas-data/<3.1 beta>/ or schemas/cache/<3.1 beta>/ registry data'
    );
  }
  if (catalogPath && !existsSync(catalogPath)) {
    missing.push(path.relative(REPO_ROOT, catalogPath));
  }
  return missing.length > 0 ? `requires optional 3.1 beta projection fixtures: ${missing.join(' and ')}` : false;
}

module.exports = {
  BETA_VERSIONS_TO_TRY,
  DIST_SCHEMAS_DATA_ROOT,
  SOURCE_SCHEMAS_CACHE_ROOT,
  betaProjectionSkipReason,
  findBetaRegistryRoot,
  hasAnyBetaRegistry,
  hasDistBetaRegistry,
};
