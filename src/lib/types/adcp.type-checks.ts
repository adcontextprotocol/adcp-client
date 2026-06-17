// Type-only regressions for public AdCP compatibility shapes.
//
// Run with `npm run typecheck`. The library build excludes `*.type-checks.ts`.

import type { ManageCreativeAssetsResponse } from './adcp';

const creativeAssetErrorsWithCanonicalCode: ManageCreativeAssetsResponse = {
  success: false,
  action: 'upload',
  errors: [
    {
      creative_id: 'creative_1',
      code: 'INVALID_CREATIVE',
      message: 'Creative failed validation',
    },
  ],
};

const creativeAssetErrorsWithLegacyCode: ManageCreativeAssetsResponse = {
  success: false,
  action: 'upload',
  errors: [
    {
      creative_id: 'creative_1',
      code: 'INVALID_CREATIVE',
      error_code: 'INVALID_CREATIVE',
      message: 'Creative failed validation',
    },
  ],
};

const creativeAssetErrorsWithLegacyOnlyCode: ManageCreativeAssetsResponse = {
  success: false,
  action: 'upload',
  errors: [
    {
      creative_id: 'creative_1',
      error_code: 'INVALID_CREATIVE',
      message: 'Creative failed validation',
    },
  ],
};

void creativeAssetErrorsWithCanonicalCode;
void creativeAssetErrorsWithLegacyCode;
void creativeAssetErrorsWithLegacyOnlyCode;
