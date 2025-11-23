[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / BrandManifest

# Interface: BrandManifest

Defined in: [src/lib/types/tools.generated.ts:57](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L57)

Inline brand manifest object

## Properties

### url?

> `optional` **url**: `string`

Defined in: [src/lib/types/tools.generated.ts:61](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L61)

Primary brand URL for context and asset discovery. Creative agents can infer brand information from this URL.

***

### name

> **name**: `string`

Defined in: [src/lib/types/tools.generated.ts:65](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L65)

Brand or business name

***

### logos?

> `optional` **logos**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:69](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L69)

Brand logo assets with semantic tags for different use cases

#### url

> **url**: `string`

URL to the logo asset

#### tags?

> `optional` **tags**: `string`[]

Semantic tags describing the logo variant (e.g., 'dark', 'light', 'square', 'horizontal', 'icon')

#### width?

> `optional` **width**: `number`

Logo width in pixels

#### height?

> `optional` **height**: `number`

Logo height in pixels

***

### colors?

> `optional` **colors**: `object`

Defined in: [src/lib/types/tools.generated.ts:90](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L90)

Brand color palette

#### primary?

> `optional` **primary**: `string`

Primary brand color (hex format)

#### secondary?

> `optional` **secondary**: `string`

Secondary brand color (hex format)

#### accent?

> `optional` **accent**: `string`

Accent color (hex format)

#### background?

> `optional` **background**: `string`

Background color (hex format)

#### text?

> `optional` **text**: `string`

Text color (hex format)

***

### fonts?

> `optional` **fonts**: `object`

Defined in: [src/lib/types/tools.generated.ts:115](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L115)

Brand typography guidelines

#### primary?

> `optional` **primary**: `string`

Primary font family name

#### secondary?

> `optional` **secondary**: `string`

Secondary font family name

#### font\_urls?

> `optional` **font\_urls**: `string`[]

URLs to web font files if using custom fonts

***

### tone?

> `optional` **tone**: `string`

Defined in: [src/lib/types/tools.generated.ts:132](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L132)

Brand voice and messaging tone (e.g., 'professional', 'casual', 'humorous', 'trustworthy', 'innovative')

***

### tagline?

> `optional` **tagline**: `string`

Defined in: [src/lib/types/tools.generated.ts:136](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L136)

Brand tagline or slogan

***

### assets?

> `optional` **assets**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:140](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L140)

Brand asset library with explicit assets and tags. Assets are referenced inline with URLs pointing to CDN-hosted files.

#### asset\_id

> **asset\_id**: `string`

Unique identifier for this asset

#### asset\_type

> **asset\_type**: `"image"` \| `"video"` \| `"audio"` \| `"text"`

Type of asset

#### url

> **url**: `string`

URL to CDN-hosted asset file

#### tags?

> `optional` **tags**: `string`[]

Tags for asset discovery (e.g., 'holiday', 'lifestyle', 'product_shot')

#### name?

> `optional` **name**: `string`

Human-readable asset name

#### description?

> `optional` **description**: `string`

Asset description or usage notes

#### width?

> `optional` **width**: `number`

Image/video width in pixels

#### height?

> `optional` **height**: `number`

Image/video height in pixels

#### duration\_seconds?

> `optional` **duration\_seconds**: `number`

Video/audio duration in seconds

#### file\_size\_bytes?

> `optional` **file\_size\_bytes**: `number`

File size in bytes

#### format?

> `optional` **format**: `string`

File format (e.g., 'jpg', 'mp4', 'mp3')

#### metadata?

> `optional` **metadata**: `object`

Additional asset-specific metadata

##### Index Signature

\[`k`: `string`\]: `unknown`

***

### product\_catalog?

> `optional` **product\_catalog**: `object`

Defined in: [src/lib/types/tools.generated.ts:195](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L195)

Product catalog information for e-commerce advertisers. Enables SKU-level creative generation and product selection.

#### feed\_url

> **feed\_url**: `string`

URL to product catalog feed

#### feed\_format?

> `optional` **feed\_format**: `"google_merchant_center"` \| `"facebook_catalog"` \| `"custom"`

Format of the product feed

#### categories?

> `optional` **categories**: `string`[]

Product categories available in the catalog (for filtering)

#### last\_updated?

> `optional` **last\_updated**: `string`

When the product catalog was last updated

#### update\_frequency?

> `optional` **update\_frequency**: `"realtime"` \| `"hourly"` \| `"daily"` \| `"weekly"`

How frequently the product catalog is updated

***

### disclaimers?

> `optional` **disclaimers**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:220](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L220)

Legal disclaimers or required text that must appear in creatives

#### text

> **text**: `string`

Disclaimer text

#### context?

> `optional` **context**: `string`

When this disclaimer applies (e.g., 'financial_products', 'health_claims', 'all')

#### required?

> `optional` **required**: `boolean`

Whether this disclaimer must appear

***

### industry?

> `optional` **industry**: `string`

Defined in: [src/lib/types/tools.generated.ts:237](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L237)

Industry or vertical (e.g., 'retail', 'automotive', 'finance', 'healthcare')

***

### target\_audience?

> `optional` **target\_audience**: `string`

Defined in: [src/lib/types/tools.generated.ts:241](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L241)

Primary target audience description

***

### contact?

> `optional` **contact**: `object`

Defined in: [src/lib/types/tools.generated.ts:245](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L245)

Brand contact information

#### email?

> `optional` **email**: `string`

Contact email

#### phone?

> `optional` **phone**: `string`

Contact phone number

***

### metadata?

> `optional` **metadata**: `object`

Defined in: [src/lib/types/tools.generated.ts:258](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L258)

Additional brand metadata

#### created\_date?

> `optional` **created\_date**: `string`

When this brand manifest was created

#### updated\_date?

> `optional` **updated\_date**: `string`

When this brand manifest was last updated

#### version?

> `optional` **version**: `string`

Brand card version number
