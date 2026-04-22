// Typed factory helpers for creative asset objects.
//
// Every asset interface in the schema carries an `asset_type` literal
// discriminator (e.g. `asset_type: 'image'`) that's always the canonical
// tag for its class. Requiring callers to type it by hand is boilerplate
// that the compiler already knows the answer to. These builders take the
// rest of the asset shape and inject the discriminator, so
// `imageAsset({ url, width, height })` produces a valid `ImageAsset`
// without repeating `asset_type: 'image'` at every call site.

import type {
  AudioAsset,
  CSSAsset,
  HTMLAsset,
  ImageAsset,
  JavaScriptAsset,
  MarkdownAsset,
  TextAsset,
  URLAsset,
  VideoAsset,
  WebhookAsset,
} from '../types/tools.generated';

// Intersecting with `{ asset_type: Tag }` instead of relying on the imported
// type's own discriminator keeps these builders robust across schema
// regenerations, whether or not the generated interface carries the tag.
type Tagged<T, Tag extends string> = Omit<T, 'asset_type'> & { asset_type: Tag };

// Spread order matters: the discriminator is written last so a runtime
// bypass (e.g. an `as unknown` cast that slips `asset_type` into `fields`)
// can't clobber it.

/** Build an `ImageAsset` with `asset_type: 'image'` injected. */
export function imageAsset(fields: Omit<ImageAsset, 'asset_type'>): Tagged<ImageAsset, 'image'> {
  return { ...fields, asset_type: 'image' };
}

/** Build a `VideoAsset` with `asset_type: 'video'` injected. */
export function videoAsset(fields: Omit<VideoAsset, 'asset_type'>): Tagged<VideoAsset, 'video'> {
  return { ...fields, asset_type: 'video' };
}

/** Build an `AudioAsset` with `asset_type: 'audio'` injected. */
export function audioAsset(fields: Omit<AudioAsset, 'asset_type'>): Tagged<AudioAsset, 'audio'> {
  return { ...fields, asset_type: 'audio' };
}

/** Build a `TextAsset` with `asset_type: 'text'` injected. */
export function textAsset(fields: Omit<TextAsset, 'asset_type'>): Tagged<TextAsset, 'text'> {
  return { ...fields, asset_type: 'text' };
}

/** Build a `URLAsset` with `asset_type: 'url'` injected. */
export function urlAsset(fields: Omit<URLAsset, 'asset_type'>): Tagged<URLAsset, 'url'> {
  return { ...fields, asset_type: 'url' };
}

/** Build an `HTMLAsset` with `asset_type: 'html'` injected. */
export function htmlAsset(fields: Omit<HTMLAsset, 'asset_type'>): Tagged<HTMLAsset, 'html'> {
  return { ...fields, asset_type: 'html' };
}

/** Build a `JavaScriptAsset` with `asset_type: 'javascript'` injected. */
export function javascriptAsset(fields: Omit<JavaScriptAsset, 'asset_type'>): Tagged<JavaScriptAsset, 'javascript'> {
  return { ...fields, asset_type: 'javascript' };
}

/** Build a `CSSAsset` with `asset_type: 'css'` injected. */
export function cssAsset(fields: Omit<CSSAsset, 'asset_type'>): Tagged<CSSAsset, 'css'> {
  return { ...fields, asset_type: 'css' };
}

/** Build a `MarkdownAsset` with `asset_type: 'markdown'` injected. */
export function markdownAsset(fields: Omit<MarkdownAsset, 'asset_type'>): Tagged<MarkdownAsset, 'markdown'> {
  return { ...fields, asset_type: 'markdown' };
}

/** Build a `WebhookAsset` with `asset_type: 'webhook'` injected. */
export function webhookAsset(fields: Omit<WebhookAsset, 'asset_type'>): Tagged<WebhookAsset, 'webhook'> {
  return { ...fields, asset_type: 'webhook' };
}

/**
 * Grouped accessor for every creative-asset builder. `Asset.image({...})`
 * reads better in assets-by-role manifests and gives one-dot autocomplete
 * over the whole family. The individual named exports remain the primary
 * entry points.
 */
export const Asset = {
  image: imageAsset,
  video: videoAsset,
  audio: audioAsset,
  text: textAsset,
  url: urlAsset,
  html: htmlAsset,
  javascript: javascriptAsset,
  css: cssAsset,
  markdown: markdownAsset,
  webhook: webhookAsset,
} as const;
