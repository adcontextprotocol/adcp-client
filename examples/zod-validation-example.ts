#!/usr/bin/env tsx
/**
 * Example: Using Zod Schemas for Runtime Validation
 *
 * This example demonstrates how to use the generated Zod schemas to validate
 * AdCP data structures at runtime. This is particularly useful for:
 *
 * - Validating API responses from agents
 * - Ensuring data integrity before sending requests
 * - Building forms with runtime validation
 * - Integrating with zod-form libraries
 */

import {
  MediaBuySchema,
  ProductSchema,
  GetProductsRequestSchema,
  GetProductsResponseSchema,
  CreateMediaBuyRequestSchema,
  CreateMediaBuyResponseSchema
} from '../src/lib/types/schemas.generated';

// Example 1: Validate a media buy structure
console.log('📦 Example 1: Validating a MediaBuy\n');

const mediaBuy = {
  media_buy_id: 'mb_12345',
  status: 'active',
  promoted_offering: 'Nike Spring Collection 2024',
  total_budget: 50000,
  packages: []
};

const mediaBuyResult = MediaBuySchema.safeParse(mediaBuy);

if (mediaBuyResult.success) {
  console.log('✅ MediaBuy is valid!');
  console.log('Validated data:', mediaBuyResult.data);
} else {
  console.log('❌ MediaBuy validation failed:');
  console.log(mediaBuyResult.error.format());
}

// Example 2: Validate and catch errors in a product
console.log('\n📦 Example 2: Validating a Product (with intentional error)\n');

const invalidProduct = {
  product_id: 'prod_123',
  // Missing required fields like 'name', 'description', etc.
};

const productResult = ProductSchema.safeParse(invalidProduct);

if (productResult.success) {
  console.log('✅ Product is valid!');
} else {
  console.log('❌ Product validation failed (as expected):');
  console.log('Issues found:', productResult.error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message
  })));
}

// Example 3: Validate request before sending to agent
console.log('\n📦 Example 3: Validating a GetProducts Request\n');

const getProductsRequest = {
  brief: 'Looking for premium display inventory targeting tech professionals',
  brand_manifest: {
    brand_name: 'TechCorp',
    product_catalog: []
  }
};

const requestResult = GetProductsRequestSchema.safeParse(getProductsRequest);

if (requestResult.success) {
  console.log('✅ Request is valid and ready to send!');
  console.log('Brief:', requestResult.data.brief);
} else {
  console.log('❌ Request validation failed:');
  console.log(requestResult.error.format());
}

// Example 4: Validate response from agent
console.log('\n📦 Example 4: Validating a GetProducts Response\n');

const getProductsResponse = {
  products: []
};

const responseResult = GetProductsResponseSchema.safeParse(getProductsResponse);

if (responseResult.success) {
  console.log('✅ Response is valid!');
  console.log('Number of products:', responseResult.data.products.length);
} else {
  console.log('❌ Response validation failed:');
  console.log(responseResult.error.format());
}

// Example 5: Using parse() instead of safeParse() to throw errors
console.log('\n📦 Example 5: Using parse() for stricter validation\n');

try {
  // This will throw a ZodError if validation fails
  const strictMediaBuy = MediaBuySchema.parse(mediaBuy);
  console.log('✅ Strict validation passed!');
} catch (error) {
  console.log('❌ Strict validation failed and threw an error');
  console.log(error);
}

console.log('\n✨ Examples complete!\n');

// Additional use cases:
console.log('💡 Additional use cases for Zod schemas:\n');
console.log('1. Form validation with React Hook Form + Zod');
console.log('2. API middleware for validating requests/responses');
console.log('3. Testing: Validate mock data matches schema');
console.log('4. OpenAPI generation with zod-to-openapi');
console.log('5. Database schema validation before persistence');
console.log('6. Type-safe transformations with .transform()');
