/* eslint-disable @typescript-eslint/no-unused-vars */
// Type-only tests for the AssetInstance discriminated union and the
// SyncAccountsResponseRow / SyncGovernanceResponseRow row types.
//
// The "test" is whether this file compiles. Each `// @ts-expect-error`
// comment claims the next line WILL fail typechecking. If TypeScript ever
// stops flagging that line — e.g., because the discriminator was loosened
// or a required field became optional — the `@ts-expect-error` itself
// becomes an error and the project's `tsc --noEmit` fails. That's the
// regression alarm.
//
// Run with `npm run typecheck`.

import type {
  AssetInstance,
  AssetInstanceType,
  CommonAssetInstance,
  SyncAccountsResponseRow,
  SyncGovernanceResponseRow,
} from './index';

// ── AssetInstance: discriminator narrowing works ─────────────────────────

function describe(asset: AssetInstance): string {
  switch (asset.asset_type) {
    case 'image':
      return `${asset.width}x${asset.height} @ ${asset.url}`;
    case 'video':
      return `video ${asset.format ?? ''}`;
    case 'audio':
      return `audio ${asset.codec}`;
    case 'text':
      return asset.content;
    case 'html':
      return asset.content;
    case 'url':
      return asset.url;
    case 'css':
    case 'javascript':
    case 'markdown':
    case 'vast':
    case 'daast':
    case 'brief':
    case 'catalog':
    case 'webhook':
      return asset.asset_type;
  }
}
void describe;

// ── AssetInstance: omitting asset_type is rejected ───────────────────────

// @ts-expect-error — `asset_type` is the discriminator and required.
const _missing_discriminator: AssetInstance = {
  url: 'https://x.test/img.png',
  width: 300,
  height: 250,
};
void _missing_discriminator;

// ── AssetInstance: image variant requires width and height ───────────────

// @ts-expect-error — ImageAsset requires `width` (per AdCP 3.0 GA).
const _image_missing_width: AssetInstance = {
  asset_type: 'image',
  url: 'https://x.test/img.png',
  height: 250,
};
void _image_missing_width;

// ── AssetInstance: html instance carries `content`, not `html` ───────────

// @ts-expect-error — HTMLAsset has `content`, not `html`. Common drift.
const _wrong_html_field: AssetInstance = {
  asset_type: 'html',
  html: '<div>...</div>',
};
void _wrong_html_field;

// ── AssetInstanceType: enumerates every variant's discriminator ──────────

const _all_types: AssetInstanceType[] = [
  'image',
  'video',
  'audio',
  'text',
  'html',
  'url',
  'css',
  'javascript',
  'markdown',
  'vast',
  'daast',
  'brief',
  'catalog',
  'webhook',
];
void _all_types;

// @ts-expect-error — 'banner' is not a valid asset_type.
const _bogus: AssetInstanceType = 'banner';
void _bogus;

// ── CommonAssetInstance: narrower union, accepts only common variants ────

const _common_image: CommonAssetInstance = {
  asset_type: 'image',
  url: 'https://x.test/img.png',
  width: 300,
  height: 250,
};
void _common_image;

// @ts-expect-error — 'vast' is in AssetInstance but not CommonAssetInstance.
const _common_rejects_vast: CommonAssetInstance = {
  asset_type: 'vast',
  content: '<VAST></VAST>',
  format: 'vast',
};
void _common_rejects_vast;

// ── SyncAccountsResponseRow: action discriminator is required ────────────

const _row_ok: SyncAccountsResponseRow = {
  account_id: 'acct_1',
  brand: { domain: 'example.com' },
  operator: 'agency.example',
  action: 'created',
  status: 'active',
};
void _row_ok;

// @ts-expect-error — `action` is required on every row.
const _row_missing_action: SyncAccountsResponseRow = {
  account_id: 'acct_1',
  brand: { domain: 'example.com' },
  operator: 'agency.example',
  status: 'active',
};
void _row_missing_action;

// @ts-expect-error — 'archived' is not a valid action enum value.
const _row_bad_action: SyncAccountsResponseRow = {
  account_id: 'acct_1',
  brand: { domain: 'example.com' },
  operator: 'agency.example',
  action: 'archived',
  status: 'active',
};
void _row_bad_action;

// ── SyncGovernanceResponseRow: status discriminator is required ──────────

const _gov_row_ok: SyncGovernanceResponseRow = {
  account: { account_id: 'acct_1' },
  status: 'synced',
};
void _gov_row_ok;

// @ts-expect-error — `status` is required.
const _gov_row_missing_status: SyncGovernanceResponseRow = {
  account: { account_id: 'acct_1' },
};
void _gov_row_missing_status;
