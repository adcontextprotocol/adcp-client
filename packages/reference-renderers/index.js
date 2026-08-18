/**
 * Browser-safe, dependency-free reference presentations for AdCP canonical
 * creative formats. These renderers never fetch resources, fire trackers,
 * resolve VAST wrappers, or execute creative-provided code.
 */

const DEFAULT_DIMENSIONS = Object.freeze({ width: 300, height: 250 });

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
*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f5;font-family:system-ui,-apple-system,sans-serif}.adcp-preview{${frameSize};overflow:hidden;position:relative;background:#fff;border:1px solid #ddd}.adcp-preview img,.adcp-preview video{display:block;width:100%;height:100%;object-fit:cover}.adcp-preview video{object-fit:contain;background:#000}.adcp-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;padding:16px;color:#fff;text-align:center;background:linear-gradient(135deg,#0f766e,#115e59)}.adcp-placeholder strong{font-size:14px}.adcp-placeholder span{margin-top:4px;font-size:11px;opacity:.85}.adcp-native{display:flex;flex-direction:column;gap:8px;height:100%;padding:16px}.adcp-native img{height:60%;border-radius:4px}.adcp-native__sponsor{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em}.adcp-native__title{font-size:16px;font-weight:650;color:#171717}.adcp-native__body{font-size:13px;line-height:1.4;color:#525252}.adcp-native__cta{font-size:13px;font-weight:650;color:#0f766e}
</style></head><body>${body}</body></html>`;
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

  return page(body, dimensions, manifest?.name || 'Image preview');
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

  return page(body, dimensions, manifest?.name || label);
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

  return page(body, dimensions, manifest?.name || 'Native preview', true);
}
