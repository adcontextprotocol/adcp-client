/**
 * Dependency-free validation for the canonical image and image_carousel
 * contracts. The schemas are intentionally represented as small executable
 * checks so the browser package does not depend on the Node-oriented SDK schema
 * loader. Conformance fixtures keep these checks aligned with the SDK schemas.
 */

const MACRO_PATTERN = /\$?\{([A-Z][A-Z0-9_]*)\}/g;

const DEFAULT_SLOTS = Object.freeze({
  image: Object.freeze([
    { asset_group_id: 'image_main', asset_type: 'image', required: true },
    { asset_group_id: 'headline', asset_type: 'text', required: false },
    { asset_group_id: 'body_text', asset_type: 'text', required: false },
    { asset_group_id: 'primary_text', asset_type: 'text', required: false },
    { asset_group_id: 'cta', asset_type: 'text', required: false },
    { asset_group_id: 'landing_page_url', asset_type: 'url', required: false },
  ]),
  image_carousel: Object.freeze([
    { asset_group_id: 'cards', asset_type: 'card', required: true, min: 2, max: 10 },
    { asset_group_id: 'primary_text', asset_type: 'text', required: false },
    { asset_group_id: 'landing_page_url', asset_type: 'url', required: false },
  ]),
});

function issue(code, path, message) {
  return { code, path, message };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeMacroName(value) {
  return String(value)
    .replace(/^\$?\{/, '')
    .replace(/\}$/, '')
    .toUpperCase();
}

function declaredMacros(input, params) {
  const values =
    input.supportedMacros ??
    input.supported_macros ??
    input.declaration?.supported_macros ??
    params.supported_macros ??
    [];
  return Array.isArray(values)
    ? new Set(values.filter(value => typeof value === 'string').map(normalizeMacroName))
    : new Set();
}

function macroValues(input, supported, issues) {
  const values = new Map();
  if (input.macros === undefined) return values;
  if (!isRecord(input.macros)) {
    issues.push(issue('INVALID_INPUT', 'macros', 'macros must be an object of string preview values'));
    return values;
  }
  for (const [rawName, value] of Object.entries(input.macros)) {
    const name = normalizeMacroName(rawName);
    if (!supported.has(name)) {
      issues.push(issue('UNSUPPORTED_MACRO', `macros.${rawName}`, `${rawName} is not declared in supported_macros`));
    } else if (typeof value !== 'string') {
      issues.push(issue('INVALID_INPUT', `macros.${rawName}`, 'preview macro values must be strings'));
    } else {
      values.set(name, value);
    }
  }
  return values;
}

function substituteMacros(value, path, supported, values, issues) {
  return value.replace(MACRO_PATTERN, (token, rawName) => {
    const name = normalizeMacroName(rawName);
    if (!supported.has(name)) {
      issues.push(issue('UNSUPPORTED_MACRO', path, `${token} is not declared in supported_macros`));
      return token;
    }
    const replacement = values.get(name);
    if (replacement === undefined) {
      issues.push(issue('MISSING_MACRO_VALUE', path, `${token} needs an explicit preview value`));
      return token;
    }
    return replacement;
  });
}

function safeHttpsUrl(value, path, issues) {
  if (typeof value !== 'string' || value.length > 8192) {
    issues.push(issue('INVALID_ASSET', path, 'URL must be an HTTPS string of at most 8192 characters'));
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return value;
  } catch {
    // Return the common structured issue below.
  }
  issues.push(issue('INVALID_ASSET', path, 'URL must use HTTPS without embedded credentials'));
  return undefined;
}

function parseSlots(params, formatKind, issues) {
  const rawSlots = params.slots ?? DEFAULT_SLOTS[formatKind];
  if (!Array.isArray(rawSlots)) {
    issues.push(issue('INVALID_FORMAT_DECLARATION', 'declaration.params.slots', 'slots must be an array'));
    return [];
  }
  const slots = [];
  for (const [index, rawSlot] of rawSlots.entries()) {
    if (!isRecord(rawSlot) || typeof rawSlot.asset_group_id !== 'string' || typeof rawSlot.asset_type !== 'string') {
      issues.push(
        issue(
          'INVALID_FORMAT_DECLARATION',
          `declaration.params.slots.${index}`,
          'each slot needs asset_group_id and asset_type'
        )
      );
      continue;
    }
    slots.push(rawSlot);
  }
  return slots;
}

function parseInput(input, expectedFormat) {
  const issues = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('INVALID_INPUT', '(root)', 'input must be an object')] };
  }
  const manifest = input.manifest;
  if (!isRecord(manifest)) {
    return { ok: false, issues: [issue('INVALID_MANIFEST', 'manifest', 'manifest must be an object')] };
  }
  if (manifest.format_kind !== expectedFormat) {
    return {
      ok: false,
      issues: [
        issue(
          manifest.format_kind === undefined ? 'INVALID_MANIFEST' : 'FORMAT_MISMATCH',
          'manifest.format_kind',
          `expected format_kind ${expectedFormat}`
        ),
      ],
    };
  }
  if (!isRecord(manifest.assets)) {
    return {
      ok: false,
      issues: [issue('INVALID_MANIFEST', 'manifest.assets', 'manifest assets must be an object')],
    };
  }

  const declaration = input.declaration ?? {
    format_kind: expectedFormat,
    params: isRecord(manifest.params) ? manifest.params : {},
  };
  if (!isRecord(declaration) || declaration.format_kind !== expectedFormat) {
    return {
      ok: false,
      issues: [issue('FORMAT_MISMATCH', 'declaration.format_kind', `declaration must target ${expectedFormat}`)],
    };
  }
  if (!isRecord(declaration.params)) {
    return {
      ok: false,
      issues: [issue('INVALID_FORMAT_DECLARATION', 'declaration.params', 'declaration params must be an object')],
    };
  }

  const params = declaration.params;
  const slots = parseSlots(params, expectedFormat, issues);
  const supportedMacros = declaredMacros(input, params);
  const macros = macroValues(input, supportedMacros, issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest, declaration, params, slots, supportedMacros, macros };
}

function slotFor(parsed, assetGroupId) {
  return parsed.slots.find(slot => slot.asset_group_id === assetGroupId);
}

function requireDeclaredSlot(parsed, assetGroupId, assetType, issues) {
  const slot = slotFor(parsed, assetGroupId);
  if (!slot || slot.asset_type !== assetType) {
    issues.push(
      issue(
        'INVALID_FORMAT_DECLARATION',
        'declaration.params.slots',
        `${assetGroupId} must be declared as an ${assetType} slot`
      )
    );
    return undefined;
  }
  return slot;
}

function requiredSlots(parsed, issues) {
  for (const slot of parsed.slots) {
    if (slot.required === true && parsed.manifest.assets[slot.asset_group_id] === undefined) {
      issues.push(
        issue(
          'MISSING_ASSET',
          `manifest.assets.${slot.asset_group_id}`,
          `${slot.asset_group_id} is required by the format declaration`
        )
      );
    }
  }
}

function textAsset(parsed, assetGroupId, maxParam, issues) {
  const raw = parsed.manifest.assets[assetGroupId];
  if (raw === undefined) return undefined;
  if (!requireDeclaredSlot(parsed, assetGroupId, 'text', issues)) return undefined;
  if (!isRecord(raw) || raw.asset_type !== 'text' || typeof raw.content !== 'string') {
    issues.push(issue('INVALID_ASSET', `manifest.assets.${assetGroupId}`, `${assetGroupId} must be a text asset`));
    return undefined;
  }
  const value = substituteMacros(
    raw.content,
    `manifest.assets.${assetGroupId}.content`,
    parsed.supportedMacros,
    parsed.macros,
    issues
  );
  const slotMaximum = slotFor(parsed, assetGroupId)?.max_chars;
  const maximum = parsed.params[maxParam] ?? slotMaximum;
  if (maximum !== undefined && (!positiveInteger(maximum) || value.length > maximum)) {
    issues.push(
      issue(
        positiveInteger(maximum) ? 'CONSTRAINT_VIOLATION' : 'INVALID_FORMAT_DECLARATION',
        positiveInteger(maximum) ? `manifest.assets.${assetGroupId}.content` : `declaration.params.${maxParam}`,
        positiveInteger(maximum)
          ? `${assetGroupId} exceeds the declared ${maximum}-character limit`
          : `${maxParam} must be a positive integer`
      )
    );
  }
  return value;
}

function navigationAsset(parsed, raw, path, issues) {
  const assetGroupId = path.split('.').at(-1);
  if (path.split('.').length === 3 && !requireDeclaredSlot(parsed, assetGroupId, 'url', issues)) {
    return undefined;
  }
  if (!isRecord(raw) || raw.asset_type !== 'url' || typeof raw.url !== 'string') {
    issues.push(issue('INVALID_ASSET', path, 'landing page must be a URL asset'));
    return undefined;
  }
  if (raw.url_type !== undefined && raw.url_type !== 'clickthrough') {
    issues.push(issue('INVALID_ASSET', `${path}.url_type`, 'landing page URL must use clickthrough'));
    return undefined;
  }
  const substituted = substituteMacros(raw.url, `${path}.url`, parsed.supportedMacros, parsed.macros, issues);
  return safeHttpsUrl(substituted, `${path}.url`, issues);
}

function parseRatio(value, path, issues) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+)?:[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    issues.push(issue('INVALID_FORMAT_DECLARATION', path, 'aspect ratio must use width:height'));
    return undefined;
  }
  const [width, height] = value.split(':').map(Number);
  if (!positiveNumber(width) || !positiveNumber(height)) {
    issues.push(issue('INVALID_FORMAT_DECLARATION', path, 'aspect ratio values must be positive'));
    return undefined;
  }
  return width / height;
}

function ratioMatches(width, height, expected) {
  return Math.abs(width / height - expected) < 0.001;
}

function acceptedPixelRatios(params, issues) {
  const ratios = params.pixel_ratios ?? [1];
  if (!Array.isArray(ratios) || ratios.length === 0 || !ratios.every(positiveNumber)) {
    issues.push(
      issue(
        'INVALID_FORMAT_DECLARATION',
        'declaration.params.pixel_ratios',
        'pixel_ratios must be a non-empty array of positive numbers'
      )
    );
    return [1];
  }
  return ratios;
}

function validateImageSizeMode(params, issues) {
  const hasWidth = params.width !== undefined;
  const hasHeight = params.height !== undefined;
  const hasFixed = hasWidth || hasHeight;
  const hasSizes = params.sizes !== undefined;
  const hasRange = ['min_width', 'max_width', 'min_height', 'max_height'].some(name => params[name] !== undefined);
  if (hasWidth !== hasHeight) {
    issues.push(
      issue(
        'INVALID_FORMAT_DECLARATION',
        'declaration.params',
        'fixed image declarations require both width and height'
      )
    );
  }
  if ([hasFixed, hasSizes, hasRange].filter(Boolean).length > 1) {
    issues.push(
      issue(
        'INVALID_FORMAT_DECLARATION',
        'declaration.params',
        'fixed, multi-size, and responsive image size modes are mutually exclusive'
      )
    );
  }
  if (hasWidth && (!positiveInteger(params.width) || !positiveInteger(params.height))) {
    issues.push(
      issue(
        'INVALID_FORMAT_DECLARATION',
        'declaration.params',
        'fixed image width and height must be positive integers'
      )
    );
  }
  if (hasSizes && (!Array.isArray(params.sizes) || params.sizes.length === 0)) {
    issues.push(issue('INVALID_FORMAT_DECLARATION', 'declaration.params.sizes', 'sizes must be a non-empty array'));
  }
  for (const [minimumName, maximumName] of [
    ['min_width', 'max_width'],
    ['min_height', 'max_height'],
  ]) {
    const minimum = params[minimumName];
    const maximum = params[maximumName];
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      issues.push(
        issue('INVALID_FORMAT_DECLARATION', 'declaration.params', `${minimumName} cannot exceed ${maximumName}`)
      );
    }
  }
}

function imageDimensions(raw, params, path, issues) {
  if (!positiveInteger(raw.width) || !positiveInteger(raw.height)) {
    issues.push(issue('INVALID_ASSET', path, 'image needs positive integer width and height'));
    return;
  }
  const ratios = acceptedPixelRatios(params, issues);
  if (raw.pixel_ratio !== undefined && !positiveNumber(raw.pixel_ratio)) {
    issues.push(issue('INVALID_ASSET', `${path}.pixel_ratio`, 'pixel_ratio must be positive'));
    return;
  }
  const candidates = raw.pixel_ratio === undefined ? ratios : [raw.pixel_ratio];
  if (raw.pixel_ratio !== undefined && !ratios.includes(raw.pixel_ratio)) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        `${path}.pixel_ratio`,
        `pixel_ratio ${raw.pixel_ratio} is not accepted by the declaration`
      )
    );
  }

  const fixed = positiveInteger(params.width) && positiveInteger(params.height);
  const sizes = Array.isArray(params.sizes) ? params.sizes : undefined;
  const matchesSize = (logicalWidth, logicalHeight) =>
    candidates.some(
      ratio =>
        Math.abs(raw.width / ratio - logicalWidth) < 0.001 && Math.abs(raw.height / ratio - logicalHeight) < 0.001
    );

  if (fixed && !matchesSize(params.width, params.height)) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        path,
        `image ${raw.width}x${raw.height} does not satisfy logical ${params.width}x${params.height}`
      )
    );
  } else if (sizes) {
    const validSizes = sizes.filter(
      size => isRecord(size) && positiveInteger(size.width) && positiveInteger(size.height)
    );
    if (validSizes.length !== sizes.length) {
      issues.push(
        issue(
          'INVALID_FORMAT_DECLARATION',
          'declaration.params.sizes',
          'sizes must contain positive integer width and height pairs'
        )
      );
    } else if (!validSizes.some(size => matchesSize(size.width, size.height))) {
      issues.push(
        issue(
          'CONSTRAINT_VIOLATION',
          path,
          `image ${raw.width}x${raw.height} does not match a declared logical size and pixel ratio`
        )
      );
    }
  } else {
    const ratio = raw.pixel_ratio ?? 1;
    const logicalWidth = raw.width / ratio;
    const logicalHeight = raw.height / ratio;
    for (const [name, compare] of [
      ['min_width', (actual, limit) => actual >= limit],
      ['max_width', (actual, limit) => actual <= limit],
      ['min_height', (actual, limit) => actual >= limit],
      ['max_height', (actual, limit) => actual <= limit],
    ]) {
      const limit = params[name];
      const actual = name.endsWith('width') ? logicalWidth : logicalHeight;
      if (limit !== undefined && (!positiveInteger(limit) || !compare(actual, limit))) {
        issues.push(
          issue(
            positiveInteger(limit) ? 'CONSTRAINT_VIOLATION' : 'INVALID_FORMAT_DECLARATION',
            positiveInteger(limit) ? path : `declaration.params.${name}`,
            positiveInteger(limit)
              ? `logical image dimensions violate ${name} ${limit}`
              : `${name} must be a positive integer`
          )
        );
      }
    }
  }

  const aspectRatio = parseRatio(params.aspect_ratio, 'declaration.params.aspect_ratio', issues);
  if (aspectRatio !== undefined && !ratioMatches(raw.width, raw.height, aspectRatio)) {
    issues.push(issue('CONSTRAINT_VIOLATION', path, 'image does not match the declared aspect ratio'));
  }
}

function imageMedia(parsed, raw, path, params, issues) {
  if (!isRecord(raw) || raw.asset_type !== 'image' || typeof raw.url !== 'string') {
    issues.push(issue('INVALID_ASSET', path, 'media must be an image asset'));
    return undefined;
  }
  imageDimensions(raw, params, path, issues);
  const substituted = substituteMacros(raw.url, `${path}.url`, parsed.supportedMacros, parsed.macros, issues);
  const url = safeHttpsUrl(substituted, `${path}.url`, issues);
  if (!url || !positiveInteger(raw.width) || !positiveInteger(raw.height)) return undefined;
  return {
    type: 'image',
    url,
    source_url: raw.url,
    width: raw.width,
    height: raw.height,
    ...(typeof raw.alt_text === 'string' ? { alt_text: raw.alt_text } : {}),
  };
}

function videoMedia(parsed, raw, path, params, issues) {
  if (
    !isRecord(raw) ||
    raw.asset_type !== 'video' ||
    typeof raw.url !== 'string' ||
    !positiveInteger(raw.width) ||
    !positiveInteger(raw.height)
  ) {
    issues.push(issue('INVALID_ASSET', path, 'media must be a video asset with width and height'));
    return undefined;
  }
  const substituted = substituteMacros(raw.url, `${path}.url`, parsed.supportedMacros, parsed.macros, issues);
  const url = safeHttpsUrl(substituted, `${path}.url`, issues);
  const maximumDuration = params.card_video_max_duration_ms;
  if (
    maximumDuration !== undefined &&
    (!positiveInteger(maximumDuration) || !positiveNumber(raw.duration_ms) || raw.duration_ms > maximumDuration)
  ) {
    issues.push(
      issue(
        positiveInteger(maximumDuration) ? 'CONSTRAINT_VIOLATION' : 'INVALID_FORMAT_DECLARATION',
        positiveInteger(maximumDuration) ? `${path}.duration_ms` : 'declaration.params.card_video_max_duration_ms',
        positiveInteger(maximumDuration)
          ? `video duration must be present and at most ${maximumDuration}ms`
          : 'card_video_max_duration_ms must be a positive integer'
      )
    );
  }
  if (!url) return undefined;
  return {
    type: 'video',
    url,
    source_url: raw.url,
    width: raw.width,
    height: raw.height,
  };
}

/** Validate and prepare a canonical image manifest without touching the DOM or network. */
export function prepareImageReference(input) {
  const parsed = parseInput(input, 'image');
  if (!parsed.ok) return parsed;
  const issues = [];
  requiredSlots(parsed, issues);
  requireDeclaredSlot(parsed, 'image_main', 'image', issues);
  validateImageSizeMode(parsed.params, issues);
  const image = imageMedia(
    parsed,
    parsed.manifest.assets.image_main,
    'manifest.assets.image_main',
    parsed.params,
    issues
  );
  const headline = textAsset(parsed, 'headline', 'headline_max_chars', issues);
  const bodyText = textAsset(parsed, 'body_text', 'body_text_max_chars', issues);
  const primaryText = textAsset(parsed, 'primary_text', 'primary_text_max_chars', issues);
  const cta = textAsset(parsed, 'cta', 'cta_max_chars', issues);
  const ctaValues = parsed.params.cta_values;
  if (ctaValues !== undefined && (!Array.isArray(ctaValues) || !ctaValues.every(v => typeof v === 'string'))) {
    issues.push(
      issue('INVALID_FORMAT_DECLARATION', 'declaration.params.cta_values', 'cta_values must be an array of strings')
    );
  } else if (cta && ctaValues && !ctaValues.includes(cta)) {
    issues.push(issue('CONSTRAINT_VIOLATION', 'manifest.assets.cta.content', 'CTA is not allowed by cta_values'));
  }
  const landingPageUrl =
    parsed.manifest.assets.landing_page_url === undefined
      ? undefined
      : navigationAsset(parsed, parsed.manifest.assets.landing_page_url, 'manifest.assets.landing_page_url', issues);
  if (issues.length > 0 || !image) return { ok: false, issues };
  return {
    ok: true,
    presentation: {
      format_kind: 'image',
      image,
      ...(headline ? { headline } : {}),
      ...(bodyText ? { body_text: bodyText } : {}),
      ...(primaryText ? { primary_text: primaryText } : {}),
      ...(cta ? { cta } : {}),
      ...(landingPageUrl ? { landing_page_url: landingPageUrl } : {}),
      network: {
        eager_assets: [image.url],
        user_navigations: landingPageUrl ? [landingPageUrl] : [],
      },
    },
  };
}

function cardText(parsed, raw, key, path, maximum, issues) {
  if (raw[key] === undefined) return undefined;
  if (typeof raw[key] !== 'string') {
    issues.push(issue('INVALID_ASSET', `${path}.${key}`, `${key} must be a string`));
    return undefined;
  }
  const value = substituteMacros(raw[key], `${path}.${key}`, parsed.supportedMacros, parsed.macros, issues);
  if (maximum !== undefined && (!positiveInteger(maximum) || value.length > maximum)) {
    issues.push(
      issue(
        positiveInteger(maximum) ? 'CONSTRAINT_VIOLATION' : 'INVALID_FORMAT_DECLARATION',
        positiveInteger(maximum) ? `${path}.${key}` : `declaration.params.${key}`,
        positiveInteger(maximum)
          ? `${key} exceeds the declared ${maximum}-character limit`
          : `${key} maximum must be a positive integer`
      )
    );
  }
  return value;
}

function prepareCard(parsed, raw, index, allowedTypes, aspectRatio, issues) {
  const path = `manifest.assets.cards.${index}`;
  if (!isRecord(raw) || raw.asset_type !== 'card' || !isRecord(raw.media)) {
    issues.push(issue('INVALID_ASSET', path, 'each carousel item must be a card asset with media'));
    return undefined;
  }
  if (!allowedTypes.includes(raw.media.asset_type)) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        `${path}.media.asset_type`,
        `${String(raw.media.asset_type)} is not an allowed carousel media type`
      )
    );
    return undefined;
  }
  const media =
    raw.media.asset_type === 'image'
      ? imageMedia(parsed, raw.media, `${path}.media`, {}, issues)
      : videoMedia(parsed, raw.media, `${path}.media`, parsed.params, issues);
  if (media && aspectRatio !== undefined && !ratioMatches(media.width, media.height, aspectRatio)) {
    issues.push(issue('CONSTRAINT_VIOLATION', `${path}.media`, 'card media does not match card_aspect_ratio'));
  }
  const headline = cardText(parsed, raw, 'headline', path, parsed.params.card_headline_max_chars, issues);
  const description = cardText(parsed, raw, 'description', path, parsed.params.card_description_max_chars, issues);
  const cta = cardText(parsed, raw, 'cta', path, undefined, issues);
  const ctaValues = parsed.params.cta_values;
  if (cta && Array.isArray(ctaValues) && !ctaValues.includes(cta)) {
    issues.push(issue('CONSTRAINT_VIOLATION', `${path}.cta`, 'CTA is not allowed by cta_values'));
  }
  const landingPageUrl =
    raw.landing_page_url === undefined
      ? undefined
      : navigationAsset(parsed, raw.landing_page_url, `${path}.landing_page_url`, issues);
  if (!media) return undefined;
  return {
    media,
    ...(headline ? { headline } : {}),
    ...(description ? { description } : {}),
    ...(cta ? { cta } : {}),
    ...(landingPageUrl ? { landing_page_url: landingPageUrl } : {}),
  };
}

/** Validate and prepare a canonical image_carousel manifest without touching the DOM or network. */
export function prepareImageCarouselReference(input) {
  const parsed = parseInput(input, 'image_carousel');
  if (!parsed.ok) return parsed;
  const issues = [];
  requiredSlots(parsed, issues);
  requireDeclaredSlot(parsed, 'cards', 'card', issues);
  const cards = parsed.manifest.assets.cards;
  if (!Array.isArray(cards)) {
    return {
      ok: false,
      issues: [issue('MISSING_ASSET', 'manifest.assets.cards', 'image_carousel requires a cards array')],
    };
  }
  const cardSlot = slotFor(parsed, 'cards');
  const minimum = parsed.params.min_cards ?? cardSlot?.min ?? 2;
  const maximum = parsed.params.max_cards ?? cardSlot?.max ?? 10;
  if (!positiveInteger(minimum) || minimum < 2 || !positiveInteger(maximum) || maximum < minimum) {
    issues.push(
      issue(
        'INVALID_FORMAT_DECLARATION',
        'declaration.params',
        'carousel min/max cards must be positive, ordered integers with min_cards at least 2'
      )
    );
  } else if (cards.length < minimum || cards.length > maximum) {
    issues.push(
      issue(
        'CONSTRAINT_VIOLATION',
        'manifest.assets.cards',
        `carousel has ${cards.length} cards; declaration allows ${minimum}-${maximum}`
      )
    );
  }
  const allowedTypes = parsed.params.allowed_card_media_asset_types ??
    parsed.params.allowed_card_asset_types ?? ['image'];
  if (
    !Array.isArray(allowedTypes) ||
    allowedTypes.length === 0 ||
    !allowedTypes.every(value => value === 'image' || value === 'video')
  ) {
    issues.push(
      issue(
        'INVALID_FORMAT_DECLARATION',
        'declaration.params.allowed_card_media_asset_types',
        'allowed carousel media types must be a non-empty subset of image and video'
      )
    );
  }
  const aspectRatio = parseRatio(parsed.params.card_aspect_ratio, 'declaration.params.card_aspect_ratio', issues);
  const preparedCards = cards.flatMap((card, index) => {
    const prepared = prepareCard(
      parsed,
      card,
      index,
      Array.isArray(allowedTypes) ? allowedTypes : [],
      aspectRatio,
      issues
    );
    return prepared ? [prepared] : [];
  });
  const primaryText = textAsset(parsed, 'primary_text', 'primary_text_max_chars', issues);
  const landingPageUrl =
    parsed.manifest.assets.landing_page_url === undefined
      ? undefined
      : navigationAsset(parsed, parsed.manifest.assets.landing_page_url, 'manifest.assets.landing_page_url', issues);
  if (issues.length > 0) return { ok: false, issues };
  const navigations = preparedCards.flatMap(card => (card.landing_page_url ? [card.landing_page_url] : []));
  if (landingPageUrl) navigations.push(landingPageUrl);
  return {
    ok: true,
    presentation: {
      format_kind: 'image_carousel',
      cards: preparedCards,
      ...(primaryText ? { primary_text: primaryText } : {}),
      ...(landingPageUrl ? { landing_page_url: landingPageUrl } : {}),
      network: {
        eager_assets: preparedCards.map(card => card.media.url),
        user_navigations: navigations,
      },
    },
  };
}
