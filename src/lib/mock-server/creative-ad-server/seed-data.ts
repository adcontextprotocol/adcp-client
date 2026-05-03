/**
 * `creative-ad-server` upstream-shape seed data. Mirrors the GAM-creative /
 * Innovid / Flashtalking / CM360 model: per-network format catalog, stateful
 * creative library (writeable via POST /v1/creatives), tag generation against
 * stored snippet templates with macro substitution.
 *
 * The library is *stateful* (vs `creative-template`'s stateless transform):
 * `POST /v1/creatives` writes; `GET /v1/creatives` reads; `PATCH` mutates;
 * `POST /v1/creatives/{id}/render` substitutes macros and returns a tag URL.
 *
 * Format renders[] use the closed-shape `displayRender` / `parameterizedRender`
 * pattern (codegen tightening from #1325) so adapter projection composes
 * with `Format.renders[]` typed builders without `as` casts.
 */

import type { Format } from '../../types';

export const DEFAULT_API_KEY = 'mock_creative_ad_server_key_do_not_use_in_prod';

export interface MockNetwork {
  network_code: string;
  display_name: string;
  /** AdCP-side identifier the adapter uses to map principal → network. */
  adcp_publisher: string;
}

export interface MockFormat {
  format_id: string;
  network_code: string;
  /** Human-readable name. */
  name: string;
  /** display | video | ctv | audio. The `Format` type doesn't carry a
   *  top-level kind field; we project to closed-shape `renders[]` per
   *  format. This stays on the upstream side for catalog filtering. */
  channel: 'display' | 'video' | 'ctv' | 'audio';
  /** Render kind drives the adapter's projection — we surface the
   *  closed-shape `Format.renders[]` from this. */
  render_kind: 'fixed' | 'parameterized';
  width?: number;
  height?: number;
  duration_seconds?: number;
  /** MIME types the format accepts on upload. Mock uses these to
   *  auto-detect format from upload mime in handleCreateCreative. */
  accepted_mimes: string[];
  /** Snippet template stored with the format. Substitutes
   *  `{click_url}`, `{impression_pixel}`, `{cb}`, `{advertiser_id}`,
   *  `{creative_id}`, `{width}`, `{height}` at render time. */
  snippet_template: string;
}

export interface MockCreative {
  creative_id: string;
  network_code: string;
  advertiser_id: string;
  format_id: string;
  name: string;
  /** Snippet body — overrides the format's template if set. Otherwise
   *  the format's `snippet_template` is used at render time. */
  snippet?: string;
  status: 'active' | 'paused' | 'archived' | 'rejected';
  click_url?: string;
  /** ISO 8601 created_at — used by `?created_after=` filter and to
   *  scale synth delivery (older creatives have more delivery). */
  created_at: string;
  updated_at: string;
}

export const NETWORKS: MockNetwork[] = [
  {
    network_code: 'net_creative_us',
    display_name: 'Creative Ad Server — US Network',
    adcp_publisher: 'creative-network.example',
  },
  {
    network_code: 'net_acmeoutdoor',
    display_name: 'Acme Outdoor Creative Network',
    adcp_publisher: 'acmeoutdoor.example',
  },
  {
    network_code: 'net_pinnacle',
    display_name: 'Pinnacle Agency Creative Tenant',
    adcp_publisher: 'pinnacle-agency.example',
  },
];

/**
 * Format catalog — 6 base formats spanning display / video / CTV. Each
 * is replicated across all networks (real ad servers do carry per-network
 * format catalogs but most formats are inherited from the platform's
 * default; modeling each network's full catalog as identical keeps the
 * mock simple and matches the Innovid/GAM-creative pattern). The
 * `snippet_template` is what the mock substitutes macros into when
 * `POST /v1/creatives/{id}/render` is called.
 */
const BASE_FORMATS: Omit<MockFormat, 'network_code'>[] = [
  {
    format_id: 'display_300x250',
    name: 'Display 300x250 (medrec)',
    channel: 'display',
    render_kind: 'fixed',
    width: 300,
    height: 250,
    accepted_mimes: ['image/jpeg', 'image/png', 'image/webp', 'text/html'],
    snippet_template:
      '<a href="{click_url}" target="_blank"><img src="{asset_url}" width="{width}" height="{height}"/></a><img src="{impression_pixel}" width="0" height="0"/>',
  },
  {
    format_id: 'display_728x90',
    name: 'Display 728x90 (leaderboard)',
    channel: 'display',
    render_kind: 'fixed',
    width: 728,
    height: 90,
    accepted_mimes: ['image/jpeg', 'image/png', 'image/webp', 'text/html'],
    snippet_template:
      '<a href="{click_url}" target="_blank"><img src="{asset_url}" width="{width}" height="{height}"/></a><img src="{impression_pixel}" width="0" height="0"/>',
  },
  {
    format_id: 'video_30s',
    name: 'Video 30s VAST',
    channel: 'video',
    render_kind: 'fixed',
    duration_seconds: 30,
    accepted_mimes: ['video/mp4', 'application/xml'],
    snippet_template:
      '<VAST version="4.2"><Ad id="{creative_id}"><InLine><Creatives><Creative><Linear><Duration>00:00:{duration_seconds}</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4">{asset_url}</MediaFile></MediaFiles><VideoClicks><ClickThrough>{click_url}</ClickThrough></VideoClicks></Linear></Creative></Creatives><Impression>{impression_pixel}</Impression></InLine></Ad></VAST>',
  },
  {
    format_id: 'video_15s',
    name: 'Video 15s VAST',
    channel: 'video',
    render_kind: 'fixed',
    duration_seconds: 15,
    accepted_mimes: ['video/mp4', 'application/xml'],
    snippet_template:
      '<VAST version="4.2"><Ad id="{creative_id}"><InLine><Creatives><Creative><Linear><Duration>00:00:{duration_seconds}</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4">{asset_url}</MediaFile></MediaFiles><VideoClicks><ClickThrough>{click_url}</ClickThrough></VideoClicks></Linear></Creative></Creatives><Impression>{impression_pixel}</Impression></InLine></Ad></VAST>',
  },
  {
    format_id: 'ctv_30s',
    name: 'CTV 30s VAST (1080p)',
    channel: 'ctv',
    render_kind: 'fixed',
    duration_seconds: 30,
    accepted_mimes: ['video/mp4'],
    snippet_template:
      '<VAST version="4.2"><Ad id="{creative_id}"><InLine><Creatives><Creative><Linear><Duration>00:00:{duration_seconds}</Duration><MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="1920" height="1080">{asset_url}</MediaFile></MediaFiles></Linear></Creative></Creatives><Impression>{impression_pixel}</Impression></InLine></Ad></VAST>',
  },
  {
    format_id: 'display_responsive',
    name: 'Display responsive (parameterized)',
    channel: 'display',
    render_kind: 'parameterized',
    accepted_mimes: ['image/jpeg', 'image/png', 'image/webp'],
    snippet_template:
      '<a href="{click_url}" target="_blank"><img src="{asset_url}" style="max-width:100%"/></a><img src="{impression_pixel}" width="0" height="0"/>',
  },
];

/** Replicate base formats across every network for catalog lookups. */
export const FORMATS: MockFormat[] = NETWORKS.flatMap(net =>
  BASE_FORMATS.map(f => ({ ...f, network_code: net.network_code }))
);

/**
 * Seed creatives — 3 pre-loaded library entries the storyboard runner can
 * read on `GET /v1/creatives` without first POSTing. Production would
 * have an empty seed; these exist so the storyboard's `read-only` checks
 * (list + filter) have something to return on a clean boot.
 */
export const CREATIVES: MockCreative[] = [
  {
    creative_id: 'cr_seed_acme_medrec',
    network_code: 'net_acmeoutdoor',
    advertiser_id: 'adv_acmeoutdoor',
    format_id: 'display_300x250',
    name: 'Acme Outdoor — Summer Hero (300x250)',
    snippet:
      '<a href="https://acmeoutdoor.example/summer" target="_blank"><img src="https://test-assets.adcontextprotocol.org/acme-outdoor/hero-300x250.jpg" width="300" height="250"/></a>',
    status: 'active',
    click_url: 'https://acmeoutdoor.example/summer',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  },
  {
    creative_id: 'cr_seed_acme_leaderboard',
    network_code: 'net_acmeoutdoor',
    advertiser_id: 'adv_acmeoutdoor',
    format_id: 'display_728x90',
    name: 'Acme Outdoor — Summer Hero (728x90)',
    snippet:
      '<a href="https://acmeoutdoor.example/summer" target="_blank"><img src="https://test-assets.adcontextprotocol.org/acme-outdoor/hero-728x90.jpg" width="728" height="90"/></a>',
    status: 'active',
    click_url: 'https://acmeoutdoor.example/summer',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  },
  {
    creative_id: 'cr_seed_pinnacle_video',
    network_code: 'net_pinnacle',
    advertiser_id: 'adv_pinnacle',
    format_id: 'video_30s',
    name: 'Pinnacle Premium Q2 Preroll',
    status: 'active',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  },
];

/**
 * Project an upstream `MockFormat` to the closed-shape `Format` shape the
 * mock surfaces on `GET /v1/formats`. Adapters consume this directly.
 *
 * Format.renders[] uses the closed-shape `displayRender` / `parameterizedRender`
 * convention from #1325 — `dimensions: { width, height, unit }` for fixed,
 * `accepts_parameters[]` for parameterized.
 */
export function projectFormat(format: MockFormat, agentUrl: string): Format {
  const baseFormat: Format = {
    format_id: { agent_url: agentUrl, id: format.format_id },
    name: format.name,
  };

  if (format.render_kind === 'fixed') {
    if (format.channel === 'display' && format.width !== undefined && format.height !== undefined) {
      return {
        ...baseFormat,
        renders: [
          {
            role: 'main',
            dimensions: { width: format.width, height: format.height, unit: 'px' as const },
          },
        ],
      };
    }
    if ((format.channel === 'video' || format.channel === 'ctv') && format.duration_seconds !== undefined) {
      return {
        ...baseFormat,
        renders: [
          {
            role: 'main',
            dimensions: { width: 1920, height: 1080, unit: 'px' as const },
          },
        ],
      };
    }
  }
  // Parameterized — adapter consumes accepts_parameters from format catalog
  // separately; renders[] declares the role only.
  return {
    ...baseFormat,
    renders: [{ role: 'main', dimensions: { width: 0, height: 0, unit: 'px' as const } }],
  };
}
