#!/usr/bin/env tsx

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

// AdCP Schema Configuration
const ADCP_BASE_URL = 'https://adcontextprotocol.org';
const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');

interface SchemaIndex {
  adcp_version: string;
  schemas: {
    core: { schemas: Record<string, { $ref: string; description: string }> };
    enums: { schemas: Record<string, { $ref: string; description: string }> };
    'media-buy': { tasks: Record<string, any> };
    creative: { tasks: Record<string, any> };
    signals: { tasks: Record<string, any> };
  };
}

// Fetch and parse JSON from URL
async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Download and cache a schema file
async function downloadSchema(schemaRef: string, cacheDir: string): Promise<void> {
  const url = `${ADCP_BASE_URL}${schemaRef}`;
  const localPath = path.join(cacheDir, schemaRef.replace('/schemas/v1/', ''));

  // Create directory if it doesn't exist
  mkdirSync(path.dirname(localPath), { recursive: true });

  try {
    console.log(`📥 Downloading ${schemaRef}...`);
    const schema = await fetchJson(url);
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
      if (schema.$ref.startsWith('/schemas/v1/')) {
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

  // Fetch the schema index
  const indexUrl = `${ADCP_BASE_URL}/schemas/v1/index.json`;
  console.log(`📥 Fetching schema index from ${indexUrl}...`);

  const schemaIndex: SchemaIndex = await fetchJson(indexUrl);
  const adcpVersion = version || schemaIndex.adcp_version;

  console.log(`📋 AdCP Version: ${adcpVersion}`);
  console.log(`🗂️  Caching schemas to: ${SCHEMA_CACHE_DIR}/${adcpVersion}/`);

  const versionCacheDir = path.join(SCHEMA_CACHE_DIR, adcpVersion);
  mkdirSync(versionCacheDir, { recursive: true });

  // Save the schema index
  const indexPath = path.join(versionCacheDir, 'index.json');
  writeFileSync(indexPath, JSON.stringify(schemaIndex, null, 2));
  console.log(`✅ Cached schema index -> ${indexPath}`);

  // Collect all schema references to download
  const allRefs = new Set<string>();

  // Add core schema refs
  if (schemaIndex.schemas.core?.schemas) {
    for (const schema of Object.values(schemaIndex.schemas.core.schemas)) {
      allRefs.add(schema.$ref);
    }
  }

  // Add enum schema refs
  if (schemaIndex.schemas.enums?.schemas) {
    for (const schema of Object.values(schemaIndex.schemas.enums.schemas)) {
      allRefs.add(schema.$ref);
    }
  }

  // Add media-buy task schema refs
  if (schemaIndex.schemas['media-buy']?.tasks) {
    for (const task of Object.values(schemaIndex.schemas['media-buy'].tasks)) {
      if (task.request?.$ref) allRefs.add(task.request.$ref);
      if (task.response?.$ref) allRefs.add(task.response.$ref);
    }
  }

  // Add creative task schema refs
  if (schemaIndex.schemas.creative?.tasks) {
    for (const task of Object.values(schemaIndex.schemas.creative.tasks)) {
      if (task.request?.$ref) allRefs.add(task.request.$ref);
      if (task.response?.$ref) allRefs.add(task.response.$ref);
    }
  }

  // Add signals task schema refs
  if (schemaIndex.schemas.signals?.tasks) {
    for (const task of Object.values(schemaIndex.schemas.signals.tasks)) {
      if (task.request?.$ref) allRefs.add(task.request.$ref);
      if (task.response?.$ref) allRefs.add(task.response.$ref);
    }
  }

  // Add adagents.json schema (for publisher authorization)
  allRefs.add('/schemas/v1/adagents.json');

  console.log(`📋 Found ${allRefs.size} schema references to download`);

  // Download all primary schemas
  const downloadPromises = Array.from(allRefs).map(ref => downloadSchema(ref, versionCacheDir));

  await Promise.allSettled(downloadPromises);

  // Now download any nested $ref dependencies
  console.log('🔗 Checking for nested $ref dependencies...');

  const nestedRefs = new Set<string>();
  for (const ref of allRefs) {
    try {
      const localPath = path.join(versionCacheDir, ref.replace('/schemas/v1/', ''));
      if (existsSync(localPath)) {
        const schema = JSON.parse(require('fs').readFileSync(localPath, 'utf8'));
        const refs = extractRefs(schema);
        refs.forEach(r => nestedRefs.add(r));
      }
    } catch (error) {
      console.warn(`⚠️  Failed to parse ${ref} for nested refs:`, error.message);
    }
  }

  // Remove already downloaded refs
  allRefs.forEach(ref => nestedRefs.delete(ref));

  if (nestedRefs.size > 0) {
    console.log(`📋 Found ${nestedRefs.size} additional nested references`);
    const nestedDownloadPromises = Array.from(nestedRefs).map(ref => downloadSchema(ref, versionCacheDir));
    await Promise.allSettled(nestedDownloadPromises);
  }

  // Create latest symlink
  const latestLink = path.join(SCHEMA_CACHE_DIR, 'latest');
  try {
    if (existsSync(latestLink)) {
      require('fs').unlinkSync(latestLink);
    }
    require('fs').symlinkSync(adcpVersion, latestLink);
    console.log(`🔗 Created latest symlink -> ${adcpVersion}`);
  } catch (error) {
    console.warn(`⚠️  Failed to create latest symlink:`, error.message);
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
