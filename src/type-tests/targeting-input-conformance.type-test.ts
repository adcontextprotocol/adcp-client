import { buildTargetingInputConformanceVectors, type TargetingDimensionSamples } from '../lib/conformance';

const samples = {
  geo_countries: {
    initialValue: ['US'],
    replacementValue: ['CA'],
  },
} satisfies TargetingDimensionSamples;

const vectors = buildTargetingInputConformanceVectors(samples);

const invalidSamples = {
  geo_countries: {
    // @ts-expect-error Country targeting is a non-empty array, not a scalar.
    initialValue: 'US',
    replacementValue: ['CA'],
  },
} satisfies TargetingDimensionSamples;

void [vectors, invalidSamples];
