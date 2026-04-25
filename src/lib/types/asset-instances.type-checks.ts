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
// Pattern: each negative test uses an arrow function returning the value.
// TS reports the error on the `return` line, so the directive directly
// above is what catches it. Bare-const-assignment placement is fragile —
// TS reports object-literal-required-property errors at varying line/col
// positions depending on the type structure.
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

function describeAsset(asset: AssetInstance): string {
  switch (asset.asset_type) {
    case 'image':
      return `${asset.width}x${asset.height} @ ${asset.url}`;
    case 'video':
      return `video ${asset.container_format ?? ''} ${asset.duration_ms ?? 0}ms`;
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
void describeAsset;

// ── AssetInstance: omitting asset_type is rejected ───────────────────────

function _assetInstance_missingDiscriminator(): AssetInstance {
  // @ts-expect-error — `asset_type` is the discriminator and required.
  return { url: 'https://x.test/img.png', width: 300, height: 250 };
}
void _assetInstance_missingDiscriminator;

// ── AssetInstance: image variant requires width and height ───────────────

function _imageAsset_missingWidth(): AssetInstance {
  // @ts-expect-error — ImageAsset requires `width` (per AdCP 3.0 GA).
  return { asset_type: 'image', url: 'https://x.test/img.png', height: 250 };
}
void _imageAsset_missingWidth;

// ── AssetInstance: html instance carries `content`, not `html` ───────────

function _htmlAsset_wrongFieldName(): AssetInstance {
  // @ts-expect-error — HTMLAsset has `content`, not `html`. Common drift.
  return { asset_type: 'html', html: '<div>...</div>' };
}
void _htmlAsset_wrongFieldName;

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

function _assetType_bogusValue(): AssetInstanceType {
  // @ts-expect-error — 'banner' is not a valid asset_type.
  return 'banner';
}
void _assetType_bogusValue;

// ── CommonAssetInstance: narrower union, accepts only common variants ────

const _common_image: CommonAssetInstance = {
  asset_type: 'image',
  url: 'https://x.test/img.png',
  width: 300,
  height: 250,
};
void _common_image;

function _common_rejectsVast(): CommonAssetInstance {
  // @ts-expect-error — 'vast' is in AssetInstance but not CommonAssetInstance.
  return { asset_type: 'vast', content: '<VAST></VAST>' };
}
void _common_rejectsVast;

// ── SyncAccountsResponseRow: action discriminator is required ────────────

const _row_ok: SyncAccountsResponseRow = {
  account_id: 'acct_1',
  brand: { domain: 'example.com' },
  operator: 'agency.example',
  action: 'created',
  status: 'active',
};
void _row_ok;

function _row_missingAction(): SyncAccountsResponseRow {
  // @ts-expect-error — `action` is required on every row.
  return {
    account_id: 'acct_1',
    brand: { domain: 'example.com' },
    operator: 'agency.example',
    status: 'active',
  };
}
void _row_missingAction;

function _row_badAction(): SyncAccountsResponseRow {
  return {
    account_id: 'acct_1',
    brand: { domain: 'example.com' },
    operator: 'agency.example',
    // @ts-expect-error — 'archived' is not a valid action enum value.
    action: 'archived',
    status: 'active',
  };
}
void _row_badAction;

// ── SyncGovernanceResponseRow: status discriminator is required ──────────

const _gov_row_ok: SyncGovernanceResponseRow = {
  account: { account_id: 'acct_1' },
  status: 'synced',
};
void _gov_row_ok;

function _gov_row_missingStatus(): SyncGovernanceResponseRow {
  // @ts-expect-error — `status` is required.
  return { account: { account_id: 'acct_1' } };
}
void _gov_row_missingStatus;
