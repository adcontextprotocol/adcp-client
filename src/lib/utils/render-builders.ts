// Typed factory helpers for `preview_creative` render objects.
//
// `PreviewRender` is a `oneOf` union on `output_format` — three variants:
//   `url` requires `preview_url`, `html` requires `preview_html`, `both`
//   requires both. The discriminator decides which field becomes required,
//   but nothing forces the caller to set it correctly. Matrix runs
//   repeatedly surfaced renders missing `preview_url` or `output_format`
//   because an agent wrote the object shape by hand.
//
// These builders mirror `imageAsset` / `videoAsset` / etc.: the caller
// passes the payload fields and the helper injects the discriminator.
// Spread order places the discriminator last so a runtime cast cannot
// overwrite the canonical tag.

import type { PreviewRender } from '../types/core.generated';

type UrlRender = Extract<PreviewRender, { output_format: 'url' }>;
type HtmlRender = Extract<PreviewRender, { output_format: 'html' }>;
type BothRender = Extract<PreviewRender, { output_format: 'both' }>;

type Tagged<T, Tag extends string> = Omit<T, 'output_format'> & { output_format: Tag };

/**
 * Build a url-variant `PreviewRender` with `output_format: 'url'` injected.
 *
 * Requires `preview_url` — you can't call this without the field the `url`
 * discriminator makes required, which is the whole point of the helper.
 */
export function urlRender(fields: Omit<UrlRender, 'output_format'>): Tagged<UrlRender, 'url'> {
  return { ...fields, output_format: 'url' };
}

/**
 * Build an html-variant `PreviewRender` with `output_format: 'html'` injected.
 */
export function htmlRender(fields: Omit<HtmlRender, 'output_format'>): Tagged<HtmlRender, 'html'> {
  return { ...fields, output_format: 'html' };
}

/**
 * Build a both-variant `PreviewRender` with `output_format: 'both'` injected.
 * Requires both `preview_url` and `preview_html`.
 */
export function bothRender(fields: Omit<BothRender, 'output_format'>): Tagged<BothRender, 'both'> {
  return { ...fields, output_format: 'both' };
}

/**
 * Grouped namespace over the same helpers, useful when constructing a
 * `renders[]` that mixes variants. Prefer the named exports at single
 * call sites; use `Render.url({...})` when building several types together.
 */
export const Render = {
  url: urlRender,
  html: htmlRender,
  both: bothRender,
} as const;
