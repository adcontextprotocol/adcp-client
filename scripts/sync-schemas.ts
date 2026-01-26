#!/usr/bin/env tsx

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

// AdCP Schema Configuration
const ADCP_BASE_URL = 'https://adcontextprotocol.org';
const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');

// Read target AdCP version from ADCP_VERSION file (source of truth)
function getTargetAdCPVersion(): string {
  try {
    const versionFilePath = path.join(__dirname, '../ADCP_VERSION');
    if (!existsSync(versionFilePath)) {
      throw new Error('ADCP_VERSION file not found. This file defines which AdCP version to use.');
    }
    const version = readFileSync(versionFilePath, 'utf8').trim();
    if (!version) {
      throw new Error('ADCP_VERSION file is empty');
    }
    return version;
  } catch (error) {
    console.error(`❌ Failed to read ADCP_VERSION file:`, (error as Error).message);
    process.exit(1);
  }
}

// Domain can have schemas (core types) and/or tasks (request/response pairs)
interface DomainEntry {
  schemas?: Record<string, { $ref: string; description?: string }>;
  tasks?: Record<string, { request?: { $ref: string }; response?: { $ref: string } }>;
}

interface SchemaIndex {
  adcp_version: string;
  schemas: Record<string, DomainEntry>;
}

// Fetch and parse JSON from URL
async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Normalize $ref paths in a schema to use the semantic version instead of "latest"
function normalizeSchemaRefs(schema: any, semanticVersion: string): any {
  if (typeof schema === 'object' && schema !== null) {
    // If this is a $ref, normalize it
    if (schema.$ref && typeof schema.$ref === 'string') {
      // Replace /schemas/latest/ with /schemas/{semanticVersion}/
      if (schema.$ref.includes('/schemas/latest/')) {
        schema.$ref = schema.$ref.replace('/schemas/latest/', `/schemas/${semanticVersion}/`);
      }
    }

    // Recursively process all nested objects and arrays
    for (const key of Object.keys(schema)) {
      if (typeof schema[key] === 'object' && schema[key] !== null) {
        normalizeSchemaRefs(schema[key], semanticVersion);
      }
    }
  }

  return schema;
}

// Download and cache a schema file
async function downloadSchema(
  schemaRef: string,
  cacheDir: string,
  adcpVersion: string,
  semanticVersion?: string
): Promise<void> {
  const url = `${ADCP_BASE_URL}${schemaRef}`;

  // Strip the version prefix from the schema path to get the local path
  // e.g., /schemas/2.4.0/core/product.json -> core/product.json
  // Note: When adcpVersion is "v2", schemas still use "2.4.0" in their $refs
  let localPath: string;
  if (schemaRef.startsWith('/schemas/')) {
    // Remove /schemas/ prefix
    let relativePath = schemaRef.substring('/schemas/'.length);
    // Remove version segment (e.g., "2.4.0/" or "v1/" or "v2/")
    const firstSlash = relativePath.indexOf('/');
    if (firstSlash > 0) {
      relativePath = relativePath.substring(firstSlash + 1);
    }
    localPath = path.join(cacheDir, relativePath);
  } else {
    // Fallback for paths without /schemas/ prefix
    localPath = path.join(cacheDir, path.basename(schemaRef));
  }

  // Create directory if it doesn't exist
  mkdirSync(path.dirname(localPath), { recursive: true });

  try {
    console.log(`📥 Downloading ${schemaRef}...`);
    const schema = await fetchJson(url);

    // Normalize $ref paths to use semantic version instead of "latest"
    if (semanticVersion) {
      normalizeSchemaRefs(schema, semanticVersion);
    }

    writeFileSync(localPath, JSON.stringify(schema, null, 2));
    console.log(`✅ Cached ${schemaRef} -> ${localPath}`);
  } catch (error) {
    console.warn(`⚠️  Failed to download ${schemaRef}:`, error.message);
  }
}

// Extract all $ref paths from a schema recursively
function extractRefs(schema: any, refs: Set<string> = new Set()): Set<string> {
  if (typeof schema === 'object' && schema !== null) {
    if (schema.$ref && typeof schema.$ref === 'string') {
      // Accept both versioned (/schemas/X.Y.Z/) and v1 (/schemas/v1/) paths
      if (schema.$ref.startsWith('/schemas/')) {
        refs.add(schema.$ref);
      }
    }

    for (const value of Object.values(schema)) {
      extractRefs(value, refs);
    }
  }

  return refs;
}

// Sync all schemas for a specific AdCP version
async function syncSchemas(version?: string): Promise<void> {
  console.log('🔄 Syncing AdCP schemas...');

  // Use the ADCP_VERSION file as the source of truth
  const adcpVersion = version || getTargetAdCPVersion();
  console.log(`📋 Target AdCP version: ${adcpVersion} (from ADCP_VERSION file)`);

  // Fetch the schema index for the specified version
  const indexUrl = `${ADCP_BASE_URL}/schemas/${adcpVersion}/index.json`;
  console.log(`📥 Fetching schema index from ${indexUrl}...`);

  const schemaIndex: SchemaIndex = await fetchJson(indexUrl);

  console.log(`📋 AdCP Version: ${adcpVersion}`);
  console.log(`🗂️  Caching schemas to: ${SCHEMA_CACHE_DIR}/${adcpVersion}/`);

  const versionCacheDir = path.join(SCHEMA_CACHE_DIR, adcpVersion);
  mkdirSync(versionCacheDir, { recursive: true });

  // Save the schema index
  const indexPath = path.join(versionCacheDir, 'index.json');
  writeFileSync(indexPath, JSON.stringify(schemaIndex, null, 2));
  console.log(`✅ Cached schema index -> ${indexPath}`);

  // Collect all schema references to download by iterating over ALL domains
  const allRefs = new Set<string>();

  // Dynamically iterate over all domains in the schema index
  for (const [domainName, domain] of Object.entries(schemaIndex.schemas)) {
    if (!domain || typeof domain !== 'object') continue;

    // Add schema refs (for domains with type definitions like core, enums)
    if (domain.schemas && typeof domain.schemas === 'object') {
      for (const schema of Object.values(domain.schemas)) {
        if (schema && typeof schema === 'object' && '$ref' in schema && schema.$ref) {
          allRefs.add(schema.$ref as string);
        }
      }
      console.log(`📂 Found ${Object.keys(domain.schemas).length} schemas in ${domainName}`);
    }

    // Add task request/response refs (for domains with operations)
    if (domain.tasks && typeof domain.tasks === 'object') {
      let taskCount = 0;
      for (const task of Object.values(domain.tasks)) {
        if (task && typeof task === 'object') {
          const taskObj = task as { request?: { $ref?: string }; response?: { $ref?: string } };
          if (taskObj.request?.$ref) allRefs.add(taskObj.request.$ref);
          if (taskObj.response?.$ref) allRefs.add(taskObj.response.$ref);
          taskCount++;
        }
      }
      console.log(`📂 Found ${taskCount} tasks in ${domainName}`);
    }
  }

  // Add adagents.json schema (for publisher authorization)
  allRefs.add('/schemas/v1/adagents.json');

  console.log(`📋 Found ${allRefs.size} schema references to download`);

  // Get the semantic version from the index (e.g., "2.5.0") for normalizing refs
  const semanticVersion = schemaIndex.adcp_version;
  console.log(`📋 Semantic version for ref normalization: ${semanticVersion}`);

  // Download all primary schemas
  const downloadPromises = Array.from(allRefs).map(ref =>
    downloadSchema(ref, versionCacheDir, adcpVersion, semanticVersion)
  );

  await Promise.allSettled(downloadPromises);

  // Recursively download nested $ref dependencies
  console.log('🔗 Checking for nested $ref dependencies...');

  const downloadedRefs = new Set<string>(allRefs);
  let depth = 0;
  const maxDepth = 10; // Prevent infinite loops

  while (depth < maxDepth) {
    const nestedRefs = new Set<string>();

    // Check all downloaded schemas for nested refs
    for (const ref of downloadedRefs) {
      try {
        // Use the same path extraction logic as downloadSchema
        let localPath: string;
        if (ref.startsWith('/schemas/')) {
          // Remove /schemas/ prefix
          let relativePath = ref.substring('/schemas/'.length);
          // Remove version segment (e.g., "2.4.0/" or "v1/" or "v2/")
          const firstSlash = relativePath.indexOf('/');
          if (firstSlash > 0) {
            relativePath = relativePath.substring(firstSlash + 1);
          }
          localPath = path.join(versionCacheDir, relativePath);
        } else {
          localPath = path.join(versionCacheDir, path.basename(ref));
        }

        if (existsSync(localPath)) {
          const schema = JSON.parse(require('fs').readFileSync(localPath, 'utf8'));
          const refs = extractRefs(schema);
          refs.forEach(r => {
            // Only add refs we haven't downloaded yet
            if (!downloadedRefs.has(r)) {
              nestedRefs.add(r);
            }
          });
        }
      } catch (error) {
        console.warn(`⚠️  Failed to parse ${ref} for nested refs:`, error.message);
      }
    }

    if (nestedRefs.size === 0) {
      console.log(`✅ No more nested references found (depth ${depth})`);
      break;
    }

    console.log(`📋 Found ${nestedRefs.size} additional nested references at depth ${depth + 1}`);
    const nestedDownloadPromises = Array.from(nestedRefs).map(ref =>
      downloadSchema(ref, versionCacheDir, adcpVersion, semanticVersion)
    );
    await Promise.allSettled(nestedDownloadPromises);

    // Add newly downloaded refs to the set
    nestedRefs.forEach(r => downloadedRefs.add(r));
    depth++;
  }

  if (depth >= maxDepth) {
    console.warn(`⚠️  Reached maximum recursion depth (${maxDepth})`);
  }

  // Create latest symlink (skip if version is already "latest" to avoid circular symlink)
  if (adcpVersion !== 'latest') {
    const latestLink = path.join(SCHEMA_CACHE_DIR, 'latest');
    try {
      if (existsSync(latestLink)) {
        // Use rmSync with recursive:true to handle both symlinks and directories
        require('fs').rmSync(latestLink, { recursive: true, force: true });
      }
      require('fs').symlinkSync(adcpVersion, latestLink);
      console.log(`🔗 Created latest symlink -> ${adcpVersion}`);
    } catch (error) {
      console.warn(`⚠️  Failed to create latest symlink:`, error.message);
    }
  } else {
    console.log(`📁 Using 'latest' directly - no symlink needed`);
  }

  console.log(`✅ Schema sync completed for AdCP v${adcpVersion}`);
  console.log(`📁 Schemas cached in: ${versionCacheDir}`);
}

// CLI execution
if (require.main === module) {
  const version = process.argv[2]; // Optional version argument

  syncSchemas(version).catch(error => {
    console.error('❌ Schema sync failed:', error);
    process.exit(1);
  });
}

export { syncSchemas };
