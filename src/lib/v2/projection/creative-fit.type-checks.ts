import { fitCreativeToPackages, canonicalFormatDeclaration, type CanonicalSyncCreativeAsset } from '../../index';

declare const creative: CanonicalSyncCreativeAsset;
const result = fitCreativeToPackages(
  creative,
  [
    {
      package_id: 'package',
      format_options: [
        canonicalFormatDeclaration('image', { width: 300, height: 250 }, { technical_requirements_complete: true }),
      ],
    },
  ],
  {
    adcpVersion: '3.3.0-beta.3',
    primaryAssetFacts: { channels: 'stereo', codec: 'aac' },
  }
);
if (result.wire?.mode === 'canonical') {
  const kind: string = result.wire.selector.format_kind;
  const assetKind: string = result.wire.creative.format_kind;
  void [kind, assetKind];
  // @ts-expect-error canonical selectors cannot expose legacy identity
  result.wire.selector.format_id;
}
if (result.wire?.mode === 'legacy') {
  const owner: string = result.wire.selector.format_id.agent_url;
  const id: string = result.wire.creative.format_id.id;
  void [owner, id];
  // @ts-expect-error legacy selectors cannot expose canonical identity
  result.wire.selector.format_kind;
}
