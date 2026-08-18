/**
 * Browser-safe, dependency-free reference presentations for AdCP canonical
 * creative formats. These renderers never fetch resources, fire trackers,
 * resolve VAST wrappers, or execute creative-provided code.
 */

import { prepareImageCarouselReference, prepareImageReference } from './structured.js';

export { prepareImageCarouselReference, prepareImageReference } from './structured.js';

const DEFAULT_DIMENSIONS = Object.freeze({ width: 300, height: 250 });
export const REFERENCE_PRESENTATION_LABEL = 'Community reference presentation — non-authoritative';

function assetValue(assets, ...keys) {
  for (const key of keys) {
    const raw = assets?.[key];
    const asset = Array.isArray(raw) ? raw[0] : raw;
    if (!asset || typeof asset !== 'object') continue;
    if (typeof asset.url === 'string' && asset.url) return asset.url;
    if (typeof asset.content === 'string' && asset.content) return asset.content;
  }
  return '';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function dimensionsFor(manifest, requested) {
  const width = requested?.width ?? manifest?.params?.width ?? manifest?.format_id?.width;
  const height = requested?.height ?? manifest?.params?.height ?? manifest?.format_id?.height;
  if (
    typeof width === 'number' &&
    Number.isFinite(width) &&
    width > 0 &&
    width <= 10000 &&
    typeof height === 'number' &&
    Number.isFinite(height) &&
    height > 0 &&
    height <= 10000
  ) {
    return { width, height };
  }
  return DEFAULT_DIMENSIONS;
}

function page(body, dimensions, title, responsive = false) {
  const frameSize = responsive
    ? 'width:100%;max-width:600px;height:auto;min-height:400px'
    : `width:${dimensions.width}px;height:${dimensions.height}px`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; media-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title><style>
*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f5f5f5;font-family:system-ui,-apple-system,sans-serif}.adcp-label{width:min(100%,600px);padding:5px 8px;background:#e5e7eb;color:#374151;font-size:10px;font-weight:650;letter-spacing:.02em}.adcp-preview{${frameSize};overflow:hidden;position:relative;background:#fff;border:1px solid #ddd}.adcp-preview img,.adcp-preview video{display:block;width:100%;height:100%;object-fit:cover}.adcp-preview video{object-fit:contain;background:#000}.adcp-preview--with-copy{display:grid;grid-template-rows:minmax(0,1fr) auto}.adcp-preview--with-copy>a,.adcp-preview--with-copy>img{min-height:0}.adcp-preview--with-copy>a>img{height:100%}.adcp-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;padding:16px;color:#fff;text-align:center;background:linear-gradient(135deg,#0f766e,#115e59)}.adcp-placeholder strong{font-size:14px}.adcp-placeholder span{margin-top:4px;font-size:11px;opacity:.85}.adcp-native{display:flex;flex-direction:column;gap:8px;height:100%;padding:16px}.adcp-native img{height:60%;border-radius:4px}.adcp-native__sponsor{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em}.adcp-native__title{font-size:16px;font-weight:650;color:#171717}.adcp-native__body{font-size:13px;line-height:1.4;color:#525252}.adcp-native__cta{font-size:13px;font-weight:650;color:#0f766e}.adcp-carousel{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(180px,80%);gap:10px;width:min(100%,600px);padding:10px;overflow-x:auto;background:#fff;border:1px solid #ddd}.adcp-card{overflow:hidden;border:1px solid #ddd;border-radius:6px;background:#fff;scroll-snap-align:start}.adcp-card img,.adcp-card video{display:block;width:100%;height:auto;object-fit:cover}.adcp-card__copy{display:grid;gap:5px;padding:9px}.adcp-card__headline{font-size:14px;font-weight:650;color:#171717}.adcp-card__description,.adcp-carousel__primary{font-size:12px;line-height:1.4;color:#525252}.adcp-card__cta{font-size:12px;font-weight:650;color:#0f766e}
</style></head><body>${body}</body></html>`;
}

function labeled(body) {
  return `<div class="adcp-label">${escapeHtml(REFERENCE_PRESENTATION_LABEL)}</div>${body}`;
}

function placeholder(dimensions, label, detail) {
  return `<div class="adcp-preview"><div class="adcp-placeholder"><strong>${escapeHtml(
    label
  )}</strong><span>${escapeHtml(detail ?? `${dimensions.width}\u00d7${dimensions.height}`)}</span></div></div>`;
}

/** Render an AdCP `image` manifest as a complete inert HTML document. */
export function renderImage(manifest, requestedDimensions) {
  const dimensions = dimensionsFor(manifest, requestedDimensions);
  const assets = manifest?.assets ?? {};
  const imageUrl = assetValue(assets, 'image_main', 'banner_image', 'image');
  const landingPageUrl = assetValue(assets, 'landing_page_url', 'click_url');

  let body;
  if (isSafeUrl(imageUrl)) {
    const image = `<img src="${escapeHtml(imageUrl)}" alt="Ad creative" referrerpolicy="no-referrer">`;
    body = isSafeUrl(landingPageUrl)
      ? `<div class="adcp-preview"><a href="${escapeHtml(
          landingPageUrl
        )}" target="_blank" rel="noopener noreferrer">${image}</a></div>`
      : `<div class="adcp-preview">${image}</div>`;
  } else {
    body = placeholder(dimensions, 'Image creative');
  }

  return page(labeled(body), dimensions, manifest?.name || 'Image preview');
}

function imageBody(presentation) {
  const image = `<img src="${escapeHtml(presentation.image.url)}" alt="${escapeHtml(
    presentation.image.alt_text ?? ''
  )}" referrerpolicy="no-referrer">`;
  const media = presentation.landing_page_url
    ? `<a href="${escapeHtml(presentation.landing_page_url)}" target="_blank" rel="noopener noreferrer">${image}</a>`
    : image;
  const copy = [
    presentation.headline ? `<div class="adcp-card__headline">${escapeHtml(presentation.headline)}</div>` : '',
    presentation.primary_text
      ? `<div class="adcp-card__description">${escapeHtml(presentation.primary_text)}</div>`
      : '',
    presentation.body_text ? `<div class="adcp-card__description">${escapeHtml(presentation.body_text)}</div>` : '',
    presentation.cta ? `<div class="adcp-card__cta">${escapeHtml(presentation.cta)}</div>` : '',
  ].join('');
  return `<div class="adcp-preview${copy ? ' adcp-preview--with-copy' : ''}">${media}${
    copy ? `<div class="adcp-card__copy">${copy}</div>` : ''
  }</div>`;
}

/**
 * Validate and render an image manifest, returning structured issues instead of
 * silently inventing a presentation when the canonical contract is not met.
 */
export function renderImageResult(input, requestedDimensions) {
  const prepared = prepareImageReference(input);
  if (!prepared.ok) return prepared;
  const dimensions = dimensionsFor(input.manifest, requestedDimensions);
  return {
    ...prepared,
    html: page(labeled(imageBody(prepared.presentation)), dimensions, input.manifest?.name || 'Image preview'),
  };
}

function carouselMedia(media) {
  if (media.type === 'video') {
    return `<video width="${media.width}" height="${media.height}" controls playsinline preload="metadata" controlslist="nodownload noremoteplayback" disablepictureinpicture><source src="${escapeHtml(
      media.url
    )}"></video>`;
  }
  return `<img src="${escapeHtml(media.url)}" width="${media.width}" height="${media.height}" alt="${escapeHtml(
    media.alt_text ?? ''
  )}" referrerpolicy="no-referrer">`;
}

function carouselBody(presentation) {
  const primary = presentation.primary_text
    ? `<div class="adcp-carousel__primary">${escapeHtml(presentation.primary_text)}</div>`
    : '';
  const cards = presentation.cards
    .map(card => {
      const media = carouselMedia(card.media);
      const navigationUrl = card.landing_page_url ?? presentation.landing_page_url;
      const linkedMedia = navigationUrl
        ? `<a href="${escapeHtml(navigationUrl)}" target="_blank" rel="noopener noreferrer">${media}</a>`
        : media;
      const copy = [
        card.headline ? `<div class="adcp-card__headline">${escapeHtml(card.headline)}</div>` : '',
        card.description ? `<div class="adcp-card__description">${escapeHtml(card.description)}</div>` : '',
        card.cta ? `<div class="adcp-card__cta">${escapeHtml(card.cta)}</div>` : '',
      ].join('');
      return `<article class="adcp-card">${linkedMedia}${
        copy ? `<div class="adcp-card__copy">${copy}</div>` : ''
      }</article>`;
    })
    .join('');
  return `${primary}<div class="adcp-carousel">${cards}</div>`;
}

/** Validate and render a canonical image_carousel manifest. */
export function renderImageCarouselResult(input, requestedDimensions) {
  const prepared = prepareImageCarouselReference(input);
  if (!prepared.ok) return prepared;
  const dimensions = dimensionsFor(input.manifest, requestedDimensions);
  return {
    ...prepared,
    html: page(
      labeled(carouselBody(prepared.presentation)),
      dimensions,
      input.manifest?.name || 'Image carousel preview',
      true
    ),
  };
}

/**
 * Compatibility HTML export matching renderImage. Invalid manifests produce an
 * inert placeholder; use renderImageCarouselResult when failures must be
 * surfaced to a caller.
 */
export function renderImageCarousel(manifest, requestedDimensions) {
  const result = renderImageCarouselResult({ manifest }, requestedDimensions);
  if (result.ok) return result.html;
  const dimensions = dimensionsFor(manifest, requestedDimensions);
  return page(
    labeled(placeholder(dimensions, 'Image carousel creative', 'Manifest cannot be rendered safely')),
    dimensions,
    manifest?.name || 'Image carousel preview',
    true
  );
}

function extractInlineVastMediaUrl(xml) {
  if (typeof xml !== 'string' || xml.length > 1_000_000 || !xml.toUpperCase().includes('<VAST')) return '';
  const mediaFiles = xml.matchAll(
    /<MediaFile\b[^>]*>(?:<!\[CDATA\[)?\s*(https:\/\/[^<\]\s]+)\s*(?:\]\]>)?<\/MediaFile>/gi
  );
  for (const match of mediaFiles) {
    const candidate = match[1]?.trim();
    if (isSafeUrl(candidate)) return candidate;
  }
  return '';
}

/**
 * Render one HTTPS media file from inline VAST. Remote tags and wrappers are
 * deliberately not fetched, and tracking resources are never emitted.
 */
export function renderVast(manifest, requestedDimensions, label = 'VAST video ad') {
  const dimensions = dimensionsFor(manifest, requestedDimensions);
  const assets = manifest?.assets ?? {};
  const directMediaUrl = assetValue(assets, 'video_file', 'video_asset');
  const rawVast = Array.isArray(assets.vast_tag) ? assets.vast_tag[0] : assets.vast_tag;
  const inlineMediaUrl = extractInlineVastMediaUrl(rawVast?.content);
  const mediaUrl = isSafeUrl(directMediaUrl) ? directMediaUrl : inlineMediaUrl;
  const hasRemoteTag = isSafeUrl(rawVast?.url);

  const body = mediaUrl
    ? `<div class="adcp-preview"><video controls playsinline preload="metadata" controlslist="nodownload noremoteplayback" disablepictureinpicture><source src="${escapeHtml(
        mediaUrl
      )}"></video></div>`
    : placeholder(
        dimensions,
        label,
        hasRemoteTag
          ? 'Remote VAST tag not fetched in reference preview'
          : rawVast?.content
            ? 'No safe inline media file found'
            : 'No VAST media asset'
      );

  return page(labeled(body), dimensions, manifest?.name || label);
}

/** Render an AdCP `native_in_feed` manifest as a complete inert HTML document. */
export function renderNativeInFeed(manifest, requestedDimensions) {
  const dimensions = dimensionsFor(manifest, requestedDimensions);
  const assets = manifest?.assets ?? {};
  const imageUrl = assetValue(assets, 'main_image', 'image');
  const title = assetValue(assets, 'title', 'headline') || 'Native content';
  const bodyText = assetValue(assets, 'body_text', 'description');
  const advertiser = assetValue(assets, 'advertiser_name', 'sponsored_by', 'sponsor');
  const sponsoredLabel = assetValue(assets, 'sponsored_label') || 'Sponsored by';
  const cta = assetValue(assets, 'cta') || 'Learn more';
  const landingPageUrl = assetValue(assets, 'landing_page_url', 'click_url');

  const body = `<div class="adcp-preview"><article class="adcp-native">
${isSafeUrl(imageUrl) ? `<img src="${escapeHtml(imageUrl)}" alt="Native ad image" referrerpolicy="no-referrer">` : ''}
${advertiser ? `<div class="adcp-native__sponsor">${escapeHtml(sponsoredLabel)} ${escapeHtml(advertiser)}</div>` : ''}
<div class="adcp-native__title">${escapeHtml(title)}</div>
${bodyText ? `<div class="adcp-native__body">${escapeHtml(bodyText)}</div>` : ''}
${
  isSafeUrl(landingPageUrl)
    ? `<a class="adcp-native__cta" href="${escapeHtml(
        landingPageUrl
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(cta)}</a>`
    : ''
}
</article></div>`;

  return page(labeled(body), dimensions, manifest?.name || 'Native preview', true);
}

/**
 * Mount a complete renderer document into a capability-minimal iframe. The
 * caller supplies the container; this helper does not consult ambient DOM,
 * credentials, storage, or network APIs.
 */
export function mountReferencePreview(container, html, options = {}) {
  if (
    !container ||
    typeof container.append !== 'function' ||
    !container.ownerDocument ||
    typeof container.ownerDocument.createElement !== 'function'
  ) {
    throw new TypeError('container must be a DOM element with an ownerDocument');
  }
  if (typeof html !== 'string' || !html.startsWith('<!DOCTYPE html>')) {
    throw new TypeError('html must be a complete reference-renderer document');
  }
  const iframe = container.ownerDocument.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', options.title ?? REFERENCE_PRESENTATION_LABEL);
  iframe.setAttribute('loading', options.loading ?? 'lazy');
  iframe.srcdoc = html;
  if (typeof container.replaceChildren === 'function') container.replaceChildren(iframe);
  else container.append(iframe);
  return {
    iframe,
    destroy() {
      iframe.remove();
    },
  };
}
