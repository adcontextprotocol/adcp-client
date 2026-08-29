import { z } from 'zod';
import type {
  AudioAsset,
  CardAsset,
  CSSAsset,
  HTMLAsset,
  ImageAsset,
  JavaScriptAsset,
  MarkdownAsset,
  TextAsset,
  URLAsset,
  VideoAsset,
  WebhookAsset,
  ZipAsset,
} from '../lib/types/core.generated';
import {
  AudioAssetSchema,
  CardAssetSchema,
  CSSAssetSchema,
  HTMLAssetSchema,
  ImageAssetSchema,
  JavaScriptAssetSchema,
  MarkdownAssetSchema,
  TextAssetSchema,
  URLAssetSchema,
  VideoAssetSchema,
  WebhookAssetSchema,
  ZipAssetSchema,
} from '../lib/types/schemas.generated';
import type { ProductCardDetailedFields, ProductCardFields } from '../lib/v2/projection/builders';

type AssertAssignable<Expected, Actual extends Expected> = true;

type _image = AssertAssignable<ImageAsset, z.output<typeof ImageAssetSchema>>;
type _video = AssertAssignable<VideoAsset, z.output<typeof VideoAssetSchema>>;
type _audio = AssertAssignable<AudioAsset, z.output<typeof AudioAssetSchema>>;
type _text = AssertAssignable<TextAsset, z.output<typeof TextAssetSchema>>;
type _url = AssertAssignable<URLAsset, z.output<typeof URLAssetSchema>>;
type _html = AssertAssignable<HTMLAsset, z.output<typeof HTMLAssetSchema>>;
type _javascript = AssertAssignable<JavaScriptAsset, z.output<typeof JavaScriptAssetSchema>>;
type _zip = AssertAssignable<ZipAsset, z.output<typeof ZipAssetSchema>>;
type _webhook = AssertAssignable<WebhookAsset, z.output<typeof WebhookAssetSchema>>;
type _css = AssertAssignable<CSSAsset, z.output<typeof CSSAssetSchema>>;
type _markdown = AssertAssignable<MarkdownAsset, z.output<typeof MarkdownAssetSchema>>;
type _card = AssertAssignable<CardAsset, z.output<typeof CardAssetSchema>>;

type _product_card_image = AssertAssignable<NonNullable<ProductCardFields['image']>, z.output<typeof ImageAssetSchema>>;
type _product_card_hero = AssertAssignable<
  NonNullable<ProductCardDetailedFields['hero_image']>,
  z.output<typeof ImageAssetSchema>
>;
type _product_card_carousel = AssertAssignable<
  NonNullable<ProductCardDetailedFields['carousel_images']>[number],
  z.output<typeof ImageAssetSchema>
>;

const provenanceImage = ImageAssetSchema.parse({
  asset_type: 'image',
  url: 'https://cdn.example/image.png',
  width: 300,
  height: 250,
  provenance: {
    digital_source_type: 'trainedAlgorithmicMedia',
    ai_tool: { name: 'image-generator' },
  },
});

const productCard: ProductCardFields = { image: provenanceImage };
const detailedProductCard: ProductCardDetailedFields = {
  hero_image: provenanceImage,
  carousel_images: [provenanceImage],
};

void productCard;
void detailedProductCard;
