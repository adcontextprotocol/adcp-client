/**
 * Drift guard for the hand-curated `*_TOOLS` arrays in
 * `src/lib/utils/capabilities.ts` against the manifest's recognized tools.
 *
 * The arrays capture a user-facing protocol-detection semantic the manifest
 * doesn't carry directly — `build_creative` sits as primary `media-buy` in
 * the manifest (sellers expose it in the buy flow) but the hand-curated
 * lists put it under `CREATIVE_TOOLS` (semantic ownership). Pure mechanical
 * derivation would cause subtle `detectProtocols()` behavior changes, so we
 * keep the arrays hand-curated. This drift guard ensures every tool in the
 * arrays is at least a recognized manifest tool — catching typos, orphan
 * entries, and tools that have been removed upstream.
 *
 * The inverse direction (every manifest tool appears somewhere in the
 * arrays) is intentionally NOT asserted: protocol-level tools like
 * `get_adcp_capabilities` are surfaced separately via `PROTOCOL_TOOLS`,
 * and the asymmetric account/property/collection/etc. families don't fit
 * the protocol-detection model.
 *
 * Tracked: adcp-client#1192 (manifest adoption).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const ADCP_VERSION_FILE = path.join(ROOT, 'ADCP_VERSION');
const adcpVersion = existsSync(ADCP_VERSION_FILE) ? readFileSync(ADCP_VERSION_FILE, 'utf8').trim() : 'latest';
const MANIFEST_PATH = path.join(ROOT, 'schemas/cache', adcpVersion, 'manifest.json');

const {
  MEDIA_BUY_TOOLS,
  SIGNALS_TOOLS,
  GOVERNANCE_TOOLS,
  CREATIVE_TOOLS,
  SPONSORED_INTELLIGENCE_TOOLS,
  COMPLIANCE_TOOLS,
  BRAND_RIGHTS_TOOLS,
  EVENT_TRACKING_TOOLS,
  ACCOUNT_TOOLS,
  PROTOCOL_TOOLS,
} = require('../../dist/lib/utils/capabilities');

// Note: TRUSTED_MATCH_TOOLS is intentionally excluded from the drift check —
// `context_match` / `identity_match` belong to TMP (the Trusted Match Protocol),
// a separate spec line that AdCP's manifest.json does not enumerate. Re-include
// once TMP folds into the AdCP manifest or gets its own manifest artifact.

describe('capabilities.ts: tool arrays drift against manifest.json', () => {
  it('every tool in every *_TOOLS array exists in the manifest', () => {
    if (!existsSync(MANIFEST_PATH)) {
      throw new Error(`Manifest not found at ${MANIFEST_PATH}. Run \`npm run sync-schemas\` first.`);
    }
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const manifestTools = new Set(Object.keys(manifest.tools));

    const arrays = {
      MEDIA_BUY_TOOLS,
      SIGNALS_TOOLS,
      GOVERNANCE_TOOLS,
      CREATIVE_TOOLS,
      SPONSORED_INTELLIGENCE_TOOLS,
      COMPLIANCE_TOOLS,
      BRAND_RIGHTS_TOOLS,
      EVENT_TRACKING_TOOLS,
      ACCOUNT_TOOLS,
      PROTOCOL_TOOLS,
    };

    const orphans = [];
    for (const [arrayName, tools] of Object.entries(arrays)) {
      for (const tool of tools) {
        if (!manifestTools.has(tool)) {
          orphans.push({ arrayName, tool });
        }
      }
    }

    assert.deepEqual(
      orphans,
      [],
      `Found ${orphans.length} tool(s) in src/lib/utils/capabilities.ts arrays that are not ` +
        `in manifest.tools. These are typos, removed-upstream tools, or trusted-match/etc. ` +
        `entries the manifest doesn't track yet:\n` +
        orphans.map(o => `  ${o.arrayName} contains "${o.tool}" — not found in manifest.tools`).join('\n')
    );
  });

  it('PROTOCOL_TOOLS contains exactly the manifest tools whose protocol === "protocol"', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const manifestProtocolTools = Object.entries(manifest.tools)
      .filter(([, t]) => t.protocol === 'protocol')
      .map(([name]) => name)
      .sort();
    assert.deepEqual([...PROTOCOL_TOOLS].sort(), manifestProtocolTools);
  });

  it('TMP exemption is still load-bearing — context_match / identity_match remain outside manifest', () => {
    // Defensive guard: when TMP folds into the AdCP manifest (or gets its own
    // manifest artifact), this assertion fires and prompts a re-include of
    // TRUSTED_MATCH_TOOLS in the main drift check above. Without it the
    // exemption decays silently into a dead carve-out.
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const manifestTools = new Set(Object.keys(manifest.tools));
    assert.ok(
      !manifestTools.has('context_match') && !manifestTools.has('identity_match'),
      'TMP tools (context_match / identity_match) appear to have folded into manifest.tools — ' +
        're-include TRUSTED_MATCH_TOOLS in the drift check at line ~59 and remove this guard.'
    );
  });
});
