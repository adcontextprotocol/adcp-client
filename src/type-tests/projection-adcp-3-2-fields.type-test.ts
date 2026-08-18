import { toCanonicalFormatOptionsWithRoutes, type ProductFormatDeclaration } from '../lib';
import {
  toCanonicalFormatOptionsWithRoutes as projectionToCanonicalFormatOptionsWithRoutes,
  type V2ProductFormatDeclaration,
} from '../lib/v2/projection';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type Assert<T extends true> = T;

type _SampleRenderUrlParity = Assert<
  Equal<V2ProductFormatDeclaration['sample_render_url'], ProductFormatDeclaration['sample_render_url']>
>;
type _LocalePolicyParity = Assert<
  Equal<V2ProductFormatDeclaration['locale_policy'], ProductFormatDeclaration['locale_policy']>
>;

const declarations: V2ProductFormatDeclaration[] = [
  {
    format_option_id: 'sample-image',
    format_kind: 'image',
    params: { width: 300, height: 250 },
    sample_render_url: 'https://publisher.example/samples/sample-image',
    v1_format_ref: [
      {
        agent_url: 'https://formats.publisher.example/catalog',
        id: 'sample_image',
      },
    ],
  },
  {
    format_option_id: 'localized-image',
    format_kind: 'image',
    params: { width: 300, height: 250 },
    canonical_formats_only: true,
    locale_policy: { accepted_language_ranges: ['fr', 'fr-CA'] },
  },
];

const projectedFromRoot = toCanonicalFormatOptionsWithRoutes('adcp-3-2-product', declarations);
const projectedFromSubpath = projectionToCanonicalFormatOptionsWithRoutes('adcp-3-2-product', declarations);
const sampleRenderUrl: ProductFormatDeclaration['sample_render_url'] =
  projectedFromRoot.formatOptions[0]!.sample_render_url;
const localePolicy: ProductFormatDeclaration['locale_policy'] = projectedFromRoot.formatOptions[1]!.locale_policy;

void projectedFromSubpath;
void sampleRenderUrl;
void localePolicy;
