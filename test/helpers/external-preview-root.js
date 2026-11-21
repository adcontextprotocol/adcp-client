'use strict';

// SDK 16 packages no AdCP prerelease. A seller enables a preview by
// registering that preview's schema root, so the negotiation tests register a
// minimal one. These schemas are open objects: they exercise release
// selection, not the preview's real shapes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerExternalSchemaRoot, unregisterExternalSchemaRoot } = require('../../dist/lib/validation/schema-loader');

const EXTERNAL_PREVIEW = '3.3.0-rc.0';
const TOOLS = { get_products: 'media-buy', create_media_buy: 'media-buy' };

async function withExternalPreviewRoot(fn, version = EXTERNAL_PREVIEW) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-external-preview-'));
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ adcp_version: version }));
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({ tools: Object.fromEntries(Object.keys(TOOLS).map(tool => [tool, {}])) })
  );
  for (const [tool, domain] of Object.entries(TOOLS)) {
    const dir = path.join(root, 'bundled', domain);
    fs.mkdirSync(dir, { recursive: true });
    for (const kind of ['request', 'response']) {
      const file = `${tool.replace(/_/g, '-')}-${kind}.json`;
      fs.writeFileSync(
        path.join(dir, file),
        JSON.stringify({ $id: `https://adcontextprotocol.org/schemas/${version}/${domain}/${file}`, type: 'object' })
      );
    }
  }
  registerExternalSchemaRoot(version, root);
  try {
    return await fn(version);
  } finally {
    unregisterExternalSchemaRoot(version);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { EXTERNAL_PREVIEW, withExternalPreviewRoot };
