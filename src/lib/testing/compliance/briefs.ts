/**
 * Sample Brief Library for Convince Assessment
 *
 * Curated briefs across verticals, objectives, and constraints.
 * Each brief includes evaluation hints that guide the AI assessor
 * on what a strong response looks like.
 */

import type { SampleBrief } from './types';

export const SAMPLE_BRIEFS: SampleBrief[] = [
  {
    id: 'luxury_auto_ev',
    name: 'Luxury Auto EV Launch',
    vertical: 'Automotive',
    brief:
      'Luxury automotive brand launching a new electric crossover SUV. ' +
      'Targeting high-income households ($150K+ HHI), ages 30-55, in major US metros. ' +
      'Need high-impact video and premium display placements. ' +
      '$500,000 budget, Q3 flight (July-September). ' +
      'Key message: "The future of luxury driving." Brand safety is critical — no UGC or controversial adjacency.',
    evaluation_hints:
      'Strong response returns both video AND display products (the brief explicitly asks for both). ' +
      'Products should reference auto/luxury vertical targeting or premium audience segments. ' +
      'Pricing should make sense for a $500K budget. ' +
      'Products with audience targeting fields populated score higher. ' +
      'Weak response: only one format, generic descriptions, no audience data.',
    budget_context: '$500,000 total campaign budget',
    expected_channels: ['display', 'olv', 'ctv'],
  },
  {
    id: 'dtc_skincare_genZ',
    name: 'DTC Skincare Gen Z Sprint',
    vertical: 'Beauty & Personal Care',
    brief:
      'Direct-to-consumer skincare brand targeting Gen Z females (18-25). ' +
      'Social-first campaign with UGC-style creative preferred. ' +
      '$50,000 test budget, 2-week sprint. ' +
      'Goal is driving trial purchases through a 20% off promo code. ' +
      'Performance-oriented: need clear CPA/CPC pricing.',
    evaluation_hints:
      'Strong response returns products with performance pricing models (CPC, CPA) — not just CPM. ' +
      'Social or native placements are ideal given the brief. ' +
      'Products should be appropriate for a $50K test budget (not enterprise minimums). ' +
      'Audience targeting for younger demographics is a plus. ' +
      'Weak response: only premium CPM products, high minimums, no performance options.',
    budget_context: '$50,000 test budget',
    expected_channels: ['social', 'display'],
  },
  {
    id: 'b2b_saas_awareness',
    name: 'B2B SaaS Brand Awareness',
    vertical: 'Technology / B2B',
    brief:
      'Enterprise SaaS company building brand awareness among IT decision-makers and C-suite executives. ' +
      'Looking for premium editorial environments — business, technology, and finance publishers. ' +
      '$200,000 budget over 6 weeks. ' +
      'Display and native content placements preferred. CTV is acceptable if targeting is precise. ' +
      'Viewability benchmarks are important — need 70%+ viewability guarantee.',
    evaluation_hints:
      'Strong response returns products with premium publisher placements (not just programmatic remnant). ' +
      'Products mentioning B2B audience segments, professional targeting, or contextual targeting score higher. ' +
      'Viewability guarantees or benchmarks in the product metadata are valuable. ' +
      'Native content placements alongside editorial content are ideal. ' +
      'Weak response: generic display products with no premium differentiation.',
    budget_context: '$200,000 over 6 weeks',
    expected_channels: ['display', 'ctv'],
  },
  {
    id: 'restaurant_local',
    name: 'Restaurant Chain Local Promotion',
    vertical: 'QSR / Restaurant',
    brief:
      'Regional restaurant chain promoting a new menu launch across 15 metro areas. ' +
      'Need geo-targeted mobile and display ads within 5-mile radius of each location. ' +
      '$75,000 budget, 3-week flight. ' +
      'Audio/podcast ads are also interesting if available. ' +
      'Performance tracking: need foot traffic attribution or store visit metrics.',
    evaluation_hints:
      'Strong response returns products with geo-targeting capabilities at the metro or zip level. ' +
      'Mobile-specific products score higher given the local intent. ' +
      'Audio/podcast products show catalog breadth. ' +
      'Products with attribution/measurement capabilities (foot traffic, store visits) are very valuable. ' +
      'Weak response: national-only products with no geo-targeting capability.',
    budget_context: '$75,000 across 15 metros',
    expected_channels: ['display', 'streaming_audio', 'podcast', 'dooh'],
  },
  {
    id: 'streaming_ctv_entertainment',
    name: 'Streaming Service CTV Campaign',
    vertical: 'Entertainment / Media',
    brief:
      'Major streaming service promoting original content launch. ' +
      'CTV and OLV-focused campaign targeting cord-cutters ages 18-49. ' +
      '$1,000,000 budget, 4-week premiere window. ' +
      'Need non-skippable pre-roll and mid-roll video placements. ' +
      'Frequency cap of 3x/week per household. ' +
      'Must support VAST 4.2 tags.',
    evaluation_hints:
      'Strong response returns CTV and OLV products with clear video format specifications. ' +
      'Products should mention non-skip capabilities, VAST support, or programmatic video standards. ' +
      'Frequency capping capability in the product metadata is important. ' +
      'Premium/long-form video inventory scores higher than short-form. ' +
      'Weak response: display-only products, no video inventory, no mention of VAST/video specs.',
    budget_context: '$1,000,000 premiere campaign',
    expected_channels: ['ctv', 'olv'],
  },
  {
    id: 'ecommerce_holiday',
    name: 'E-Commerce Holiday Retargeting',
    vertical: 'Retail / E-Commerce',
    brief:
      'E-commerce retailer running holiday retargeting campaign. ' +
      'Targeting past site visitors and cart abandoners with dynamic product ads. ' +
      '$150,000 budget across Black Friday through Cyber Monday (5 days). ' +
      'Need dynamic creative optimization and product feed integration. ' +
      'Pricing: CPC or CPA preferred for direct response.',
    evaluation_hints:
      'Strong response returns products supporting dynamic creative, retargeting audiences, or product feed integration. ' +
      'CPC/CPA pricing models are better fits than CPM for this performance brief. ' +
      'Products with audience targeting or first-party data capabilities score higher. ' +
      'Short flight window means products should support fast activation. ' +
      'Weak response: awareness-only products, no performance pricing, no dynamic creative capabilities.',
    budget_context: '$150,000 over 5 days (intensive)',
    expected_channels: ['display', 'social'],
  },
  {
    id: 'pharma_awareness',
    name: 'Pharmaceutical HCP Campaign',
    vertical: 'Healthcare / Pharma',
    brief:
      'Pharmaceutical company promoting a new treatment to healthcare professionals (HCPs). ' +
      'Targeting physicians, pharmacists, and nurse practitioners in oncology. ' +
      'Need endemic medical publisher placements — JAMA, Medscape, WebMD Pro. ' +
      '$300,000 budget, 8-week awareness flight. ' +
      'Strict regulatory compliance: all ads must include ISI (Important Safety Information). ' +
      'No programmatic open exchange — direct or PMP only.',
    evaluation_hints:
      'Strong response returns products on medical/healthcare publisher inventory with HCP targeting. ' +
      'Direct or PMP deal types (not open exchange) match the brief requirements. ' +
      'Products mentioning compliance, regulatory support, or ISI handling score higher. ' +
      'Endemic publisher inventory is more valuable than general programmatic for this brief. ' +
      'Weak response: open exchange programmatic with no vertical targeting or compliance features.',
    budget_context: '$300,000 over 8 weeks',
    expected_channels: ['display'],
  },
  {
    id: 'small_budget_test',
    name: 'Small Budget Performance Test',
    vertical: 'General',
    brief:
      'Small business testing digital advertising for the first time. ' +
      '$5,000 total budget, 2-week test. ' +
      'Looking for the most efficient way to drive website traffic. ' +
      'Open to any format or channel. Needs clear reporting.',
    evaluation_hints:
      'Strong response returns accessible products with low minimums that work at $5K scale. ' +
      'CPC pricing is ideal for traffic-driving goals. ' +
      'Products should be actionable without complex setup. ' +
      'Showing variety of options at accessible price points demonstrates good catalog design. ' +
      'Weak response: enterprise-only products with $50K minimums, or no products at this budget level.',
    budget_context: '$5,000 total (very small)',
  },
];

export function getBriefById(id: string): SampleBrief | undefined {
  return SAMPLE_BRIEFS.find(b => b.id === id);
}

export function getBriefsByVertical(vertical: string): SampleBrief[] {
  return SAMPLE_BRIEFS.filter(b => b.vertical.toLowerCase().includes(vertical.toLowerCase()));
}
