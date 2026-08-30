#!/usr/bin/env tsx

import { generate } from 'ts-to-zod';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import ts from 'typescript';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Generate Zod v4 schemas from TypeScript types
 * Uses ts-to-zod to convert our generated TypeScript types to Zod schemas
 *
 * This script generates schemas for ALL types in the source files.
 * Previously we used a whitelist approach, but that was fragile and caused
 * missing dependency bugs. Generating everything is simpler and more reliable.
 */

const CORE_SOURCE_FILE = path.join(__dirname, '../src/lib/types/core.generated.ts');
const TOOLS_SOURCE_FILE = path.join(__dirname, '../src/lib/types/tools.generated.ts');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/types/schemas.generated.ts');

/**
 * Post-process generated Zod schemas to convert .optional() to .nullish() globally.
 * This is needed because real-world API responses often send explicit null values for optional
 * fields, but ts-to-zod generates .optional() which only accepts undefined.
 * Using .nullish() accepts both undefined and null.
 *
 * Many JSON serializers (Python, Java, etc.) default to sending null for absent optional fields,
 * so treating "optional" as "can be undefined OR null" is the pragmatic approach.
 */
function postProcessForNullish(content: string): string {
  // Replace .optional() with .nullish() globally, except when preceded by .never()
  // z.never().optional() must stay as-is: it means "this field must not be provided",
  // and converting to .nullish() would allow null values through, weakening that constraint.
  return content.replace(/(?<!\.never\(\))\.optional\(\)/g, '.nullish()');
}

/**
 * Post-process generated Zod schemas to fix imports from "undefined".
 *
 * ts-to-zod generates `import { type X } from "undefined"` for recursive types
 * when passed combined source text instead of real file paths. The TypeScript type
 * is needed for the z.ZodSchema<X> annotation on z.lazy() schemas. Since all tool
 * types live in tools.generated.ts (same directory as the output), replace the
 * broken import with the correct relative path.
 */
function postProcessUndefinedImports(content: string): string {
  return content.replace(/from "undefined"/g, 'from "./tools.generated"');
}

/**
 * Large union schemas exceed TypeScript's serialization limit (TS7056) when their inferred
 * type has to be written into a .d.ts file. The fix is to give them an explicit `z.ZodType`
 * annotation so TypeScript stops trying to serialize the inferred shape.
 *
 * ts-to-zod doesn't know which schemas will trip TS7056, so we patch the known offenders
 * after generation. If a new schema hits TS7056 in the future, add it to this list rather
 * than scattering annotations across the codebase.
 */
/**
 * Schemas that hit TS7056. Each entry maps the schema name to the typed
 * surface its `z.ZodType<TS>` annotation should carry — without the typed
 * parameter, callers that destructure `params` get `unknown`, breaking
 * downstream inference.
 *
 * Existing entries (`AdCPAsyncResponseDataSchema`, `MCPWebhookPayloadSchema`)
 * use bare `z.ZodType` because they're validation-only — adopters consume
 * the output through `.parse()`'s type-narrowing, not inference. Newer
 * entries from the 3.1.0-beta.2 pin flip carry a TS type because internal
 * call sites destructure their output.
 */
/**
 * Schemas that hit TS7056. Entries can carry an optional `tsType` (the
 * Output/Input TS type for `z.ZodType<T, T>`) and an optional `objectShape`
 * flag — when true, the schema is annotated as `z.ZodObject<...>` instead
 * of `z.ZodType<...>` so call sites that need ZodObject methods (like
 * `withOptionalAccount(...)` which constrains to `z.ZodObject<any>`)
 * keep working.
 *
 * Generated annotations are intentionally verbose; add new TS7056 cases here
 * instead of hand-authoring equivalent schema declarations elsewhere.
 */
const TS7056_SCHEMAS: Array<{
  name: string;
  tsType?: string;
  objectShape?: boolean;
  typeSource?: 'tools' | 'core' | 'v2-projection';
  typedInput?: boolean;
}> = [
  { name: 'AdCPAsyncResponseDataSchema' },
  { name: 'MCPWebhookPayloadSchema' },
  // 3.1.0-beta.2 pin flip — `.and(z.union([...]))` compound patterns push
  // inferred types past TS7056's .d.ts serialization limit. Carry the TS
  // type so callers' `params` keep narrowing.
  { name: 'PreviewCreativeRequestSchema', tsType: 'PreviewCreativeRequest', objectShape: true },
  { name: 'UpdateMediaBuyRequestSchema', tsType: 'UpdateMediaBuyRequest', objectShape: true },
  { name: 'UpdateMediaBuyResponseSchema', tsType: 'UpdateMediaBuyResponse' },
  { name: 'BuildCreativeResponseSchema', tsType: 'BuildCreativeResponse' },
  { name: 'SyncEventSourcesResponseSchema', tsType: 'SyncEventSourcesResponse' },
  { name: 'AudienceEvidenceSchema' },
  { name: 'AudienceEvidenceSelectionSchema' },
  { name: 'ProductSchema', tsType: 'Product', objectShape: true },
  // Public creative asset schemas are loose objects at runtime, but their
  // parse output must remain assignable to the corresponding generated
  // protocol interfaces. Without explicit annotations, nested passthrough
  // objects such as Provenance acquire incompatible string index signatures.
  { name: 'ImageAssetSchema', tsType: 'ImageAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'VideoAssetSchema', tsType: 'VideoAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'AudioAssetSchema', tsType: 'AudioAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'TextAssetSchema', tsType: 'TextAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'URLAssetSchema', tsType: 'URLAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'HTMLAssetSchema', tsType: 'HTMLAsset', objectShape: true, typeSource: 'core', typedInput: true },
  {
    name: 'JavaScriptAssetSchema',
    tsType: 'JavaScriptAsset',
    objectShape: true,
    typeSource: 'core',
    typedInput: true,
  },
  { name: 'ZipAssetSchema', tsType: 'ZipAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'WebhookAssetSchema', tsType: 'WebhookAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'CSSAssetSchema', tsType: 'CSSAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'MarkdownAssetSchema', tsType: 'MarkdownAsset', objectShape: true, typeSource: 'core', typedInput: true },
  { name: 'CardAssetSchema', tsType: 'CardAsset', objectShape: true, typeSource: 'core', typedInput: true },
  {
    name: 'GetProductsRequestSchema',
    tsType: 'GetProductsRequest',
    objectShape: true,
  },
  { name: 'GetProductsAsyncInputRequiredSchema' },
  { name: 'WholesaleFeedEventSchema' },
  { name: 'PackageRequestSchema', tsType: 'PackageRequest', objectShape: true },
  { name: 'ExplicitPackagesWithFixedAllocationSchema' },
  { name: 'PackageSchema', tsType: 'Package', objectShape: true },
  { name: 'CreateMediaBuySuccessSchema' },
  { name: 'PackageUpdateSchema', tsType: 'PackageUpdate', objectShape: true, typeSource: 'core' },
  { name: 'UpdateMediaBuySuccessSchema' },
  { name: 'CreativeLocalizationReadbackSchema' },
  { name: 'SyncCreativesRequestSchema', tsType: 'SyncCreativesRequest', objectShape: true },
  { name: 'SyncCreativesSuccessSchema' },
  { name: 'GetProductsCompletionSchema' },
  { name: 'ComplianceTaskCompletionDataSchema' },
  { name: 'MediaBuySchema' },
  { name: 'GetProductsResponseSchema', tsType: 'GetProductsResponse', objectShape: true },
  { name: 'CreateMediaBuyResponseSchema' },
  { name: 'SyncCreativesResponseSchema' },
  { name: 'ListedCreativeNamedFormatReferenceSchema' },
  { name: 'ListedCreativeCanonicalFormatKindSchema' },
  { name: 'CreateMediaBuyRequestSchema', tsType: 'CreateMediaBuyRequest', objectShape: true },
  { name: 'CanonicalProposalSchema', tsType: 'CanonicalProposal', objectShape: true },
  { name: 'GetMediaBuysResponseMediaBuySchema' },
  { name: 'GetMediaBuysResponseSchema' },
  { name: 'WholesaleFeedWebhookSchema' },
  { name: 'ComplyTestControllerRequestSchema', objectShape: true },
  { name: 'ListCreativesResponseSchema' },
  // 3.2.0-beta.6 expands canonical format declarations and creative-agent
  // responses enough to exceed declaration serialization limits.
  { name: 'ProductFormatDeclarationSchema', tsType: 'ProductFormatDeclaration', objectShape: true },
  { name: 'PlacementSchema', tsType: 'Placement' },
  { name: 'FormatSchema', tsType: 'Format', objectShape: true, typeSource: 'core' },
  { name: 'TransformerSchema', tsType: 'Transformer', objectShape: true },
  { name: 'AvailablePackageSchema', tsType: 'AvailablePackage', objectShape: true, typeSource: 'core' },
  { name: 'ListCreativeFormatsResponseSchema', tsType: 'ListCreativeFormatsResponse', objectShape: true },
  { name: 'PackageStatusSchema', tsType: 'PackageStatus', objectShape: true },
  {
    name: 'ListTransformersResponseCreativeAgentSchema',
    tsType: 'ListTransformersResponseCreativeAgent',
    objectShape: true,
  },
  { name: 'GetAdCPCapabilitiesResponseSchema', tsType: 'GetAdCPCapabilitiesResponse', objectShape: true },
  { name: 'ListTransformersResponseSchema', tsType: 'ListTransformersResponse', objectShape: true },
  {
    name: 'CanonicalFormatSellerRenderedStatefulDisplaySchema',
    tsType: 'CanonicalFormatSellerRenderedStatefulDisplay',
    objectShape: true,
  },
  {
    name: 'CanonicalFormatCoordinatedPlacementsSchema',
    tsType: 'CanonicalFormatCoordinatedPlacements',
    objectShape: true,
  },
];

function postProcessTS7056Annotations(content: string): string {
  let result = content;
  const productObjectShapeType = `{ [K in keyof Product]-?: K extends 'publisher_properties' ? z.ZodType<PublisherPropertySelector[], PublisherPropertySelector[]> : undefined extends Product[K] ? z.ZodOptional<z.ZodType<Exclude<Product[K], undefined>, Exclude<Product[K], undefined>>> : z.ZodType<Product[K], Product[K]> }`;
  const typesToImport = {
    tools: new Set<string>(),
    core: new Set<string>(),
    v2Projection: new Set<string>(),
  };
  for (const { name, tsType, objectShape, typeSource = 'tools', typedInput = false } of TS7056_SCHEMAS) {
    const pattern = new RegExp(`export const ${name} = `);
    if (!pattern.test(result)) {
      throw new Error(
        `postProcessTS7056Annotations: expected to find "export const ${name} = " in generated output. ` +
          'The schema may have been renamed or removed — update TS7056_SCHEMAS.'
      );
    }
    // Object-shaped schemas (pure `z.object({...}).passthrough()`) are
    // annotated as ZodObjects so call sites that use `.shape`, `.extend()`,
    // `.pick()`, or `.omit()` keep working. When a TS type is available,
    // keep the shape keys and field value types tied to that type so
    // downstream helpers like customToolFor() still infer typed args. Use the
    // concrete loose-object config: `any` makes every derived schema infer as
    // `any` in Zod 4. The trailing ZodType keeps exact parse output for
    // intersection/union-backed TypeScript contracts whose common object keys
    // alone cannot reconstruct the full public type.
    //
    // Intersection-shaped schemas (`z.object().passthrough().and(z.union(...))`)
    // use the 2-type-param `z.ZodType<Output, Input>` form. `z.input<typeof X>`
    // resolves to the right shape, and `& Record<string, unknown>` reflects
    // the runtime passthrough so callers expecting `Record<string, unknown>`
    // keep their narrowing.
    let annotation: string;
    if (objectShape) {
      if (tsType) {
        const widened = `${tsType} & Record<string, unknown>`;
        const typedObjectShape = `{ [K in keyof ${tsType}]-?: undefined extends ${tsType}[K] ? z.ZodOptional<z.ZodType<Exclude<${tsType}[K], undefined>, Exclude<${tsType}[K], undefined>>> : z.ZodType<${tsType}[K], ${tsType}[K]> }`;
        const objectShapeType =
          name === 'PreviewCreativeRequestSchema'
            ? `{ request_type: z.ZodType<PreviewCreativeRequest['request_type'], PreviewCreativeRequest['request_type']> } & Record<string, z.ZodType>`
            : name === 'ProductSchema'
              ? 'ProductSchemaShape'
              : typedObjectShape;
        // Product composition has two deliberate compatibility bridges:
        // adopters replace publisher selectors with resolved properties and
        // older placement views with their local output shape. Keep normal
        // safeExtend compatibility checks for every other existing field and
        // preserve the bridges across staged composition.
        const objectType =
          name === 'ProductSchema'
            ? `ProductSchemaObject<${objectShapeType}>`
            : `z.ZodObject<${objectShapeType}, z.core.$loose>`;
        annotation = typedInput
          ? `Omit<${objectType}, keyof z.ZodType> & z.ZodType<${widened}, ${tsType}>`
          : `${objectType} & z.ZodType<${widened}, ${widened}>`;
        const importBucket = typeSource === 'v2-projection' ? typesToImport.v2Projection : typesToImport[typeSource];
        importBucket.add(tsType);
        if (name === 'ProductSchema') typesToImport.tools.add('PublisherPropertySelector');
      } else {
        annotation =
          name === 'ProductSchema'
            ? 'z.ZodObject<{ product_id: z.ZodType; name: z.ZodType; description: z.ZodType; forecast: z.ZodType }>'
            : 'z.ZodObject<Record<string, z.ZodType>, any>';
      }
    } else if (tsType) {
      const widened = `${tsType} & Record<string, unknown>`;
      annotation = `z.ZodType<${widened}, ${widened}>`;
      const importBucket = typeSource === 'v2-projection' ? typesToImport.v2Projection : typesToImport[typeSource];
      importBucket.add(tsType);
    } else {
      annotation = 'z.ZodType';
    }
    const projectionGuard = tsType
      ? '// @ts-ignore -- preserve the public schema type across lossy TS-to-Zod projection details.\n'
      : '';
    result = result.replace(pattern, `${projectionGuard}export const ${name}: ${annotation} = `);
  }
  // Inject `import type { ... } from './tools.generated'` for the typed-zod
  // entries. The compound schemas reference response types defined there.
  if (typesToImport.tools.size > 0 || typesToImport.core.size > 0 || typesToImport.v2Projection.size > 0) {
    const importStatements = [
      typesToImport.tools.size > 0
        ? `import type { ${[...typesToImport.tools].join(', ')} } from './tools.generated';`
        : undefined,
      typesToImport.core.size > 0
        ? `import type { ${[...typesToImport.core].join(', ')} } from './core.generated';`
        : undefined,
      typesToImport.v2Projection.size > 0
        ? `import type { ${[...typesToImport.v2Projection].join(', ')} } from '../v2/projection/creative-delivery';`
        : undefined,
    ]
      .filter(Boolean)
      .join('\n');
    const productSchemaHelperTypes = `export type ProductSchemaShape = ${productObjectShapeType};
export type ProductSchemaSafeExtendShape<
  Base extends z.core.$ZodShape,
  U extends z.core.$ZodShape,
> = {
  [K in keyof U]: K extends 'publisher_properties' | 'placements'
    ? U[K]
    : K extends keyof Base
      ? z.core.output<U[K]> extends z.core.output<Base[K]>
        ? z.core.input<U[K]> extends z.core.input<Base[K]>
          ? U[K]
          : never
        : never
      : U[K];
};
export type ProductSchemaObject<Shape extends z.core.$ZodShape> = {
  safeExtend<U extends z.core.$ZodShape>(
    shape: ProductSchemaSafeExtendShape<Shape, U>
  ): ProductSchemaObject<Omit<Shape, keyof U> & U>;
} & z.ZodObject<Shape, z.core.$loose>;`;
    result = result.replace(
      /import { z } from "zod";\n/,
      `import { z } from "zod";\n${importStatements}\n${productSchemaHelperTypes}\n`
    );
  }
  return result;
}

/**
 * Preserve CreateMediaBuyRequestSchema as a ZodObject. The source type is an
 * intersection between the shared request envelope and a lifecycle-mode
 * union, which ts-to-zod naturally projects as ZodIntersection. Reapplying
 * that union through a refinement keeps identical validation while retaining
 * public object helpers such as `.shape`, `.pick()`, and `.extend()`.
 */
function postProcessCreateMediaBuyRequestObject(content: string): string {
  const lifecycle =
    'z.union([ExplicitPackagesWithFixedAllocationSchema, ExplicitPackagesWithSellerOptimizedAllocationSchema, CommittedProposalExecutionSchema])';
  const escapedLifecycle = lifecycle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `export const CreateMediaBuyRequestSchema = ${escapedLifecycle}\\.and\\((z\\.object\\(\\{[\\s\\S]*?^\\}\\)\\.passthrough\\(\\))\\);`,
    'm'
  );
  if (!pattern.test(content)) {
    throw new Error(
      'postProcessCreateMediaBuyRequestObject: expected the generated lifecycle-union intersection. ' +
        'The source shape changed — update this projection deliberately.'
    );
  }
  return content.replace(
    pattern,
    `export const CreateMediaBuyRequestSchema = $1.superRefine((value, ctx) => {\n` +
      `    const lifecycleResult = ${lifecycle}.safeParse(value);\n` +
      `    if (!lifecycleResult.success) {\n` +
      `        for (const issue of lifecycleResult.error.issues) {\n` +
      `            ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });\n` +
      `        }\n` +
      `    }\n` +
      `});`
  );
}

/**
 * Post-process generated Zod schemas to loosen explicit type annotations on lazy schemas.
 *
 * ts-to-zod generates `export const XSchema: z.ZodSchema<X> = z.lazy(() => ...)` for
 * recursive types. After our .nullish() post-processing the inferred type no longer
 * matches the strict TypeScript type X (optional fields become `T | null | undefined`
 * instead of `T | undefined`). Replace the annotation with `z.ZodTypeAny` to avoid
 * the incompatibility while still breaking the circular reference TypeScript needs.
 *
 * Note: `[^>]+` assumes the type parameter is a simple identifier with no nested generics
 * (e.g., `z.ZodSchema<Foo>` not `z.ZodSchema<Map<string, Foo>>`). ts-to-zod only ever
 * generates simple identifiers here in practice.
 */
function postProcessLazyTypeAnnotations(content: string): string {
  const result = content.replace(/: z\.ZodSchema<[^>]+>/g, ': z.ZodTypeAny');
  // Guard: if any broken annotation remains, fail fast rather than silently produce
  // a TypeScript error that's hard to trace back to this post-processing step.
  if (result.includes('from "undefined"') || result.includes(': z.ZodSchema<')) {
    throw new Error(
      'postProcessLazyTypeAnnotations: unresolved z.ZodSchema<> annotation or "undefined" import in output. ' +
        'A recursive type may have a nested generic parameter — update the regex.'
    );
  }
  return result;
}

const typePrinter = ts.createPrinter({ removeComments: true });
const sourcePrinter = ts.createPrinter();

function canonicalTypeText(node: ts.TypeNode, sourceFile: ts.SourceFile): string {
  let semanticNode = node;
  while (ts.isParenthesizedTypeNode(semanticNode)) semanticNode = semanticNode.type;
  return typePrinter.printNode(ts.EmitHint.Unspecified, semanticNode, sourceFile);
}

function tupleArrayElementType(node: ts.TypeNode, sourceFile: ts.SourceFile): ts.TypeNode | undefined {
  if (!ts.isTupleTypeNode(node)) return undefined;

  const elements = node.elements.map(element => {
    if (ts.isRestTypeNode(element)) {
      return ts.isArrayTypeNode(element.type) ? element.type.elementType : undefined;
    }
    if (ts.isNamedTupleMember(element)) {
      const memberType = element.type;
      return element.dotDotDotToken && ts.isArrayTypeNode(memberType) ? memberType.elementType : memberType;
    }
    return element;
  });
  if (elements.some((element): element is undefined => element === undefined)) return undefined;

  const first = elements[0];
  if (!first) return undefined;
  const canonical = canonicalTypeText(first, sourceFile);
  return elements.every(element => canonicalTypeText(element!, sourceFile) === canonical) ? first : undefined;
}

function cardinalityArrayElementType(node: ts.TypeNode, sourceFile: ts.SourceFile): ts.TypeNode | undefined {
  let semanticNode = node;
  while (ts.isParenthesizedTypeNode(semanticNode)) semanticNode = semanticNode.type;
  if (ts.isTupleTypeNode(semanticNode)) return tupleArrayElementType(semanticNode, sourceFile);
  if (!ts.isUnionTypeNode(semanticNode)) return undefined;

  const elements = semanticNode.types.map(type => {
    let arm = type;
    while (ts.isParenthesizedTypeNode(arm)) arm = arm.type;
    if (!ts.isTupleTypeNode(arm)) return undefined;
    return arm.elements.length === 0 ? null : tupleArrayElementType(arm, sourceFile);
  });
  const first = elements.find((element): element is ts.TypeNode => element != null);
  if (!first || elements.some(element => element === undefined)) return undefined;
  const canonical = canonicalTypeText(first, sourceFile);
  return elements.every(element => element === null || canonicalTypeText(element, sourceFile) === canonical)
    ? first
    : undefined;
}

function relaxCardinalityTypeNode(
  type: ts.TypeNode,
  sourceFile: ts.SourceFile,
  context: ts.TransformationContext,
  visit: ts.Visitor
): ts.TypeNode {
  const element = cardinalityArrayElementType(type, sourceFile);
  if (element) {
    return ts.factory.createArrayTypeNode(ts.visitNode(element, visit, ts.isTypeNode));
  }

  // Cardinality metadata can apply to an array branch in a wider union or to
  // an index-signature/record value. Descend through type containers, but not
  // into object members where an unrelated structural tuple could live.
  if (ts.isParenthesizedTypeNode(type)) {
    return ts.factory.updateParenthesizedType(type, relaxCardinalityTypeNode(type.type, sourceFile, context, visit));
  }
  if (ts.isUnionTypeNode(type)) {
    return ts.factory.updateUnionTypeNode(
      type,
      type.types.map(member => relaxCardinalityTypeNode(member, sourceFile, context, visit))
    );
  }
  if (ts.isIntersectionTypeNode(type)) {
    return ts.factory.updateIntersectionTypeNode(
      type,
      type.types.map(member => relaxCardinalityTypeNode(member, sourceFile, context, visit))
    );
  }
  if (ts.isTypeReferenceNode(type)) {
    return ts.factory.updateTypeReferenceNode(
      type,
      type.typeName,
      type.typeArguments?.map(argument => relaxCardinalityTypeNode(argument, sourceFile, context, visit))
    );
  }
  return ts.visitEachChild(type, visit, context) as ts.TypeNode;
}

/**
 * Relax non-exact JSON Schema array cardinality before passing generated TypeScript
 * to ts-to-zod. json-schema-to-typescript represents those arrays as tuple/rest or
 * bounded tuple-union types, which ts-to-zod faithfully projects as Zod tuples.
 *
 * Scoping the rewrite to declarations carrying @minItems/@maxItems provenance avoids
 * widening authored structural tuple unions. Exact min=max tuples (for example an
 * [x, y] focal point) remain tuples on the public Zod surface.
 */
function relaxArrayCardinalityTypes(source: string): string {
  const sourceFile = ts.createSourceFile(
    'adcp-generated-types.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const relaxedTypeRoots = new Set<ts.TypeNode>();

  const collect = (node: ts.Node): void => {
    const tags = ts.getJSDocTags(node);
    const minTag = tags.find(tag => tag.tagName.text === 'minItems');
    const maxTag = tags.find(tag => tag.tagName.text === 'maxItems');
    if (minTag || maxTag) {
      const min = minTag ? Number(String(minTag.comment ?? '').trim()) : undefined;
      const max = maxTag ? Number(String(maxTag.comment ?? '').trim()) : undefined;
      const exactTuple = min !== undefined && max !== undefined && min === max;
      const typedNode = node as ts.Node & { type?: ts.TypeNode };
      if (!exactTuple && typedNode.type) {
        relaxedTypeRoots.add(typedNode.type);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const transformed = ts.transform(sourceFile, [
    context => root => {
      const visit: ts.Visitor = node => {
        if (ts.isTypeNode(node) && relaxedTypeRoots.has(node)) {
          return relaxCardinalityTypeNode(node, sourceFile, context, visit);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    },
  ]);
  try {
    return sourcePrinter.printFile(transformed.transformed[0]!);
  } finally {
    transformed.dispose();
  }
}

function canonicalSchemaExpression(expression: string): string {
  const sourceFile = ts.createSourceFile(
    'zod-expression.ts',
    `const schema = ${expression};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) return expression;
  const initializer = statement.declarationList.declarations[0]?.initializer;
  return initializer ? typePrinter.printNode(ts.EmitHint.Expression, initializer, sourceFile) : expression;
}

/**
 * Normalize homogeneous tuple/rest projections whose array provenance was lost
 * during JSON Schema -> TypeScript generation (for example array branches inside
 * patternProperties). Fixed tuples and bounded structural tuple unions are not
 * touched. Token comparison ignores generator indentation without conflating
 * whitespace inside string or regular-expression literals.
 */
function postProcessTupleRestArrays(content: string): string {
  const marker = 'z.tuple(';
  let result = '';
  let cursor = 0;

  while (cursor < content.length) {
    const tupleStart = content.indexOf(marker, cursor);
    if (tupleStart < 0) {
      result += content.slice(cursor);
      break;
    }

    result += content.slice(cursor, tupleStart);
    const tupleCall = scanBalanced(content, tupleStart + 'z.tuple'.length);
    const tupleArgument = tupleCall?.body.trim();
    const tupleArray = tupleArgument?.startsWith('[') ? scanBalanced(tupleArgument, 0, '[', ']') : undefined;
    const members =
      tupleArray && !tupleArgument!.slice(tupleArray.end).trim() && tupleArray.body.trim()
        ? splitTopLevelList(tupleArray.body)
        : undefined;
    const restStart = tupleCall?.end;
    const restCall =
      restStart !== undefined && content.startsWith('.rest(', restStart)
        ? scanBalanced(content, restStart + '.rest'.length)
        : undefined;

    if (
      members?.length === 1 &&
      restCall &&
      canonicalSchemaExpression(members[0]!) === canonicalSchemaExpression(restCall.body)
    ) {
      result += `z.array(${postProcessTupleRestArrays(members[0]!)})`;
      cursor = restCall.end;
      continue;
    }

    if (!tupleCall) {
      result += marker;
      cursor = tupleStart + marker.length;
      continue;
    }
    result += `z.tuple(${postProcessTupleRestArrays(tupleCall.body)})`;
    cursor = tupleCall.end;
  }

  return result;
}

/**
 * ts-to-zod narrows `unknown` properties nested in an open object to another
 * open object. Transformer parameter defaults and enumerable option values
 * are explicitly arbitrary JSON, including scalars and null, so restore the
 * TypeScript contract on this one schema.
 */
export function postProcessTransformerParamJsonValues(content: string): string {
  const start = content.indexOf('export const TransformerParamSchema =');
  if (start < 0) return content;
  const end = content.indexOf('\nexport const ', start + 1);
  const blockEnd = end < 0 ? content.length : end;
  const block = content
    .slice(start, blockEnd)
    .replace(/value:\s*(?:z\.object\(\{\}\)\.passthrough\(\)|JsonValueSchema)/, 'value: z.json()')
    .replace(
      /default:\s*(?:z\.object\(\{\}\)\.passthrough\(\)|JsonValueSchema)\.optional\(\),/,
      'default: z.json().optional(),'
    );
  return content.slice(0, start) + block + content.slice(blockEnd);
}

/**
 * Post-process generated Zod schemas to remove z.undefined() from unions.
 *
 * ts-to-zod generates z.undefined() in unions for TypeScript types like
 * `Record<string, boolean | undefined>` → `z.union([z.boolean(), z.undefined()])`.
 * z.undefined() has no JSON Schema representation, so toJSONSchema() throws.
 *
 * For two-member unions like `z.union([X, z.undefined()])`, unwrap to just `X`.
 * For multi-member unions, remove the z.undefined() member.
 *
 * This is safe because:
 * - In record values: absent keys already return undefined
 * - In .nullish() fields: undefined is already accepted
 * - z.unknown() already accepts undefined at runtime
 *
 * Uses balanced-bracket scanning to handle nested schemas like
 * z.union([z.object({...}).passthrough(), z.undefined()]).
 */
function postProcessUndefinedUnions(content: string): string {
  const MARKER = 'z.union([';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      // Scan forward to find the matching ])
      const start = i;
      i += MARKER.length;
      let depth = 1; // tracking [ ] balance
      let body = '';
      while (i < content.length && depth > 0) {
        const ch = content[i]!;
        if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) {
            // Check for closing ]) — the ] we just found plus )
            if (content[i + 1] === ')') {
              // body contains the union members
              // Recursively process the body so nested unions get cleaned first
              const processedBody = postProcessUndefinedUnions(body);
              // ts-to-zod always places z.undefined() as the last union member.
              // If that ever changes, this endsWith check will need to scan all members.
              if (processedBody.endsWith(', z.undefined()')) {
                const inner = processedBody.slice(0, -', z.undefined()'.length);
                // Check if there's only one remaining member (no top-level comma)
                // by scanning for commas at depth 0
                let commaCount = 0;
                let d = 0;
                for (const c of inner) {
                  if (c === '(' || c === '[' || c === '{') d++;
                  else if (c === ')' || c === ']' || c === '}') d--;
                  else if (c === ',' && d === 0) commaCount++;
                }
                if (commaCount === 0) {
                  // Two-member union: unwrap to just the first member
                  result += inner;
                } else {
                  // Multi-member union: keep union without z.undefined()
                  result += MARKER + inner + '])';
                }
                i += 2; // skip ])
                break;
              }
            }
            // Not our pattern — emit with recursively processed body
            result += MARKER + postProcessUndefinedUnions(body) + ']';
            i++; // skip ]
            break;
          }
        }
        body += ch;
        i++;
      }
    } else {
      result += content[i];
      i++;
    }
  }

  return result;
}

/**
 * ts-to-zod maps TypeScript index signatures with maxProperties JSDoc to
 * `z.record(...).max(n)`, but Zod v4 records do not expose string/array-style
 * `.max()`. Keep the record validator and drop the property-count constraint;
 * JSON-schema validation remains the source of truth for those rare caps.
 */
function postProcessRecordSizeConstraints(content: string): string {
  const MARKER = 'z.record(';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (!content.startsWith(MARKER, i)) {
      result += content[i];
      i++;
      continue;
    }

    const recordStart = i;
    i += MARKER.length;
    let depth = 1;
    while (i < content.length && depth > 0) {
      if (content[i] === '"' || content[i] === "'") {
        const quote = content[i];
        i++;
        while (i < content.length && content[i] !== quote) {
          if (content[i] === '\\') i++;
          i++;
        }
      } else if (content[i] === '(') {
        depth++;
      } else if (content[i] === ')') {
        depth--;
      }
      i++;
    }

    result += content.slice(recordStart, i);
    const sizeMatch = content.slice(i).match(/^\.(?:min|max|length)\(\d+\)/);
    if (sizeMatch) i += sizeMatch[0].length;
  }

  return result;
}

/**
 * JSON Schema string keywords are ignored for non-string union arms. ts-to-zod
 * instead appends `.min()` to the entire Zod union, which is not a valid Zod
 * API and crashes module evaluation. Move the constraint onto the string arm.
 */
function postProcessUnionStringLengthConstraints(content: string): string {
  return content.replace(
    /z\.union\(\[z\.object\(\{\}\)\.passthrough\(\), z\.string\(\)\]\)\.min\(1\)/g,
    'z.union([z.object({}).passthrough(), z.string().min(1)])'
  );
}

/** Restore ForecastRange's JSON-Schema-only mid-or-low/high requirement. */
function postProcessForecastRangeConstraint(content: string): string {
  const start = content.indexOf('export const ForecastRangeSchema = ');
  if (start === -1) throw new Error('Unable to locate ForecastRangeSchema');
  const end = content.indexOf('\n\nexport const ', start);
  if (end === -1) throw new Error('Unable to locate ForecastRangeSchema boundary');
  const block = content.slice(start, end);
  const constrained = block.replace(
    /;\s*$/,
    `.superRefine((value, ctx) => {
    const hasMid = value.mid !== undefined;
    const hasRange = value.low !== undefined && value.high !== undefined;
    if (!hasMid && !hasRange) {
        ctx.addIssue({ code: "custom", path: [], message: "forecast range requires mid or both low and high" });
    }
});`
  );
  return content.slice(0, start) + constrained + content.slice(end);
}

/** Restore the price-adjustment XOR and signed 1..20 array bounds. */
function postProcessPriceBreakdownConstraints(content: string): string {
  const adjustmentStart = content.indexOf('export const PriceAdjustmentSchema = ');
  const adjustmentEnd = content.indexOf('\n\nexport const ', adjustmentStart + 1);
  if (adjustmentStart === -1 || adjustmentEnd === -1) {
    throw new Error('Unable to locate PriceAdjustmentSchema boundary');
  }
  const adjustment = content.slice(adjustmentStart, adjustmentEnd).replace(
    /;\s*$/,
    `.superRefine((value, ctx) => {
    if ((value.rate !== undefined) === (value.amount !== undefined)) {
        ctx.addIssue({ code: "custom", path: [], message: "price adjustment requires exactly one of rate or amount" });
    }
});`
  );
  content = content.slice(0, adjustmentStart) + adjustment + content.slice(adjustmentEnd);

  const breakdownStart = content.indexOf('export const PriceBreakdownSchema = ');
  const breakdownEnd = content.indexOf('\n\nexport const ', breakdownStart + 1);
  if (breakdownStart === -1 || breakdownEnd === -1) {
    throw new Error('Unable to locate PriceBreakdownSchema boundary');
  }
  const breakdown = content
    .slice(breakdownStart, breakdownEnd)
    .replace(
      'adjustments: z.array(PriceAdjustmentSchema)',
      'adjustments: z.array(PriceAdjustmentSchema).min(1).max(20)'
    );
  if (!breakdown.includes('adjustments: z.array(PriceAdjustmentSchema).min(1).max(20)')) {
    throw new Error('Unable to preserve PriceBreakdownSchema adjustment bounds');
  }
  return content.slice(0, breakdownStart) + breakdown + content.slice(breakdownEnd);
}

/** Restore beta.4 constraints that TypeScript cannot fully encode for Zod generation. */
function postProcessBeta4OfferAndOutcomeConstraints(content: string): string {
  const replaceBlock = (schemaName: string, transform: (block: string) => string): void => {
    const start = content.indexOf(`export const ${schemaName}Schema = `);
    const end = content.indexOf('\n\nexport const ', start + 1);
    if (start < 0 || end < 0) throw new Error(`Unable to locate ${schemaName}Schema boundary`);
    const block = content.slice(start, end);
    const corrected = transform(block);
    if (corrected === block) throw new Error(`Unable to restore ${schemaName}Schema constraints`);
    content = content.slice(0, start) + corrected + content.slice(end);
  };

  replaceBlock('TimeForecastDimension', block =>
    block
      .replace('start_time: z.string(),', 'start_time: z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time"),')
      .replace('end_time: z.string()', 'end_time: z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time")')
  );

  replaceBlock('ProductOfferFilters', block => {
    const corrected = block
      .replace('start_date: z.string().optional(),', 'start_date: z.iso.date().optional(),')
      .replace('end_date: z.string().optional(),', 'end_date: z.iso.date().optional(),')
      .replace(
        'start_time: z.string(),\n        end_time: z.string()',
        'start_time: z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time"),\n        end_time: z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time")'
      );
    return corrected.replace(
      /;\s*$/,
      `.superRefine((value, ctx) => {
    if (value.availability_horizon !== undefined && (value.start_date !== undefined || value.end_date !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["availability_horizon"], message: "availability_horizon is mutually exclusive with start_date and end_date" });
    }
});`
    );
  });

  replaceBlock('OutcomeTarget', block => {
    const corrected = block
      .replace('custom_event_name: z.string().optional()', 'custom_event_name: z.string().min(1).optional()')
      .replace('volume: z.number()', 'volume: z.number().gt(0)');
    return corrected.replace(
      /;\s*$/,
      `.superRefine((value, ctx) => {
    if (value.goal.kind === "event" && value.goal.event_type === "custom" && !value.goal.custom_event_name) {
        ctx.addIssue({ code: "custom", path: ["goal", "custom_event_name"], message: "custom_event_name is required for a custom event" });
    }
});`
    );
  });

  return content;
}

/** Restore preview mode and batch routing constraints that TypeScript cannot encode. */
function postProcessPreviewCreativeRequestConstraints(content: string): string {
  const schemaStart = content.indexOf('export const PreviewCreativeRequestSchema');
  if (schemaStart < 0) throw new Error('Could not locate PreviewCreativeRequestSchema.');
  const nextSchema = content.indexOf('\n\nexport const ', schemaStart + 1);
  const schemaEnd = nextSchema < 0 ? content.length : nextSchema;
  const block = content.slice(schemaStart, schemaEnd);
  const suffix = '}).passthrough());';
  if (!block.endsWith(suffix)) throw new Error('PreviewCreativeRequestSchema has an unexpected generated suffix.');
  const refined = `${block.slice(0, -suffix.length)}}).passthrough()).superRefine((value, ctx) => {
    const defined = (field: string): boolean => value[field as keyof typeof value] !== undefined;
    const rejectPair = (left: string, right: string): void => {
        if (defined(left) && defined(right)) {
            ctx.addIssue({ code: "custom", path: [right], message: "the paired fields are mutually exclusive" });
        }
    };
    rejectPair("target_capability_id", "format_id");
    rejectPair("creative_manifest", "creative_id");
    if (value.requests !== undefined) {
        if (value.requests.length < 1 || value.requests.length > 50) {
            ctx.addIssue({ code: "custom", path: ["requests"], message: "preview requests must contain 1 to 50 items" });
        }
        const canonicalRouting = defined("target_capability_id") || value.requests.some(item => item.target_capability_id !== undefined);
        const legacyRouting = defined("format_id") || value.requests.some(item => item.format_id !== undefined);
        if (canonicalRouting && legacyRouting) {
            ctx.addIssue({ code: "custom", path: ["requests"], message: "preview requests cannot mix canonical and legacy routing selectors" });
        }
        for (const [index, item] of value.requests.entries()) {
            const hasManifest = item.creative_manifest !== undefined;
            const hasCreativeId = item.creative_id !== undefined;
            if (hasManifest === hasCreativeId) {
                ctx.addIssue({ code: "custom", path: ["requests", index, "creative_manifest"], message: "each preview request requires exactly one of creative_manifest or creative_id" });
            }
        }
    }
    if (value.request_type === "single") {
        const hasManifest = defined("creative_manifest");
        const hasCreativeId = defined("creative_id");
        if (hasManifest === hasCreativeId) {
            ctx.addIssue({ code: "custom", path: ["creative_manifest"], message: "single preview requires exactly one of creative_manifest or creative_id" });
        }
    } else if (value.request_type === "batch") {
        if (value.requests === undefined) {
            ctx.addIssue({ code: "custom", path: ["requests"], message: "batch preview requires 1 to 50 requests" });
        }
    } else if (value.request_type === "variant" && !defined("variant_id")) {
        ctx.addIssue({ code: "custom", path: ["variant_id"], message: "variant_id is required for variant preview" });
    }
});`;
  return content.slice(0, schemaStart) + refined + content.slice(schemaEnd);
}

/**
 * Post-process generated Zod schemas to strip .and(z.record(...)) intersections
 * and equivalent record-only union intersections from object schemas that
 * already have .passthrough().
 *
 * ts-to-zod generates these for TypeScript types with index signatures like
 * `{ field: string } & { [k: string]: unknown }`. Since .passthrough() already
 * preserves unknown keys, the .and(z.record(...)) is redundant and creates
 * ZodIntersection types that lose .shape access (needed by MCP SDK for tool registration).
 *
 * Also handles z.record(...).and(z.object({...})) patterns (record-first intersections)
 * by extracting just the z.object() portion, plus inline or named
 * z.union([RecordUnknownA, RecordUnknownB]).and(z.object({...})) patterns where
 * every union member is only a Record<string, unknown> container.
 */
function postProcessRecordIntersections(content: string): string {
  let result = content;

  // Pass 1: Strip `.and(z.record(z.string(), z.unknown()))` — redundant with .passthrough()
  result = result.replace(/\.and\(z\.record\(z\.string\(\), z\.unknown\(\)\)\)/g, '');

  // Pass 2: Replace `z.record(...).and(CONTENT)` with CONTENT (only for redundant records)
  result = unwrapRecordIntersections(result);

  // Pass 3: Replace `z.union([RecordUnknown...]).and(CONTENT)` with CONTENT.
  result = unwrapRecordUnionIntersections(result);

  // Pass 4: Replace `NamedRecordUnion.and(CONTENT)` with CONTENT.
  result = unwrapNamedRecordUnionIntersections(result);

  // Pass 5: Strip `.and(z.union([...]))` where content contains z.never()
  result = stripNeverUnionIntersections(result);

  return result;
}

/**
 * Collapse impossible empty-object/primitive intersections emitted for
 * string schemas whose JSON Schema `anyOf` branches contain only lexical
 * validators. Ajv retains the original format/pattern validation; the Zod
 * projection must preserve the primitive runtime shape.
 */
function postProcessPrimitiveIntersections(content: string): string {
  const emptyObject = String.raw`z\.object\(\{\}\)(?:\.passthrough\(\))?`;
  const emptyObjectUnion = String.raw`z\.union\(\[\s*${emptyObject}(?:\s*,\s*${emptyObject})+\s*\]\)`;
  const emptyObjectThenPrimitive = new RegExp(
    String.raw`(?:${emptyObject}|${emptyObjectUnion})\.and\(z\.(string|number|boolean)\(\)\)`,
    'g'
  );
  const primitiveThenEmptyObject = new RegExp(
    String.raw`z\.(string|number|boolean)\(\)\.and\((?:${emptyObject}|${emptyObjectUnion})\)`,
    'g'
  );

  let result = content;
  let previous: string;
  do {
    previous = result;
    result = result.replace(emptyObjectThenPrimitive, 'z.$1()').replace(primitiveThenEmptyObject, 'z.$1()');
  } while (result !== previous);
  return result;
}

/**
 * Collapse the canonical-format size-mode marker intersection. The marker
 * models cross-field JSON Schema rules that are enforced by the canonical Ajv
 * schema; retaining it here turns an otherwise ergonomic public object schema
 * into a ZodIntersection without `.shape`/`.extend`/`.pick` support.
 *
 * Keep the base schema by merging the concrete format object into it. This
 * preserves `.shape`, `.extend()`, `.pick()`, and `.omit()` for SDK consumers.
 */
function postProcessCanonicalFormatMarkerIntersections(content: string): string {
  return content
    .replace(
      /CanonicalFormatBaseSchema\.and\(SizeModeMutexSchema\)\.and\(z\.object\(/g,
      'CanonicalFormatBaseSchema.merge(z.object('
    )
    .replace(/SizeModeMutexSchema\.and\(z\.object\(/g, 'z.object({}).passthrough().merge(z.object(');
}

/**
 * Guard against lossy per-format `slots` projections.
 *
 * Canonical formats are compiled from their normalized standalone schemas, so
 * slots must reach ts-to-zod as arrays. Fail generation if bundled-schema
 * ordering ever regresses one of them to Record<string, unknown> again.
 */
function postProcessCanonicalFormatSlots(content: string): string {
  const schemaNames = [
    'CanonicalFormatDisplayTagSchema',
    'CanonicalFormatImageCarouselSchema',
    'CanonicalFormatHostedVideoSchema',
    'CanonicalFormatVASTVideoSchema',
    'CanonicalFormatHostedAudioSchema',
    'CanonicalFormatDAASTAudioSchema',
    'CanonicalFormatSponsoredPlacementRetailMediaCatalogDrivenSchema',
    'CanonicalFormatNativeInFeedSchema',
    'CanonicalFormatResponsiveCreativeSchema',
    'CanonicalFormatAgentPlacementAISurfaceSponsoredPlacementSchema',
    'CanonicalFormatHTML5BannerSchema',
  ] as const;

  let result = content;
  for (const schemaName of schemaNames) {
    const start = result.indexOf(`export const ${schemaName} = `);
    const end = result.indexOf('\n\nexport const ', start + 1);
    if (start === -1 || end === -1) {
      throw new Error(`postProcessCanonicalFormatSlots: unable to locate ${schemaName}.`);
    }
    const block = result.slice(start, end);
    if (/^[ \t]*slots: z\.record\(z\.string\(\), z\.unknown\(\)\)\.optional\(\),$/m.test(block)) {
      throw new Error(`postProcessCanonicalFormatSlots: ${schemaName} emitted lossy record-valued slots.`);
    }
  }
  return result;
}

/**
 * Restore CreativeBrief.compliance.required_disclosures minItems: 1.
 *
 * The TypeScript generator intentionally removes array cardinality constraints
 * because ordinary TypeScript arrays cannot represent them without tuple types.
 * That means ts-to-zod cannot recover this runtime-only constraint. Keep the
 * public TypeScript field ergonomic while restoring the authoritative JSON
 * Schema validation on the generated Zod schema.
 */
function postProcessCreativeBriefRequiredDisclosures(content: string): string {
  const schemaStart = content.indexOf('export const CreativeBriefSchema = ');
  const schemaEnd = content.indexOf('\n\nexport const ', schemaStart + 1);
  if (schemaStart === -1 || schemaEnd === -1) {
    throw new Error('postProcessCreativeBriefRequiredDisclosures: unable to locate CreativeBriefSchema.');
  }

  const block = content.slice(schemaStart, schemaEnd);
  const fieldStart = block.indexOf('required_disclosures: z.array(');
  const nextFieldStart = block.indexOf('\n        prohibited_claims:', fieldStart + 1);
  if (fieldStart === -1 || nextFieldStart === -1) {
    throw new Error(
      'postProcessCreativeBriefRequiredDisclosures: unable to locate required_disclosures field boundary.'
    );
  }

  const field = block.slice(fieldStart, nextFieldStart);
  if (/\.passthrough\(\)\)\.min\(1\)\.optional\(\),$/.test(field)) {
    return content;
  }
  const correctedField = field.replace(/(\.passthrough\(\)\))\.optional\(\),$/, '$1.min(1).optional(),');
  if (correctedField === field) {
    throw new Error('postProcessCreativeBriefRequiredDisclosures: unable to restore minItems on required_disclosures.');
  }

  const correctedBlock = block.slice(0, fieldStart) + correctedField + block.slice(nextFieldStart);
  return content.slice(0, schemaStart) + correctedBlock + content.slice(schemaEnd);
}

/** Restore native PostalArea.values minItems: 1 after tuple relaxation. */
function postProcessPostalAreaValues(content: string): string {
  const schemaStart = content.indexOf('export const PostalAreaSchema = ');
  const schemaEnd = content.indexOf('\n\nexport const ', schemaStart + 1);
  if (schemaStart === -1 || schemaEnd === -1) {
    throw new Error('postProcessPostalAreaValues: unable to locate PostalAreaSchema.');
  }

  const block = content.slice(schemaStart, schemaEnd);
  if (block.includes('native postal values must contain at least one entry')) {
    return content;
  }
  const correctedBlock = block.replace(
    /;\s*$/,
    `.superRefine((value, ctx) => {
  const postal = value as { country?: unknown; values?: unknown };
  if (typeof postal.country === "string" && (!Array.isArray(postal.values) || postal.values.length === 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["values"],
      message: "native postal values must contain at least one entry",
    });
  }
});`
  );
  if (correctedBlock === block) {
    throw new Error('postProcessPostalAreaValues: unable to append native values refinement.');
  }
  return content.slice(0, schemaStart) + correctedBlock + content.slice(schemaEnd);
}

/** Restore the closed beta.4 SDK-local continuation schema exactly. */
function postProcessCompatibilityPurchaseCoordinatorInput(content: string): string {
  const startMarker = 'export const CompatibilityPurchaseCoordinatorInputSchema = ';
  const endMarker = '\n\nexport const OutcomeTargetSchema = ';
  const start = content.indexOf(startMarker);
  if (start < 0) throw new Error('CompatibilityPurchaseCoordinatorInputSchema was not generated.');
  const end = content.indexOf(endMarker, start);
  if (end < 0) throw new Error('Could not locate the end of CompatibilityPurchaseCoordinatorInputSchema.');
  const replacement = `export const CompatibilityPurchaseCoordinatorInputSchema = z.object({
    idempotency_key: z.uuid(),
    continuation_token: z.string().min(16),
    account: AccountReferenceSchema,
    selected_product_ids: z.array(z.string().min(1)).min(1).superRefine((ids, ctx) => {
        if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "selected_product_ids must be unique" });
    }),
    accepted_losses: z.array(z.union([z.literal("feed_version_not_atomic"), z.literal("pricing_version_not_atomic"), z.literal("mutation_idempotency_not_guaranteed")])).min(2).superRefine((losses, ctx) => {
        if (new Set(losses).size !== losses.length) ctx.addIssue({ code: "custom", message: "accepted_losses must be unique" });
        for (const required of ["feed_version_not_atomic", "pricing_version_not_atomic"] as const) {
            if (!losses.includes(required)) ctx.addIssue({ code: "custom", message: \`accepted_losses must contain \${required}\` });
        }
    }),
    legacy_create_request: z.object({}).passthrough().refine(value => Object.keys(value).length > 0, "legacy_create_request must not be empty")
}).strict();`;
  return `${content.slice(0, start)}${replacement}${content.slice(end)}`;
}

/** Restore beta.4 runtime-only membership constraints on projected legacy continuations. */
function postProcessLegacyPurchaseContinuationResponse(content: string): string {
  const schemaStart = content.indexOf('export const RequestProposalsResponseSchema = ');
  const schemaEnd = content.indexOf('\n\nexport const ', schemaStart + 1);
  if (schemaStart < 0 || schemaEnd < 0) {
    throw new Error('Could not locate RequestProposalsResponseSchema.');
  }
  const block = content.slice(schemaStart, schemaEnd);
  const armPattern =
    /z\.object\(\{\n\s+kind: z\.literal\("legacy_create"\),[\s\S]*?requires_explicit_acceptance: z\.literal\(true\)\n\s+\}\)\.passthrough\(\)/g;
  const matches = [...block.matchAll(armPattern)];
  if (matches.length === 0) {
    throw new Error('Could not locate the legacy_create purchase continuation response arm.');
  }
  const refineArm = (arm: string) => `${arm}.superRefine((value, ctx) => {
            if (value.product_ids.length === 0) {
                ctx.addIssue({ code: "custom", path: ["product_ids"], message: "product_ids must contain at least one entry" });
            }
            if (value.product_ids.some(productId => productId.length === 0)) {
                ctx.addIssue({ code: "custom", path: ["product_ids"], message: "product_ids must not contain empty IDs" });
            }
            if (new Set(value.product_ids).size !== value.product_ids.length) {
                ctx.addIssue({ code: "custom", path: ["product_ids"], message: "product_ids must be unique" });
            }
            if (value.losses.length < 2) {
                ctx.addIssue({ code: "custom", path: ["losses"], message: "losses must contain at least two entries" });
            }
            if (new Set(value.losses).size !== value.losses.length) {
                ctx.addIssue({ code: "custom", path: ["losses"], message: "losses must be unique" });
            }
            for (const required of ["feed_version_not_atomic", "pricing_version_not_atomic"] as const) {
                if (!value.losses.includes(required)) {
                    ctx.addIssue({ code: "custom", path: ["losses"], message: \`losses must contain \${required}\` });
                }
            }
            if (value.source_adcp_version === "2.5" && !value.losses.includes("mutation_idempotency_not_guaranteed")) {
                ctx.addIssue({ code: "custom", path: ["losses"], message: "AdCP 2.5 losses must contain mutation_idempotency_not_guaranteed" });
            }
        })`;
  const corrected = block.replace(armPattern, refineArm);
  if (!corrected.endsWith(';')) {
    throw new Error('RequestProposalsResponseSchema has an unexpected generated terminator.');
  }
  // Attach the source-schema invariants to whichever top-level expression
  // ts-to-zod emits. The old lossy type produced union(...).and(object(...));
  // while the materialized discriminated type correctly produces union(...);
  // coupling this postprocessor to either suffix makes type generation fragile.
  const rootRefinement = `.superRefine((value: any, ctx) => {
    const present = (field: string): boolean => Object.prototype.hasOwnProperty.call(value, field);
    const requireNonEmptyArray = (field: "products" | "proposals"): void => {
        if (!Array.isArray(value[field]) || value[field].length === 0) {
            ctx.addIssue({ code: "custom", path: [field], message: \`\${field} must contain at least one entry\` });
        }
    };
    const forbid = (fields: readonly string[]): void => {
        for (const field of fields) {
            if (present(field)) ctx.addIssue({ code: "custom", path: [field], message: \`\${field} is forbidden for this outcome\` });
        }
    };
    forbid(["refinement_applied", "pagination", "unchanged", "wholesale_feed_version"]);
    if (value.suggestions !== undefined && (value.suggestions.length === 0 || value.suggestions.some((suggestion: string) => suggestion.length === 0))) {
        ctx.addIssue({ code: "custom", path: ["suggestions"], message: "suggestions must contain non-empty strings" });
    }
    if (value.incomplete !== undefined && value.incomplete.length === 0) {
        ctx.addIssue({ code: "custom", path: ["incomplete"], message: "incomplete must contain at least one entry" });
    }
    if (value.outcome === "proposed") {
        requireNonEmptyArray("proposals");
        requireNonEmptyArray("products");
        forbid(["reason", "suggestions", "purchase_continuation", "task_id"]);
    } else if (value.outcome === "products_available") {
        requireNonEmptyArray("products");
        if (!present("purchase_continuation")) {
            ctx.addIssue({ code: "custom", path: ["purchase_continuation"], message: "purchase_continuation is required" });
        }
        forbid(["proposals", "reason", "suggestions", "task_id"]);
        if (value.purchase_continuation?.kind === "listed_purchase") {
            const ids = value.purchase_continuation.product_ids;
            if (ids.length === 0 || ids.some((productId: string) => productId.length === 0)) {
                ctx.addIssue({ code: "custom", path: ["purchase_continuation", "product_ids"], message: "product_ids must contain non-empty IDs" });
            }
            if (new Set(ids).size !== ids.length) {
                ctx.addIssue({ code: "custom", path: ["purchase_continuation", "product_ids"], message: "product_ids must be unique" });
            }
            const returnedIds = (value.products ?? []).map((product: any) => product.product_id);
            const returnedIdSet = new Set(returnedIds);
            if (
                returnedIds.length !== ids.length ||
                returnedIdSet.size !== returnedIds.length ||
                ids.some((productId: string) => !returnedIdSet.has(productId))
            ) {
                ctx.addIssue({ code: "custom", path: ["purchase_continuation", "product_ids"], message: "listed product_ids must exactly match returned products" });
            }
            for (const [index, product] of (value.products ?? []).entries()) {
                if (!Array.isArray(product.pricing_options) || product.pricing_options.length === 0) {
                    ctx.addIssue({ code: "custom", path: ["products", index, "pricing_options"], message: "listed products require pricing_options" });
                }
            }
            for (const [index, incomplete] of (value.incomplete ?? []).entries()) {
                if (["products", "pricing", "wholesale_feed"].includes(incomplete.scope)) {
                    ctx.addIssue({ code: "custom", path: ["incomplete", index, "scope"], message: "listed purchase cannot report incomplete product or pricing data" });
                }
            }
        }
    } else if (value.outcome === "rejected") {
        if (!present("reason")) ctx.addIssue({ code: "custom", path: ["reason"], message: "reason is required" });
        forbid(["proposals", "products", "incomplete", "purchase_continuation", "task_id"]);
    }
});`;
  const constrained = corrected.slice(0, -1) + rootRefinement;
  return content.slice(0, schemaStart) + constrained + content.slice(schemaEnd);
}

/** Replace the lossy TS round-trip with Zod generated from the dereferenced canonical wire schema. */
function postProcessCanonicalProposalRuntimeConstraints(content: string, exactSchemaExpression: string): string {
  const schemaStart = content.indexOf('export const CanonicalProposalSchema = ');
  const schemaEnd = content.indexOf('\n\nexport const ', schemaStart + 1);
  if (schemaStart === -1 || schemaEnd === -1) {
    throw new Error('postProcessCanonicalProposalRuntimeConstraints: unable to locate canonical proposal schema.');
  }

  // The SDK deliberately preserves unknown extension fields on public Zod
  // objects. Keep that documented policy while retaining every other scalar,
  // cardinality, conditional, and nested commercial-term constraint.
  const exactWithPassthrough = exactSchemaExpression
    .replaceAll('.strict()', '.passthrough()')
    .replaceAll('.url()', '.refine(adcpJsonSchemaUri, "Invalid URI")');
  const replacement = `export const CanonicalProposalSchema = ${exactWithPassthrough};`;
  const replaced = content.slice(0, schemaStart) + replacement + content.slice(schemaEnd);
  return replaced.replace(
    'import { z } from "zod";\n',
    `import { z } from "zod";\nimport { fullFormats as adcpJsonSchemaFormats } from "ajv-formats/dist/formats.js";\n\nconst adcpDateTimeFormat = adcpJsonSchemaFormats["date-time"] as { validate: (value: string) => boolean };\nconst adcpUriFormat = adcpJsonSchemaFormats.uri as (value: string) => boolean;\nconst adcpJsonSchemaDateTime = (value: string): boolean => adcpDateTimeFormat.validate(value);\nconst adcpJsonSchemaUri = (value: string): boolean => adcpUriFormat(value);\n`
  );
}

/** Replace a generated schema expression with one projected from its authoritative JSON Schema. */
function postProcessExactSchema(content: string, schemaName: string, exactSchemaExpression: string): string {
  const target = findSchemaExportExpressions(content).find(entry => entry.name === schemaName);
  if (!target) throw new Error(`postProcessExactSchema: unable to locate ${schemaName}.`);
  return content.slice(0, target.expressionStart) + exactSchemaExpression + content.slice(target.expressionEnd);
}

/** Restore canonical cardinality constraints for signal expressions. */
function postProcessSignalTargetingExpressionConstraints(content: string): string {
  const target = findSchemaExportExpressions(content).find(entry => entry.name === 'SignalTargetingExpressionSchema');
  if (!target) {
    throw new Error('postProcessSignalTargetingExpressionConstraints: unable to locate schema.');
  }
  const expression = content.slice(target.expressionStart, target.expressionEnd);
  const refined = `${expression}.superRefine((value, ctx) => {
    if (value.value_type === "categorical" && value.values.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["values"],
        message: "categorical signal values must contain at least one entry",
      });
    }
    if (
      value.value_type === "numeric" &&
      value.min_value !== undefined &&
      value.max_value !== undefined &&
      value.min_value > value.max_value
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["min_value"],
        message: "min_value must be less than or equal to max_value",
      });
    }
  })`;
  return content.slice(0, target.expressionStart) + refined + content.slice(target.expressionEnd);
}

/** Add a refinement to one property schema inside a generated z.object expression. */
function refineGeneratedObjectProperty(expression: string, propertyName: string, refinement: string): string {
  const marker = `"${propertyName}": `;
  const propertyStart = expression.indexOf(marker);
  if (propertyStart < 0) throw new Error(`Unable to locate generated property ${propertyName}.`);
  const valueStart = propertyStart + marker.length;
  let depth = 0;

  for (let i = valueStart; i < expression.length; i++) {
    const literalEnd = skipQuotedOrRegexLiteral(expression, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
      continue;
    }
    const ch = expression[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      const value = expression.slice(valueStart, i);
      return expression.slice(0, valueStart) + `${value}.superRefine(${refinement})` + expression.slice(i);
    }
  }

  throw new Error(`Unable to locate the end of generated property ${propertyName}.`);
}

/**
 * Restore refine_proposals runtime constraints that TypeScript cannot retain.
 *
 * The general Zod pipeline intentionally relaxes minItems for legacy arrays,
 * but empty compact refinement results/successors cannot be correlated to the
 * ordered mutation request. The source schema also carries `not` exclusions
 * and an all-finalized batch invariant that disappear during TS projection.
 * Keep TypeScript ergonomic while restoring those wire-boundary checks in the
 * public admission schema.
 */
function postProcessRefineProposalsRuntimeConstraints(content: string): string {
  const schemaStart = content.indexOf('export const RefineProposalsResponseSchema = ');
  const schemaEnd = content.indexOf('\n\nexport const ', schemaStart + 1);
  if (schemaStart === -1 || schemaEnd === -1) {
    throw new Error('postProcessRefineProposalsRuntimeConstraints: unable to locate response schema.');
  }

  const addMinItems = (source: string, fieldName: string, required: boolean): string => {
    const marker = `${fieldName}: z.array(`;
    let corrected = '';
    let cursor = 0;
    let matches = 0;
    while (true) {
      const fieldStart = source.indexOf(marker, cursor);
      if (fieldStart === -1) break;
      const openParen = fieldStart + marker.length - 1;
      const arrayCall = scanBalanced(source, openParen);
      if (!arrayCall) {
        throw new Error(`postProcessRefineProposalsRuntimeConstraints: unbalanced ${fieldName} array schema.`);
      }
      corrected += source.slice(cursor, arrayCall.end);
      if (!source.startsWith('.min(1)', arrayCall.end)) corrected += '.min(1)';
      cursor = arrayCall.end;
      matches++;
    }
    if (required && matches === 0) {
      throw new Error(`postProcessRefineProposalsRuntimeConstraints: ${fieldName} field was not generated.`);
    }
    return corrected + source.slice(cursor);
  };

  let block = content
    .slice(schemaStart, schemaEnd)
    .replaceAll('z.iso.datetime({ offset: true })', 'z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time")')
    .replaceAll('z.iso.datetime()', 'z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time")');
  for (const [fieldName, required] of [
    ['results', true],
    ['proposals', true],
    ['unsatisfied_constraints', false],
    ['suggestions', false],
  ] as const) {
    block = addMinItems(block, fieldName, required);
  }

  const refinement = `.superRefine((value, ctx) => {
    const payload = value as Record<string, unknown>;
    const forbid = (target: Record<string, unknown>, field: string, path: Array<string | number>) => {
        if (target[field] !== undefined) {
            ctx.addIssue({ code: "custom", path: [...path, field], message: \`\${field} is not allowed for this refine_proposals arm\` });
        }
    };
    if (payload.status !== "submitted") forbid(payload, "task_id", []);
    const results = Array.isArray(payload.results) ? payload.results : [];
    const rows = results.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
    if (rows.some(row => row.outcome === "finalized") && rows.some(row => row.outcome !== "finalized")) {
        ctx.addIssue({ code: "custom", path: ["results"], message: "a batch containing finalized must contain only finalized results" });
    }
    rows.forEach((row, index) => {
        const path: Array<string | number> = ["results", index];
        if (typeof row.source_proposal_id === "string" && row.source_proposal_id.length === 0) {
            ctx.addIssue({ code: "custom", path: [...path, "source_proposal_id"], message: "source_proposal_id must not be empty" });
        }
        if (typeof row.reason === "string" && row.reason.length === 0) {
            ctx.addIssue({ code: "custom", path: [...path, "reason"], message: "reason must not be empty" });
        }
        for (const field of ["unsatisfied_constraints", "suggestions"] as const) {
            const values = row[field];
            if (!Array.isArray(values)) continue;
            if (values.some(item => typeof item !== "string" || item.length === 0)) {
                ctx.addIssue({ code: "custom", path: [...path, field], message: \`\${field} entries must be non-empty strings\` });
            }
            if (field === "unsatisfied_constraints" && new Set(values).size !== values.length) {
                ctx.addIssue({ code: "custom", path: [...path, field], message: "unsatisfied_constraints entries must be unique" });
            }
        }
        const productChanges = row.unsatisfied_product_changes;
        if (productChanges && typeof productChanges === "object" && !Array.isArray(productChanges)) {
            const entries = Object.entries(productChanges as Record<string, unknown>);
            if (entries.length === 0 || entries.some(([key, action]) => key.length === 0 || (action !== "include" && action !== "omit"))) {
                ctx.addIssue({ code: "custom", path: [...path, "unsatisfied_product_changes"], message: "unsatisfied_product_changes must be a non-empty product action map" });
            }
        }
        if (row.reason_code === "constraint_unsatisfiable" &&
            row.unsatisfied_constraints === undefined && row.unsatisfied_product_changes === undefined) {
            ctx.addIssue({ code: "custom", path, message: "constraint_unsatisfiable requires unsatisfied details" });
        }
        const forbiddenByOutcome: Record<string, string[]> = {
            revised: ["proposal", "reason_code", "reason", "unsatisfied_constraints", "unsatisfied_product_changes"],
            partial: ["proposal"],
            finalized: ["proposals", "reason_code", "reason", "unsatisfied_constraints", "unsatisfied_product_changes"],
            unable: ["proposal", "proposals"]
        };
        for (const field of forbiddenByOutcome[String(row.outcome)] ?? []) {
            forbid(row, field, path);
        }
        const proposals = [
            ...(row.proposal && typeof row.proposal === "object" ? [row.proposal] : []),
            ...(Array.isArray(row.proposals) ? row.proposals : [])
        ];
        proposals.forEach((proposal, proposalIndex) => {
            const parsed = CanonicalProposalSchema.safeParse(proposal);
            if (!parsed.success) {
                for (const issue of parsed.error.issues) {
                    const prefix = row.proposal === proposal ? ["proposal"] : ["proposals", proposalIndex];
                    ctx.addIssue({ code: "custom", path: [...path, ...prefix, ...issue.path], message: issue.message });
                }
            }
        });
    });
})`;
  const refinedBlock = block.replace(/;\s*$/, `${refinement};`);
  if (refinedBlock === block) {
    throw new Error('postProcessRefineProposalsRuntimeConstraints: unable to append response refinement.');
  }
  return content.slice(0, schemaStart) + refinedBlock + content.slice(schemaEnd);
}

/**
 * Post-process generated Zod schemas to add .passthrough() to all z.object() calls,
 * including deeply nested inline objects.
 *
 * By default, Zod object schemas strip unknown keys during parsing. This causes real-world
 * agent responses with extra/platform-specific fields to lose those fields after validation.
 * Adding .passthrough() preserves unknown keys while still validating known fields.
 *
 * This uses balanced-parenthesis scanning. The body of each z.object() is accumulated and
 * recursively post-processed before emitting, so nested inline z.object() calls also
 * receive .passthrough().
 *
 * LIMITATION: The depth counter does not account for string literals or comments containing
 * bare parentheses. This is safe for ts-to-zod output, which only places parentheses inside
 * function-call syntax, never inside string values. If that assumption ever breaks, switch
 * to an AST-based approach.
 */
function postProcessForPassthrough(content: string): string {
  const MARKER = 'z.object(';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      result += MARKER;
      i += MARKER.length;

      // Accumulate the body of z.object(...) by tracking balanced parens.
      // We start with depth=1 (the opening `(` has already been consumed).
      let depth = 1;
      let body = '';
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          depth--;
          if (depth === 0) {
            // Recursively process the body so nested z.object() calls also get .passthrough()
            result += postProcessForPassthrough(body);
            result += ').passthrough()';
            i++;
            break;
          }
        }
        body += ch;
        i++;
      }
    } else {
      result += content[i];
      i++;
    }
  }

  return result;
}

/**
 * Most AdCP Zod schemas intentionally preserve unknown fields for seller and
 * platform extensions. Trusted Match request schemas are different: their
 * JSON Schemas explicitly set `additionalProperties: false` because context
 * and identity travel on separate privacy-boundary paths. Keep that contract
 * in the generated Zod exports.
 */
function postProcessTrustedMatchPrivacyBoundaryStrictness(content: string): string {
  const strictSchemaExport = (source: string, schemaName: string, nextSchemaName: string): string => {
    const start = source.indexOf(`export const ${schemaName} = z.object({`);
    if (start === -1) return source;
    const end = source.indexOf(`\n\nexport const ${nextSchemaName} = `, start);
    if (end === -1) {
      throw new Error(
        `postProcessTrustedMatchPrivacyBoundaryStrictness: unable to locate schema boundary after ${schemaName}.`
      );
    }

    const before = source.slice(0, start);
    const block = source
      .slice(start, end)
      .replace(/\.passthrough\(\)/g, '.strict()')
      // identities[].attestation.proof intentionally allows scheme-specific
      // proof material (`additionalProperties: true` in the source schema).
      .replace(/proof: z\.object\(\{\}\)\.strict\(\)/g, 'proof: z.object({}).passthrough()');
    const after = source.slice(end);
    return before + block + after;
  };

  let result = strictSchemaExport(content, 'ContextMatchRequestSchema', 'OfferPriceSchema');
  result = strictSchemaExport(result, 'IdentityMatchRequestSchema', 'TMPXChunkSchema');
  return result;
}

/** Preserve JSON-Schema-only creative constraints lost in TS projection. */
function postProcessCreativeRuntimeConstraints(content: string): string {
  const schemaBlock = (schemaName: string): { start: number; end: number; block: string } => {
    const start = content.indexOf(`export const ${schemaName} = `);
    const end = content.indexOf('\n\nexport const ', start + 1);
    if (start === -1 || end === -1) {
      throw new Error(`Unable to locate generated ${schemaName} boundary.`);
    }
    return { start, end, block: content.slice(start, end) };
  };

  const identityRefinement = `.superRefine((value, ctx) => {
    const hasFormatId = value.format_id !== undefined;
    const hasFormatKind = value.format_kind !== undefined;
    if (hasFormatId === hasFormatKind) {
        ctx.addIssue({
            code: "custom",
            path: [],
            message: "creative identity requires exactly one of format_id or format_kind"
        });
    }
    if ("capability_id" in value || "capability_ref" in value) {
        ctx.addIssue({
            code: "custom",
            path: [],
            message: "creative identity does not allow capability_id or capability_ref"
        });
    }
})`;

  const preserveCreativeConstraints = (schemaName: 'CreativeAssetSchema' | 'CreativeManifestSchema'): void => {
    const schema = schemaBlock(schemaName);
    const constrainedAssets = schema.block
      // `patternProperties` is lost when json-schema-to-typescript combines it
      // with `additionalProperties: true`. Preserve validation for canonical
      // slot keys while continuing to allow forward-compatible extension keys.
      // AssetVariantSchema is declared later in the generated module, so defer
      // resolving it until parse time to avoid a top-level TDZ reference.
      .replace(
        /assets: z\.record\(z\.string\(\), (?:z\.unknown\(\)|z\.union\(\[AssetVariantSchema, z\.array\(AssetVariantSchema\)\]\))\)/,
        'assets: CreativeAssetsRuntimeSchema'
      );
    if (constrainedAssets === schema.block) {
      throw new Error(`Unable to preserve creative asset constraints on ${schemaName}.`);
    }

    const withoutLossyIdentityIntersection = constrainedAssets
      // The required/not-only identity branches project to `Record<string,
      // unknown>` aliases, making this intersection both ineffective and, when
      // a string format normalizes its output, capable of throwing Zod's
      // "Unmergable intersection" error. The refinement below preserves the
      // normative XOR directly.
      .replace(
        /\.and\(z\.union\(\[(?:V1CreativeNamedFormatReferenceSchema, V2CreativeCanonicalFormatKindSchema|NamedFormatManifestSchema, CanonicalFormatManifestSchema)\]\)\)/,
        ''
      );
    // Fully normalized named types already project as a single object and do
    // not carry this lossy intersection. Older generated inputs still do, so
    // retain the removal for compatibility without requiring it to exist.

    const strictSchema = withoutLossyIdentityIntersection.replace(/;\s*$/, `${identityRefinement};`);
    if (strictSchema === withoutLossyIdentityIntersection) {
      throw new Error(`Unable to preserve creative identity XOR on ${schemaName}.`);
    }
    content = content.slice(0, schema.start) + strictSchema + content.slice(schema.end);
  };

  preserveCreativeConstraints('CreativeAssetSchema');
  preserveCreativeConstraints('CreativeManifestSchema');

  const creativeManifest = schemaBlock('CreativeManifestSchema');
  // Keep this runtime validator distinct from the public CreativeAssetsSchema
  // that newer protocol bundles generate for the named TypeScript interface.
  const assetValueSchema = `const CreativeAssetValueSchema: z.ZodType = z.unknown().superRefine((value, ctx) => {
    const variants = Array.isArray(value) ? value : [value];
    if (variants.length === 0 || variants.some(variant => !AssetVariantSchema.safeParse(variant).success)) {
        ctx.addIssue({
            code: "custom",
            message: "creative slot must contain an asset or non-empty array of assets"
        });
    }
});

const CreativeAssetsRuntimeSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown()).superRefine((assets, ctx) => {
    for (const [slotKey, assetValue] of Object.entries(assets)) {
        if (/^[a-z0-9_]+$/.test(slotKey) && !CreativeAssetValueSchema.safeParse(assetValue).success) {
            ctx.addIssue({
                code: "custom",
                path: [slotKey],
                message: "creative slot must contain an asset or non-empty array of assets"
            });
        }
    }
});

`;
  content = content.slice(0, creativeManifest.start) + assetValueSchema + content.slice(creativeManifest.start);

  const formatReference = schemaBlock('FormatReferenceStructuredObjectSchema');
  const strictFormatReference = formatReference.block.replace(
    'agent_url: z.string()',
    'agent_url: z.string().regex(/^[\\x21-\\x7E]+$/).regex(/^(?:[^%]|%[0-9A-Fa-f]{2})*$/).refine(adcpJsonSchemaUri, "Invalid URI")'
  );
  if (strictFormatReference === formatReference.block) {
    throw new Error('Unable to apply URI validation to FormatReferenceStructuredObjectSchema.agent_url.');
  }
  return content.slice(0, formatReference.start) + strictFormatReference + content.slice(formatReference.end);
}

/**
 * Preserve closed, declarative presentation-document constraints that cannot
 * survive the JSON Schema -> TypeScript -> Zod projection. Unlike ordinary
 * protocol payloads, placement-presentation documents deliberately forbid
 * extensions because HTML, scripts, CSS, and arbitrary style properties are
 * outside the non-executable rendering contract.
 */
function postProcessPlacementPresentationRuntimeConstraints(content: string): string {
  const replaceSchema = (schemaName: string, replacement: string): void => {
    const start = content.indexOf(`export const ${schemaName} = `);
    const end = content.indexOf('\n\nexport const ', start + 1);
    if (start === -1 || end === -1) {
      throw new Error(`Unable to locate generated ${schemaName} boundary.`);
    }
    content = content.slice(0, start) + replacement.trim() + content.slice(end);
  };

  replaceSchema(
    'RectangleSchema',
    `export const RectangleSchema = z.object({
    x: z.number().int().min(0).max(8192),
    y: z.number().int().min(0).max(8192),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192)
}).strict();`
  );

  replaceSchema(
    'TextDecorationSchema',
    `export const TextDecorationSchema = z.object({
    kind: z.literal("text"),
    layer: LayerSchema,
    bounds: RectangleSchema,
    text: z.string().max(4096),
    text_color: ColorSchema,
    font_size: z.number().int().min(6).max(256)
}).strict();`
  );

  replaceSchema(
    'ImageDecorationSchema',
    `export const ImageDecorationSchema = z.object({
    kind: z.literal("image"),
    layer: LayerSchema,
    bounds: RectangleSchema,
    image_ref: z.object({
        uri: z.string().regex(/^https:\\/\\//).url(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
    }).strict(),
    fit: z.union([z.literal("contain"), z.literal("cover"), z.literal("stretch")])
}).strict();`
  );

  replaceSchema(
    'BoxDecorationSchema',
    `export const BoxDecorationSchema = z.object({
    kind: z.literal("box"),
    layer: LayerSchema,
    bounds: RectangleSchema,
    fill_color: ColorSchema
}).strict();`
  );

  replaceSchema(
    'PlacementPresentationDocumentSchema',
    `export const PlacementPresentationDocumentSchema = z.object({
    schema_version: z.literal("1.0"),
    canvas: z.object({
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
        background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
    }).strict(),
    creative_slot: z.object({
        x: z.number().int().min(0).max(8192),
        y: z.number().int().min(0).max(8192),
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
        fit: z.union([z.literal("contain"), z.literal("cover"), z.literal("stretch")]),
        clip: z.literal(true)
    }).strict(),
    decorations: z.array(z.union([BoxDecorationSchema, TextDecorationSchema, ImageDecorationSchema])).max(100).optional()
}).strict().superRefine((value, ctx) => {
    const fitsCanvas = (rectangle: { x: number; y: number; width: number; height: number }): boolean =>
        rectangle.x + rectangle.width <= value.canvas.width && rectangle.y + rectangle.height <= value.canvas.height;
    if (!fitsCanvas(value.creative_slot)) {
        ctx.addIssue({ code: "custom", path: ["creative_slot"], message: "creative_slot must fit within canvas" });
    }
    value.decorations?.forEach((decoration, index) => {
        if (!fitsCanvas(decoration.bounds)) {
            ctx.addIssue({ code: "custom", path: ["decorations", index, "bounds"], message: "decoration bounds must fit within canvas" });
        }
    });
});`
  );

  const constrainField = (schemaName: string, before: string, after: string): void => {
    const start = content.indexOf(`export const ${schemaName} = `);
    const end = content.indexOf('\n\nexport const ', start + 1);
    if (start === -1 || end === -1) throw new Error(`Unable to locate generated ${schemaName} boundary.`);
    const block = content.slice(start, end);
    if (block.includes(after) || block.includes(after.replace('z.number().int()', 'z.int()'))) return;
    const constrained = block.replace(before, after);
    if (constrained === block) throw new Error(`Unable to preserve numeric constraints on ${schemaName}.`);
    content = content.slice(0, start) + constrained + content.slice(end);
  };

  constrainField(
    'ImageAssetSchema',
    'file_size_bytes: z.number().optional()',
    'file_size_bytes: z.number().int().min(1).optional()'
  );
  constrainField(
    'CanonicalFormatHostedVideoSchema',
    'max_file_size_mb: z.number().min(1).optional()',
    'max_file_size_mb: z.number().int().min(1).optional()'
  );
  constrainField(
    'CanonicalFormatHostedAudioSchema',
    'max_file_size_mb: z.number().optional()',
    'max_file_size_mb: z.number().gt(0).optional()'
  );

  return content;
}

/**
 * Restore constraints from authoritative shared schemas whose JSDoc is lost
 * when ts-to-zod encounters aliases, union members, or a duplicate transitive
 * declaration before the canonical definition. Each rewrite is guarded so a
 * future schema/codegen change fails generation instead of silently weakening
 * the public validator again.
 */
function postProcessCanonicalSharedConstraints(content: string): string {
  const domainPattern = '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$';
  const signalIdPattern = '^[a-zA-Z0-9_-]+$';

  const rewrite = (schemaName: string, before: string, after: string, expectedCount = 1): void => {
    const start = content.indexOf(`export const ${schemaName} = `);
    const end = content.indexOf('\n\nexport const ', start + 1);
    if (start === -1 || end === -1) throw new Error(`Unable to locate generated ${schemaName} boundary.`);
    const block = content.slice(start, end);
    const actualCount = block.split(before).length - 1;
    if (actualCount !== expectedCount) {
      throw new Error(
        `Unable to restore canonical constraints on ${schemaName}: expected ${expectedCount} occurrence(s), found ${actualCount}.`
      );
    }
    content = content.slice(0, start) + block.split(before).join(after) + content.slice(end);
  };

  rewrite('PropertyIDSchema', 'z.string();', 'z.string().regex(/^[a-z0-9_]+$/);');
  rewrite('SignalRefSchema', 'signal_id: z.string()', `signal_id: z.string().regex(/${signalIdPattern}/)`, 3);
  rewrite(
    'SignalRefSchema',
    'data_provider_domain: z.string()',
    `data_provider_domain: z.string().regex(/${domainPattern}/)`
  );
  rewrite(
    'SignalRefSchema',
    'signal_source_url: z.string()',
    'signal_source_url: z.string().refine(adcpJsonSchemaUri, "Invalid URI")'
  );
  rewrite(
    'PaginationRequestSchema',
    'max_results: z.number().optional()',
    'max_results: z.number().int().min(1).max(100).optional()'
  );
  rewrite(
    'DeliveryForecastSchema',
    'measurement_source: z.string().optional()',
    'measurement_source: z.string().max(64).regex(/^[a-z0-9_]+$/).optional()'
  );
  rewrite(
    'DeliveryForecastSchema',
    'generated_at: z.string().optional()',
    'generated_at: z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time").optional()'
  );
  rewrite(
    'DeliveryForecastSchema',
    'valid_until: z.string().optional()',
    'valid_until: z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time").optional()'
  );

  for (const [schemaName, optional] of [
    ['PlacementReferenceSchema', true],
    ['IndicatorScopeSchema', false],
    ['CollectionSelectorSchema', false],
    ['PropertyReferenceSchema', false],
  ] as const) {
    const suffix = optional ? '.optional()' : '';
    rewrite(
      schemaName,
      `publisher_domain: z.string()${suffix}`,
      `publisher_domain: z.string().regex(/${domainPattern}/)${suffix}`
    );
  }

  return content;
}

type CanonicalPrimitiveConstraints = {
  integer?: true;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  dateTime?: true;
  uri?: true;
};

/**
 * Reconcile primitive constraints from the canonical JSON Schema documents
 * after every structural Zod rewrite has run. The TypeScript intermediary can
 * lose JSDoc when a transitive occurrence wins first-definition ownership;
 * this pass makes the canonical document authoritative without relying on a
 * growing allowlist of field names.
 *
 * Constraints are applied by property name only when every occurrence of that
 * name inside the canonical document has the same constraint set. Ambiguous
 * nested names are deliberately left alone rather than applying a constraint
 * in the wrong context. Defaults and array cardinality remain documentation-
 * only by design and are not handled here.
 */
function postProcessCanonicalPrimitiveConstraints(content: string): string {
  const cacheRoot = path.join(__dirname, '../schemas/cache/latest');
  const schemaFiles: string[] = [];
  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'bundled') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visitDirectory(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) schemaFiles.push(absolute);
    }
  };
  visitDirectory(cacheRoot);

  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const constraintsFor = (schema: Record<string, unknown>): CanonicalPrimitiveConstraints => {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const includes = (type: string): boolean => types.includes(type);
    const constraints: CanonicalPrimitiveConstraints = {};
    if (includes('integer')) constraints.integer = true;
    if (includes('integer') || includes('number')) {
      for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const) {
        if (typeof schema[key] === 'number' && Number.isFinite(schema[key])) constraints[key] = schema[key];
      }
    }
    if (includes('string')) {
      if (typeof schema.minLength === 'number' && Number.isInteger(schema.minLength)) {
        constraints.minLength = schema.minLength;
      }
      if (typeof schema.maxLength === 'number' && Number.isInteger(schema.maxLength)) {
        constraints.maxLength = schema.maxLength;
      }
      if (typeof schema.pattern === 'string') constraints.pattern = schema.pattern;
      if (schema.format === 'date-time') constraints.dateTime = true;
      if (schema.format === 'uri') constraints.uri = true;
    }
    return constraints;
  };

  const constrainExpression = (expression: string, constraints: CanonicalPrimitiveConstraints): string => {
    let result = expression;
    if (result.includes('z.number()')) {
      let suffix = '';
      if (constraints.integer && !/z\.(?:number\(\)\.int|int)\(\)/.test(result)) suffix += '.int()';
      if (
        constraints.minimum !== undefined &&
        !result.includes(`.min(${constraints.minimum})`) &&
        !result.includes(`.gte(${constraints.minimum})`)
      ) {
        suffix += `.gte(${constraints.minimum})`;
      }
      if (
        constraints.maximum !== undefined &&
        !result.includes(`.max(${constraints.maximum})`) &&
        !result.includes(`.lte(${constraints.maximum})`)
      ) {
        suffix += `.lte(${constraints.maximum})`;
      }
      if (constraints.exclusiveMinimum !== undefined && !result.includes(`.gt(${constraints.exclusiveMinimum})`)) {
        suffix += `.gt(${constraints.exclusiveMinimum})`;
      }
      if (constraints.exclusiveMaximum !== undefined && !result.includes(`.lt(${constraints.exclusiveMaximum})`)) {
        suffix += `.lt(${constraints.exclusiveMaximum})`;
      }
      if (constraints.multipleOf !== undefined && !result.includes(`.multipleOf(${constraints.multipleOf})`)) {
        suffix += `.multipleOf(${constraints.multipleOf})`;
      }
      if (suffix) result = result.replace('z.number()', `z.number()${suffix}`);
    }
    if (result.includes('z.string()')) {
      let suffix = '';
      if (constraints.minLength !== undefined && !result.includes(`.min(${constraints.minLength})`)) {
        suffix += `.min(${constraints.minLength})`;
      }
      if (constraints.maxLength !== undefined && !result.includes(`.max(${constraints.maxLength})`)) {
        suffix += `.max(${constraints.maxLength})`;
      }
      if (constraints.pattern !== undefined && !result.includes('.regex(')) {
        suffix += `.regex(new RegExp(${JSON.stringify(constraints.pattern)}))`;
      }
      if (constraints.dateTime && !result.includes('adcpJsonSchemaDateTime') && !result.includes('z.iso.datetime()')) {
        suffix += '.refine(adcpJsonSchemaDateTime, "Invalid date-time")';
      }
      if (constraints.uri && !result.includes('adcpJsonSchemaUri')) {
        suffix += '.refine(adcpJsonSchemaUri, "Invalid URI")';
      }
      if (suffix) result = result.replace('z.string()', `z.string()${suffix}`);
    }
    return result;
  };

  for (const schemaFile of schemaFiles.sort()) {
    const schema = JSON.parse(readFileSync(schemaFile, 'utf8')) as Record<string, unknown>;
    const schemaName = typeof schema.title === 'string' ? schema.title.replace(/[^A-Za-z0-9]/g, '') : '';
    if (!schemaName) continue;
    const exportStart = content.indexOf(`export const ${schemaName}Schema`);
    if (exportStart < 0) continue;
    const exportEndCandidate = content.indexOf('\n\nexport const ', exportStart + 1);
    const exportEnd = exportEndCandidate < 0 ? content.length : exportEndCandidate;
    let block = content.slice(exportStart, exportEnd);

    const rootConstraints = constraintsFor(schema);
    if (Object.keys(rootConstraints).length > 0) {
      const rootExpression = new RegExp(`^(export const ${schemaName}Schema(?:[^=]*)= )([^;\\n]+);$`, 'm');
      block = block.replace(rootExpression, (_line, prefix: string, expression: string) => {
        return `${prefix}${constrainExpression(expression, rootConstraints)};`;
      });
    }

    const occurrences = new Map<string, Map<string, CanonicalPrimitiveConstraints>>();
    const visitSchema = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const node = value as Record<string, unknown>;
      if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
        for (const [propertyName, propertySchema] of Object.entries(node.properties)) {
          if (!propertySchema || typeof propertySchema !== 'object' || Array.isArray(propertySchema)) continue;
          const constraints = constraintsFor(propertySchema as Record<string, unknown>);
          const signature = JSON.stringify(constraints);
          const bySignature = occurrences.get(propertyName) ?? new Map<string, CanonicalPrimitiveConstraints>();
          bySignature.set(signature, constraints);
          occurrences.set(propertyName, bySignature);
          visitSchema(propertySchema);
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (key !== 'properties') visitSchema(child);
      }
    };
    visitSchema(schema);

    for (const [propertyName, bySignature] of occurrences) {
      if (bySignature.size !== 1) continue;
      const constraints = bySignature.values().next().value as CanonicalPrimitiveConstraints;
      if (Object.keys(constraints).length === 0) continue;
      const escapedName = escapeRegExp(propertyName);
      const propertyLine = new RegExp(`^(\\s*)(?:${escapedName}|${JSON.stringify(propertyName)}): ([^\\n]+)$`, 'gm');
      block = block.replace(propertyLine, (line, indent: string, expression: string) => {
        return `${indent}${line.slice(indent.length, line.length - expression.length)}${constrainExpression(expression, constraints)}`;
      });
    }

    content = content.slice(0, exportStart) + block + content.slice(exportEnd);
  }
  return content;
}

/**
 * Zod's WHATWG URL validators are not equivalent to JSON Schema draft-07's
 * RFC 3986 `format: uri`. Normalize every URI projection to the same
 * ajv-formats predicate used by the SDK's authoritative Ajv validation path,
 * including one-line dereferenced schemas that property reconciliation cannot
 * address individually.
 */
function postProcessJsonSchemaUriFormats(content: string): string {
  return content
    .replaceAll('z.url()', 'z.string().refine(adcpJsonSchemaUri, "Invalid URI")')
    .replaceAll('.url()', '.refine(adcpJsonSchemaUri, "Invalid URI")');
}

function postProcessTrustedMatchResponseSchemas(content: string): string {
  const replaceSchema = (schemaName: string, _nextSchemaName: string, replacement: string): void => {
    const start = content.indexOf(`export const ${schemaName} = `);
    if (start === -1) {
      const identitySchemas = [...content.matchAll(/export const (IdentityMatch\w+Schema) = /g)].map(match => match[1]);
      throw new Error(
        `Unable to locate generated ${schemaName}. Available identity schemas: ${identitySchemas.join(', ') || 'none'}.`
      );
    }
    // Core/tool ownership changes can reorder declarations. The generated
    // schema itself still ends at the next top-level schema export; do not
    // couple this compatibility rewrite to one historical neighbor.
    const end = content.indexOf('\n\nexport const ', start + `export const ${schemaName} = `.length);
    if (end === -1) throw new Error(`Unable to locate schema boundary after ${schemaName}.`);
    content = content.slice(0, start) + replacement.trim() + content.slice(end);
  };

  replaceSchema(
    'TMPXChunkSchema',
    'IdentityMatchResponseProviderRouterSchema',
    `export const TMPXChunkSchema = z.object({
    slot_id: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    value: z.string().min(1).max(1024)
}).strict();`
  );

  replaceSchema(
    'IdentityMatchResponseProviderRouterSchema',
    'TMPProviderRegistrationSchema',
    `export const IdentityMatchResponseProviderRouterSchema = z.object({
    context_id: z.string().optional(),
    task_id: z.string().optional(),
    status: TaskStatusSchema,
    message: z.string().optional(),
    timestamp: z.string().optional(),
    replayed: z.boolean().optional(),
    adcp_error: ErrorSchema.optional(),
    push_notification_config: PushNotificationConfigSchema.optional(),
    governance_context: z.string().optional(),
    payload: z.object({}).passthrough().optional(),
    adcp_version: z.string().optional(),
    adcp_major_version: z.number().optional(),
    type: z.literal("identity_match_response"),
    request_id: z.string(),
    eligible_package_ids: z.array(z.string()),
    serve_window_sec: z.number().int().min(1).max(300),
    tmpx_chunks: z.array(TMPXChunkSchema).min(1).max(2).optional()
}).passthrough().superRefine((value, ctx) => {
    for (const field of ["tmpx_providers", "tmpx", "tmpx_values", "tmpx_macros", "context", "ext"]) {
        if (!(field in value)) continue;
        ctx.addIssue({ code: "custom", path: [field], message: field + " is forbidden on provider-to-router responses" });
    }
});`
  );

  replaceSchema(
    'TMPProviderRegistrationSchema',
    'PublisherTMPXMacroMappingSchema',
    `export const TMPProviderRegistrationSchema = z.object({
    provider_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/),
    endpoint: z.url(),
    context_match: z.boolean().optional(),
    identity_match: z.boolean().optional(),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).optional(),
    uid_types: z.array(UIDTypeSchema).min(1).optional(),
    properties: z.array(z.uuid()).min(1).optional(),
    timeout_ms: z.number().int().min(5).max(5000).optional(),
    priority: z.number().int().min(0).optional(),
    tmpx_slots: z.array(z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)).min(1).max(2).optional(),
    status: z.union([z.literal("active"), z.literal("inactive"), z.literal("draining")]).optional()
}).strict().superRefine((value, ctx) => {
    if (value.context_match !== true && value.identity_match !== true) {
        ctx.addIssue({ code: "custom", path: [], message: "at least one provider capability must be true" });
    }
    if (value.identity_match === true) {
        if (value.countries === undefined) ctx.addIssue({ code: "custom", path: ["countries"], message: "countries is required for identity_match providers" });
        if (value.uid_types === undefined) ctx.addIssue({ code: "custom", path: ["uid_types"], message: "uid_types is required for identity_match providers" });
    }
    if (value.tmpx_slots !== undefined && new Set(value.tmpx_slots).size !== value.tmpx_slots.length) {
        ctx.addIssue({ code: "custom", path: ["tmpx_slots"], message: "tmpx_slots must contain unique slot IDs" });
    }
});`
  );

  replaceSchema(
    'PublisherTMPXMacroMappingSchema',
    'GroupImageAssetSchema',
    `export const PublisherTMPXMacroMappingSchema = z.object({
    tmpx_macro_mapping: z.record(
        z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/),
        z.record(
            z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
            z.string().min(1).max(128)
        ).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 2, {
            message: "each provider mapping must contain one or two TMPX slots"
        })
    )
}).strict();`
  );

  const routerPublisherSchema = `export const IdentityMatchResponseRouterPublisherSchema = z.object({
    context_id: z.string().optional(),
    task_id: z.string().optional(),
    status: TaskStatusSchema,
    message: z.string().optional(),
    timestamp: z.string().optional(),
    replayed: z.boolean().optional(),
    adcp_error: ErrorSchema.optional(),
    push_notification_config: PushNotificationConfigSchema.optional(),
    governance_context: z.string().optional(),
    payload: z.object({}).passthrough().optional(),
    adcp_version: z.string().optional(),
    adcp_major_version: z.number().optional(),
    type: z.literal("identity_match_response"),
    request_id: z.string(),
    eligible_package_ids: z.array(z.string()),
    serve_window_sec: z.number().int().min(1).max(300),
    tmpx: z.string().optional(),
    tmpx_providers: z.record(
        z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/),
        z.object({ chunks: z.array(TMPXChunkSchema).min(1).max(2) }).strict()
    ).optional()
}).passthrough().superRefine((value, ctx) => {
    for (const field of ["tmpx_chunks", "tmpx_values", "tmpx_macros", "context", "ext"]) {
        if (!(field in value)) continue;
        ctx.addIssue({ code: "custom", path: [field], message: field + " is forbidden on router-to-publisher responses" });
    }
});`;

  // Older generated graphs only expose the deprecated alias; newer graphs
  // contain both names. Keep one canonical declaration in either case, and
  // preserve the old export as an alias without creating duplicate consts.
  if (content.includes('export const IdentityMatchResponseRouterPublisherSchema = ')) {
    replaceSchema('IdentityMatchResponseRouterPublisherSchema', 'IdentityMatchResponseSchema', routerPublisherSchema);
    replaceSchema(
      'IdentityMatchResponseSchema',
      'GetProductsResponseSchema',
      `/** @deprecated AdCP 3.1.10 renamed the publisher-facing response to distinguish it from the provider hop. */
export const IdentityMatchResponseSchema = IdentityMatchResponseRouterPublisherSchema;`
    );
  } else {
    replaceSchema('IdentityMatchResponseSchema', 'GetProductsResponseSchema', routerPublisherSchema);
  }

  return content;
}

/**
 * Replace `z.record(...).and(CONTENT)` with an object-shaped equivalent.
 *
 * TypeScript types like `{ [k: string]: unknown } & { typed_fields }` produce
 * z.record().and(z.object()) in Zod. Since z.object().passthrough() already
 * preserves unknown keys, the z.record() wrapper is redundant.
 *
 * Typed string records like `Record<string, boolean> & { typed_fields }` are not
 * redundant. Rewrite those to `z.object(...).catchall(z.boolean())` so JavaScript
 * callers keep ZodObject helpers without losing the additional-property value
 * constraint.
 *
 * Uses balanced-parenthesis scanning to handle nested schemas correctly.
 */
function unwrapRecordIntersections(content: string): string {
  const MARKER = 'z.record(';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      const recordStart = i;
      i += MARKER.length;

      // Scan balanced parens to find end of z.record(...)
      let depth = 1;
      const recordBodyStart = i;
      while (i < content.length && depth > 0) {
        if (content[i] === '"' || content[i] === "'") {
          const quote = content[i];
          i++;
          while (i < content.length && content[i] !== quote) {
            if (content[i] === '\\') i++;
            i++;
          }
          if (i < content.length) i++; // closing quote
          continue;
        }
        if (content[i] === '(') depth++;
        else if (content[i] === ')') depth--;
        i++;
      }
      const recordEnd = i;
      const recordBody = content.substring(recordBodyStart, recordEnd - 1);
      const recordArgs = splitTopLevelCommaList(recordBody);
      const keySchema = recordArgs[0] ? normalizeSchemaExpression(recordArgs[0]) : undefined;
      const valueSchema = recordArgs[1]?.trim();
      const normalizedValueSchema = valueSchema ? normalizeSchemaExpression(valueSchema) : undefined;
      const isStringKeyRecord = recordArgs.length === 2 && keySchema === 'z.string()';
      const isRedundantRecord = isStringKeyRecord && normalizedValueSchema === 'z.unknown()';
      const isTypedStringRecord = isStringKeyRecord && normalizedValueSchema !== 'z.unknown()';

      // Check if followed by .and(
      if ((isRedundantRecord || isTypedStringRecord) && content.startsWith('.and(', recordEnd)) {
        i = recordEnd + '.and('.length;

        // Scan balanced parens to extract .and() content
        depth = 1;
        let andContent = '';
        while (i < content.length && depth > 0) {
          if (content[i] === '"' || content[i] === "'") {
            const quote = content[i];
            andContent += content[i];
            i++;
            while (i < content.length && content[i] !== quote) {
              if (content[i] === '\\') {
                andContent += content[i];
                i++;
              }
              andContent += content[i];
              i++;
            }
            if (i < content.length) {
              andContent += content[i];
              i++;
            }
            continue;
          }
          if (content[i] === '(') depth++;
          else if (content[i] === ')') {
            depth--;
            if (depth === 0) {
              i++; // skip closing )
              break;
            }
          }
          andContent += content[i];
          i++;
        }

        if (isRedundantRecord) {
          // Replace z.record(z.string(), z.unknown()).and(CONTENT) with just CONTENT.
          result += andContent;
        } else if (andContent.trimStart().startsWith('z.object(')) {
          // Preserve typed additional-property validation in object-shaped form.
          result += `${andContent}.catchall(${valueSchema})`;
        } else {
          result += content.substring(recordStart, i);
        }
      } else {
        // z.record(...) not followed by .and( — keep as-is
        result += content.substring(recordStart, recordEnd);
      }
    } else {
      result += content[i];
      i++;
    }
  }

  return result;
}

function readBalancedBody(
  content: string,
  start: number,
  openChar: '[' | '(',
  closeChar: ']' | ')'
): { body: string; end: number } | undefined {
  let i = start;
  let depth = 1;
  let body = '';

  while (i < content.length && depth > 0) {
    if (content[i] === '"' || content[i] === "'") {
      const quote = content[i];
      body += content[i];
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') {
          body += content[i];
          i++;
        }
        body += content[i];
        i++;
      }
      if (i < content.length) {
        body += content[i];
        i++;
      }
      continue;
    }

    if (content[i] === openChar) depth++;
    else if (content[i] === closeChar) {
      depth--;
      if (depth === 0) {
        return { body, end: i + 1 };
      }
    }

    body += content[i];
    i++;
  }

  return undefined;
}

function splitTopLevelCommaList(content: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;

  while (i < content.length) {
    if (content[i] === '"' || content[i] === "'") {
      const quote = content[i];
      current += content[i];
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') {
          current += content[i];
          i++;
        }
        current += content[i];
        i++;
      }
      if (i < content.length) {
        current += content[i];
        i++;
      }
      continue;
    }

    if (content[i] === '(' || content[i] === '[' || content[i] === '{') depth++;
    else if (content[i] === ')' || content[i] === ']' || content[i] === '}') depth--;
    else if (content[i] === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += content[i];
    i++;
  }

  const finalPart = current.trim();
  if (finalPart) parts.push(finalPart);
  return parts;
}

function collectRedundantRecordSchemaNames(content: string): Set<string> {
  const names = new Set<string>();
  const recordSchemaPattern =
    /(?:export\s+)?const\s+(\w+)\s*=\s*z\.record\(\s*z\.string\(\),\s*z\.unknown\(\)\s*\)\s*;?/g;
  for (const match of content.matchAll(recordSchemaPattern)) {
    names.add(match[1]!);
  }
  return names;
}

function isRedundantRecordMember(
  member: string,
  recordSchemaNames: Set<string>,
  unionSchemaNames: Set<string> = new Set()
): boolean {
  const trimmed = member.trim();
  if (
    trimmed === 'z.record(z.string(), z.unknown())' ||
    recordSchemaNames.has(trimmed) ||
    unionSchemaNames.has(trimmed)
  ) {
    return true;
  }

  const unionMembers = unionArmsForExpression(trimmed);
  return (
    unionMembers !== undefined &&
    unionMembers.length > 0 &&
    unionMembers.every(nestedMember => isRedundantRecordMember(nestedMember, recordSchemaNames, unionSchemaNames))
  );
}

function collectRedundantRecordUnionSchemaNames(content: string, recordSchemaNames: Set<string>): Set<string> {
  const names = new Set<string>();
  const unionMembersByName = new Map<string, string[]>();

  for (const { name, expression } of findSchemaExportExpressions(content)) {
    const members = unionArmsForExpression(expression);
    if (members) unionMembersByName.set(name, members);
  }

  function isRedundantMember(member: string, visiting: Set<string>): boolean {
    const trimmed = member.trim();
    if (isRedundantRecordMember(trimmed, recordSchemaNames, names)) return true;

    const namedMembers = unionMembersByName.get(trimmed);
    if (namedMembers) {
      return isRedundantUnion(trimmed, namedMembers, visiting);
    }

    const inlineMembers = unionArmsForExpression(trimmed);
    return (
      inlineMembers !== undefined &&
      inlineMembers.length > 0 &&
      inlineMembers.every(nestedMember => isRedundantMember(nestedMember, visiting))
    );
  }

  function isRedundantUnion(name: string, members: string[], visiting: Set<string>): boolean {
    if (names.has(name)) return true;
    if (visiting.has(name)) return false;

    visiting.add(name);
    const result = members.length > 0 && members.every(member => isRedundantMember(member, visiting));
    visiting.delete(name);

    if (result) names.add(name);
    return result;
  }

  for (const [name, members] of unionMembersByName) {
    isRedundantUnion(name, members, new Set());
  }

  return names;
}

/**
 * Replace `z.union([RecordUnknownA, RecordUnknownB]).and(CONTENT)` with CONTENT,
 * but only when CONTENT begins with `z.object(`. Non-object right-hand sides are
 * preserved byte-for-byte so richer constraints survive.
 *
 * Some schema variants are intentionally opaque because TypeScript represents
 * sibling-field constraints as `Record<string, unknown>` marker arms. Intersecting
 * a union of those arms with the real object shape only removes ZodObject methods;
 * the later `.passthrough()` object already accepts the same unknown keys.
 */
function unwrapRecordUnionIntersections(content: string): string {
  const MARKER = 'z.union([';
  const recordSchemaNames = collectRedundantRecordSchemaNames(content);
  const unionSchemaNames = collectRedundantRecordUnionSchemaNames(content, recordSchemaNames);
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      const unionStart = i;
      const unionBodyStart = i + MARKER.length;
      const unionBody = readBalancedBody(content, unionBodyStart, '[', ']');

      if (!unionBody || content[unionBody.end] !== ')') {
        result += content[i];
        i++;
        continue;
      }

      const unionEnd = unionBody.end + 1;
      const members = splitTopLevelCommaList(unionBody.body);
      const isRedundantUnion =
        members.length > 0 &&
        members.every(member => isRedundantRecordMember(member, recordSchemaNames, unionSchemaNames));

      if (isRedundantUnion && content.startsWith('.and(', unionEnd)) {
        const andBodyStart = unionEnd + '.and('.length;
        const andBody = readBalancedBody(content, andBodyStart, '(', ')');
        if (andBody && andBody.body.trimStart().startsWith('z.object(')) {
          result += andBody.body;
          i = andBody.end;
          continue;
        }
      }

      result += content.substring(unionStart, unionEnd);
      i = unionEnd;
    } else {
      result += content[i];
      i++;
    }
  }

  return result;
}

/**
 * Replace `NamedRecordUnion.and(z.object({...}))` with just the object side,
 * but only when the right-hand side begins with `z.object(`. Non-object right-hand
 * sides are preserved byte-for-byte so richer constraints survive.
 *
 * This is the named-schema counterpart to `unwrapRecordUnionIntersections`.
 * It intentionally applies only during the marker-only era, where the named
 * union is composed exclusively of `Record<string, unknown>` marker arms. If a
 * future spec version adds real fields to those variants, they will no longer
 * be collected here and the generated schema will correctly remain a
 * ZodIntersection until the richer constraints are modeled another way.
 */
function unwrapNamedRecordUnionIntersections(content: string): string {
  const recordSchemaNames = collectRedundantRecordSchemaNames(content);
  const unionSchemaNames = collectRedundantRecordUnionSchemaNames(content, recordSchemaNames);
  let result = '';
  let i = 0;

  while (i < content.length) {
    let matchedName: string | undefined;
    for (const name of unionSchemaNames) {
      if (!content.startsWith(`${name}.and(`, i)) continue;
      // Left identifier boundary: don't match `FooSizeModeMutexSchema` as `SizeModeMutexSchema`.
      if (i > 0 && /[A-Za-z0-9_$]/.test(content[i - 1])) continue;
      matchedName = name;
      break;
    }

    if (!matchedName) {
      result += content[i];
      i++;
      continue;
    }

    const andBodyStart = i + `${matchedName}.and(`.length;
    const andBody = readBalancedBody(content, andBodyStart, '(', ')');
    if (!andBody) {
      // A collected union name followed by `.and(` with no balanced body means
      // the ts-to-zod output is malformed. Crash rather than silently corrupt.
      throw new Error(
        `unwrapNamedRecordUnionIntersections: unbalanced \`.and(\` at offset ${andBodyStart} for ${matchedName}`
      );
    }
    if (andBody.body.trimStart().startsWith('z.object(')) {
      result += andBody.body;
      i = andBody.end;
      continue;
    }

    // Right-hand side isn't a plain `z.object(...)` — preserve the original
    // intersection byte-for-byte so any non-marker constraints survive.
    result += content.substring(i, andBody.end);
    i = andBody.end;
  }

  return result;
}

/**
 * Strip `.and(z.union([...]))` where the union body contains z.never().
 *
 * TypeScript discriminated unions like:
 *   { base_fields } & ({ buying_mode: 'brief'; refine?: never } | ...)
 * produce .and(z.union([z.object({ buying_mode: ..., refine: z.never() })])) in Zod.
 *
 * These constraints are useful for runtime validation but break .shape access.
 * The base z.object() already contains all fields with correct types; the union
 * only adds conditional field presence rules better communicated in tool descriptions.
 */
function stripNeverUnionIntersections(content: string): string {
  const MARKER = '.and(z.union([';
  let result = '';
  let i = 0;

  while (i < content.length) {
    if (content.startsWith(MARKER, i)) {
      const andStart = i;
      i += '.and('.length; // position at z.union([

      // Scan balanced parens to find end of .and(...)
      let depth = 1;
      let andContent = '';
      while (i < content.length && depth > 0) {
        if (content[i] === '"' || content[i] === "'") {
          const quote = content[i];
          andContent += content[i];
          i++;
          while (i < content.length && content[i] !== quote) {
            if (content[i] === '\\') {
              andContent += content[i];
              i++;
            }
            andContent += content[i];
            i++;
          }
          if (i < content.length) {
            andContent += content[i];
            i++;
          }
          continue;
        }
        if (content[i] === '(') depth++;
        else if (content[i] === ')') {
          depth--;
          if (depth === 0) {
            i++; // skip closing )
            break;
          }
        }
        andContent += content[i];
        i++;
      }

      // Only strip if the union contains z.never() (discriminated constraints)
      if (andContent.includes('z.never()')) {
        // Strip entire .and(z.union([...]))
      } else {
        // Keep it — not a discriminated union constraint
        result += content.substring(andStart, i);
      }
    } else {
      result += content[i];
      i++;
    }
  }

  return result;
}

type ObjectShape = Map<string, string>;

function normalizeSchemaExpression(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function skipQuotedOrRegexLiteral(content: string, start: number): number | undefined {
  const ch = content[start];
  if (ch === '"' || ch === "'" || ch === '`') {
    const quote = ch;
    let i = start + 1;
    while (i < content.length) {
      if (content[i] === '\\') {
        i += 2;
        continue;
      }
      if (content[i] === quote) return i + 1;
      i++;
    }
    return content.length;
  }

  if (ch !== '/') return undefined;

  let previous = start - 1;
  while (previous >= 0 && /\s/.test(content[previous])) previous--;
  if (previous >= 0 && !'([{,:='.includes(content[previous])) return undefined;

  let i = start + 1;
  let inCharacterClass = false;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === '[') inCharacterClass = true;
    else if (content[i] === ']') inCharacterClass = false;
    else if (content[i] === '/' && !inCharacterClass) {
      i++;
      while (i < content.length && /[a-z]/i.test(content[i])) i++;
      return i;
    }
    i++;
  }

  return undefined;
}

function scanBalanced(
  content: string,
  start: number,
  openChar: '(' | '{' | '[' = '(',
  closeChar: ')' | '}' | ']' = ')'
): { body: string; end: number } | undefined {
  if (content[start] !== openChar) return undefined;

  let depth = 1;
  let i = start + 1;
  let body = '';

  while (i < content.length && depth > 0) {
    const ch = content[i];
    const literalEnd = skipQuotedOrRegexLiteral(content, i);
    if (literalEnd !== undefined) {
      body += content.slice(i, literalEnd);
      i = literalEnd;
      continue;
    }

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }

    if (depth > 0) body += ch;
    i++;
  }

  return depth === 0 ? { body, end: i } : undefined;
}

function extractObjectLiteralBody(zObjectExpression: string): string | undefined {
  const trimmed = zObjectExpression.trim();
  if (!trimmed.startsWith('z.object(')) return undefined;

  const call = scanBalanced(trimmed, 'z.object'.length);
  if (!call) return undefined;

  if (!isPlainZodObjectTail(trimmed.slice(call.end))) return undefined;

  const arg = call.body.trim();
  if (!arg.startsWith('{')) return undefined;

  const objectLiteral = scanBalanced(arg, 0, '{', '}');
  return objectLiteral?.body;
}

// Watch: ts-to-zod emits .catchall(z.unknown()) on some schemas; add it here if the generator ever produces it.
function isPlainZodObjectTail(tail: string): boolean {
  let remaining = tail.trim();
  const objectPreservingMethods = ['.passthrough()', '.strict()', '.strip()'];

  while (remaining) {
    const method = objectPreservingMethods.find(value => remaining.startsWith(value));
    if (!method) return false;
    remaining = remaining.slice(method.length).trim();
  }

  return true;
}

function readPropertyKey(part: string): string | undefined {
  const trimmed = part.trim();
  if (!trimmed) return undefined;

  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0];
    let i = 1;
    let key = '';
    while (i < trimmed.length) {
      if (trimmed[i] === '\\') {
        key += trimmed[i];
        i++;
        if (i < trimmed.length) key += trimmed[i];
        i++;
        continue;
      }
      if (trimmed[i] === quote) break;
      key += trimmed[i];
      i++;
    }
    return key;
  }

  const match = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$-]*)\s*:/);
  return match?.[1];
}

function parseObjectShape(body: string): ObjectShape | undefined {
  const shape: ObjectShape = new Map();
  let depth = 0;
  let partStart = 0;

  const readPart = (end: number) => {
    const part = body.slice(partStart, end);
    const key = readPropertyKey(part);
    if (!key) return;

    let colonIndex = -1;
    let localDepth = 0;
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      const literalEnd = skipQuotedOrRegexLiteral(part, i);
      if (literalEnd !== undefined) {
        i = literalEnd - 1;
        continue;
      }
      if (ch === '(' || ch === '{' || ch === '[') localDepth++;
      else if (ch === ')' || ch === '}' || ch === ']') localDepth--;
      else if (ch === ':' && localDepth === 0) {
        colonIndex = i;
        break;
      }
    }

    if (colonIndex >= 0) {
      shape.set(key, normalizeSchemaExpression(part.slice(colonIndex + 1)));
    }
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const literalEnd = skipQuotedOrRegexLiteral(body, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      readPart(i);
      partStart = i + 1;
    }
  }

  readPart(body.length);
  return shape;
}

function mergeShapes(left: ObjectShape, right: ObjectShape): ObjectShape {
  const merged = new Map(left);
  for (const [key, value] of right) {
    merged.set(key, value);
  }
  return merged;
}

function canSafelyMerge(left: ObjectShape, right: ObjectShape): boolean {
  for (const [key, rightValue] of right) {
    const leftValue = left.get(key);
    if (
      leftValue !== undefined &&
      leftValue !== rightValue &&
      leftValue !== `${rightValue}.optional()` &&
      leftValue !== `${rightValue}.nullish()`
    ) {
      return false;
    }
  }
  return true;
}

type SchemaExportExpression = {
  name: string;
  expression: string;
  expressionStart: number;
  expressionEnd: number;
};

function skipWhitespace(content: string, start: number): number {
  let i = start;
  while (i < content.length && /\s/.test(content[i])) i++;
  return i;
}

function findSchemaAssignmentStart(content: string, start: number): number | undefined {
  let i = skipWhitespace(content, start);

  if (content[i] === ':') {
    i++;
    let depth = 0;
    let angleDepth = 0;

    while (i < content.length) {
      const ch = content[i];
      const literalEnd = skipQuotedOrRegexLiteral(content, i);
      if (literalEnd !== undefined) {
        i = literalEnd;
        continue;
      }

      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === '<') angleDepth++;
      else if (ch === '>' && angleDepth > 0) angleDepth--;
      else if (ch === '=' && content[i + 1] === '>') i++;
      else if (ch === '=' && depth === 0 && angleDepth === 0) return skipWhitespace(content, i + 1);

      i++;
    }

    return undefined;
  }

  if (content[i] !== '=') return undefined;
  return skipWhitespace(content, i + 1);
}

function findExpressionEnd(content: string, expressionStart: number): number | undefined {
  let depth = 0;
  let i = expressionStart;

  while (i < content.length) {
    const ch = content[i];
    const literalEnd = skipQuotedOrRegexLiteral(content, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
    } else if (ch === ';' && depth === 0) {
      return i;
    }
    i++;
  }

  return undefined;
}

function findSchemaExportExpressions(content: string): SchemaExportExpression[] {
  const exports: SchemaExportExpression[] = [];
  const exportRegex = /export\s+const\s+(\w+Schema)\b/g;
  let match: RegExpExecArray | null;

  while ((match = exportRegex.exec(content))) {
    const name = match[1]!;
    const expressionStart = findSchemaAssignmentStart(content, exportRegex.lastIndex);
    if (expressionStart === undefined) continue;

    const expressionEnd = findExpressionEnd(content, expressionStart);
    if (expressionEnd === undefined) continue;

    exports.push({
      name,
      expression: content.slice(expressionStart, expressionEnd),
      expressionStart,
      expressionEnd,
    });

    exportRegex.lastIndex = expressionEnd + 1;
  }

  return exports;
}

function extractSchemaExports(content: string): Map<string, string> {
  const schemas = new Map<string, string>();
  for (const { name, expression } of findSchemaExportExpressions(content)) {
    schemas.set(name, expression);
  }

  return schemas;
}

function schemaShapeForExpression(
  expression: string,
  schemaExpressions: Map<string, string>,
  cache: Map<string, ObjectShape | undefined>,
  visiting = new Set<string>()
): ObjectShape | undefined {
  const trimmed = expression.trim();

  const inlineBody = extractObjectLiteralBody(trimmed);
  if (inlineBody !== undefined) {
    return parseObjectShape(inlineBody);
  }

  const named = trimmed.match(/^(\w+Schema)$/)?.[1];
  if (named) {
    if (cache.has(named)) return cache.get(named);
    if (visiting.has(named)) return undefined;

    const namedExpression = schemaExpressions.get(named);
    if (!namedExpression) return undefined;

    visiting.add(named);
    const shape = schemaShapeForExpression(namedExpression, schemaExpressions, cache, visiting);
    visiting.delete(named);
    cache.set(named, shape);
    return shape;
  }

  return undefined;
}

function splitTopLevelList(body: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let partStart = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const literalEnd = skipQuotedOrRegexLiteral(body, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      const part = body.slice(partStart, i).trim();
      if (!part) return undefined;
      parts.push(part);
      partStart = i + 1;
    }
  }

  const last = body.slice(partStart).trim();
  if (!last) return undefined;
  parts.push(last);
  return parts;
}

function unionArmsForExpression(expression: string): string[] | undefined {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('z.union(')) return undefined;

  const call = scanBalanced(trimmed, 'z.union'.length);
  if (!call || trimmed.slice(call.end).trim()) return undefined;

  const arg = call.body.trim();
  if (!arg.startsWith('[')) return undefined;

  const array = scanBalanced(arg, 0, '[', ']');
  if (!array || arg.slice(array.end).trim()) return undefined;

  return splitTopLevelList(array.body);
}

function isOpaqueRecordMarkerExpression(
  expression: string,
  schemaExpressions: Map<string, string>,
  cache: Map<string, boolean>,
  visiting = new Set<string>()
): boolean {
  const trimmed = normalizeSchemaExpression(expression);
  if (trimmed === 'z.record(z.string(), z.unknown())' || trimmed === 'z.object({}).passthrough()') return true;

  const arms = unionArmsForExpression(trimmed);
  if (arms) {
    return (
      arms.length > 0 && arms.every(arm => isOpaqueRecordMarkerExpression(arm, schemaExpressions, cache, visiting))
    );
  }

  const named = trimmed.match(/^(\w+Schema)$/)?.[1];
  if (!named) return false;
  if (cache.has(named)) return cache.get(named) ?? false;
  if (visiting.has(named)) return false;

  const namedExpression = schemaExpressions.get(named);
  if (!namedExpression) return false;

  visiting.add(named);
  const result = isOpaqueRecordMarkerExpression(namedExpression, schemaExpressions, cache, visiting);
  visiting.delete(named);
  cache.set(named, result);
  return result;
}

function isOpaqueMarkerUnion(
  expression: string,
  schemaExpressions: Map<string, string>,
  markerCache: Map<string, boolean>,
  visiting = new Set<string>()
): boolean {
  const trimmed = normalizeSchemaExpression(expression);
  const named = trimmed.match(/^(\w+Schema)$/)?.[1];
  if (named) {
    if (visiting.has(named)) return false;
    const namedExpression = schemaExpressions.get(named);
    if (!namedExpression) return false;

    visiting.add(named);
    const result = isOpaqueMarkerUnion(namedExpression, schemaExpressions, markerCache, visiting);
    visiting.delete(named);
    return result;
  }

  const arms = unionArmsForExpression(trimmed);
  return (
    arms !== undefined &&
    arms.length > 0 &&
    arms.every(arm => isOpaqueRecordMarkerExpression(arm, schemaExpressions, markerCache))
  );
}

function rewriteLeadingMarkerUnionObjectAnd(
  expression: string,
  schemaExpressions: Map<string, string>,
  shapeCache: Map<string, ObjectShape | undefined>,
  markerCache: Map<string, boolean>
): string {
  let depth = 0;

  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    const literalEnd = skipQuotedOrRegexLiteral(expression, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (depth === 0 && expression.startsWith('.and(', i)) {
      const base = expression.slice(0, i);
      const arg = scanBalanced(expression, i + '.and'.length);
      if (!arg) return expression;

      if (
        isOpaqueRecordMarkerExpression(base, schemaExpressions, markerCache) &&
        isOpaqueMarkerUnion(arg.body, schemaExpressions, markerCache)
      ) {
        const remainder = expression.slice(arg.end);
        if (remainder.startsWith('.and(')) {
          const objectArg = scanBalanced(remainder, '.and'.length);
          const objectShape = objectArg
            ? schemaShapeForExpression(objectArg.body, schemaExpressions, shapeCache)
            : undefined;
          if (objectArg && objectShape) return objectArg.body + remainder.slice(objectArg.end);
        }
      }

      if (isOpaqueMarkerUnion(base, schemaExpressions, markerCache)) {
        const argShape = schemaShapeForExpression(arg.body, schemaExpressions, shapeCache);
        if (argShape) return arg.body + expression.slice(arg.end);
      }

      return expression;
    }
  }

  return expression;
}

function postProcessMarkerUnionObjectIntersections(content: string): string {
  const schemaExpressions = extractSchemaExports(content);
  const shapeCache = new Map<string, ObjectShape | undefined>();
  const markerCache = new Map<string, boolean>();
  let result = '';
  let lastIndex = 0;

  for (const { name, expressionStart, expressionEnd } of findSchemaExportExpressions(content)) {
    const expression = schemaExpressions.get(name);
    if (!expression) continue;

    const rewritten = rewriteLeadingMarkerUnionObjectAnd(expression, schemaExpressions, shapeCache, markerCache);

    result += content.slice(lastIndex, expressionStart) + rewritten;
    lastIndex = expressionEnd;
  }

  result += content.slice(lastIndex);
  return result;
}

function topLevelAndOperands(expression: string): string[] | undefined {
  let depth = 0;
  let firstAnd = -1;
  for (let i = 0; i < expression.length; i++) {
    const literalEnd = skipQuotedOrRegexLiteral(expression, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
      continue;
    }
    const ch = expression[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (depth === 0 && expression.startsWith('.and(', i)) {
      firstAnd = i;
      break;
    }
  }
  if (firstAnd < 0) return [expression.trim()];

  const operands = [expression.slice(0, firstAnd).trim()];
  let cursor = firstAnd;
  while (cursor < expression.length) {
    cursor = skipWhitespace(expression, cursor);
    if (!expression.startsWith('.and(', cursor)) return undefined;
    const argument = scanBalanced(expression, cursor + '.and'.length);
    if (!argument) return undefined;
    operands.push(argument.body.trim());
    cursor = argument.end;
  }
  return operands;
}

/**
 * Collapse repeated Product format/placement intersection operands introduced
 * when json-schema-to-typescript follows the same dereferenced allOf layers
 * through compatibility aliases. Re-validating an identical pure object or
 * union adds no semantics, but zod-openapi expands every copy recursively.
 */
function postProcessRepeatedProductIntersections(content: string): string {
  let result = content;

  for (const schemaName of ['ProductFormatDeclarationSchema', 'PlacementSchema']) {
    const target = findSchemaExportExpressions(result).find(entry => entry.name === schemaName);
    if (!target) throw new Error(`postProcessRepeatedProductIntersections: ${schemaName} export not found.`);
    const operands = topLevelAndOperands(target.expression);
    if (!operands) throw new Error(`postProcessRepeatedProductIntersections: could not parse ${schemaName}.`);

    const seen = new Set<string>();
    const unique = operands.filter(operand => {
      const exact = operand.trim();
      if (seen.has(exact)) return false;
      seen.add(exact);
      return true;
    });

    if (schemaName === 'ProductFormatDeclarationSchema' && unique.length === 3 && unique.length < operands.length) {
      const exactOperands = operands.map(operand => operand.trim());
      const [commonA, formatUnion, commonB] = unique;
      const expected = [commonA, formatUnion, commonB, formatUnion, commonB, formatUnion, commonB, formatUnion];
      if (
        exactOperands.length !== expected.length ||
        exactOperands.some((operand, index) => operand !== expected[index]) ||
        !commonA?.endsWith(`.merge(${commonB})`)
      ) {
        const classes: string[] = [];
        const classByOperand = new Map<string, string>();
        for (const operand of exactOperands) {
          const label = classByOperand.get(operand) ?? String.fromCharCode(65 + classByOperand.size);
          classByOperand.set(operand, label);
          classes.push(label);
        }
        throw new Error(
          `postProcessRepeatedProductIntersections: ProductFormatDeclaration no longer matches the verified repeated allOf projection (${classes.join('')}).`
        );
      }
      unique.pop();
    }

    if (unique.length === operands.length) continue;
    const rewritten = unique.slice(1).reduce((chain, operand) => `${chain}.and(${operand})`, unique[0]!);
    result = result.slice(0, target.expressionStart) + rewritten + result.slice(target.expressionEnd);
  }

  return result;
}

function postProcessObjectIntersections(content: string): string {
  const schemaExpressions = extractSchemaExports(content);
  const shapeCache = new Map<string, ObjectShape | undefined>();
  let result = '';
  let lastIndex = 0;

  for (const { name, expressionStart, expressionEnd } of findSchemaExportExpressions(content)) {
    const expression = schemaExpressions.get(name);
    if (!expression) continue;

    const rewritten = rewriteTopLevelObjectAnds(expression, schemaExpressions, shapeCache);

    result += content.slice(lastIndex, expressionStart) + rewritten;
    lastIndex = expressionEnd;
  }

  result += content.slice(lastIndex);

  let rewritten = result;
  while (true) {
    const next = rewriteNamedObjectAnds(rewritten);
    if (next === rewritten) return rewritten;
    rewritten = next;
  }
}

/**
 * Keep the beta.6 image-format motion narrowing object-shaped.
 *
 * The source type intersects a narrow image-only motion_level with the shared
 * canonical-format object, whose motion_level enum is broader. A normal Zod
 * merge would let the broader property overwrite the narrowing, while `.and()`
 * loses the public ZodObject composition helpers. Remove the broad property
 * before merging the narrow object so runtime validation and object helpers are
 * both preserved.
 */
function postProcessCanonicalImageMotionNarrowing(content: string): string {
  const target = findSchemaExportExpressions(content).find(entry => entry.name === 'CanonicalFormatImageSchema');
  if (!target) throw new Error('postProcessCanonicalImageMotionNarrowing: schema export not found.');
  const expression = content.slice(target.expressionStart, target.expressionEnd);
  let depth = 0;

  for (let i = 0; i < expression.length; i++) {
    const literalEnd = skipQuotedOrRegexLiteral(expression, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
      continue;
    }
    const ch = expression[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (depth === 0 && expression.startsWith('.and(', i)) {
      const broad = scanBalanced(expression, i + '.and'.length);
      if (!broad || expression.slice(broad.end).trim()) break;
      const narrow = expression.slice(0, i);
      const rewritten = `${broad.body}.omit({ motion_level: true }).merge(${narrow})`;
      return content.slice(0, target.expressionStart) + rewritten + content.slice(target.expressionEnd);
    }
  }

  throw new Error('postProcessCanonicalImageMotionNarrowing: expected a top-level object intersection.');
}

/** Restore beta.6 reporting constraints that the general compatibility loosening intentionally drops. */
function postProcessBeta6ReportingConstraints(content: string): string {
  let result = content;

  const requestedMetrics = 'requested_metrics: z.array(AvailableMetricSchema).optional(),';
  if (!result.includes(requestedMetrics)) {
    throw new Error('postProcessBeta6ReportingConstraints: requested_metrics projection not found.');
  }
  result = result.replace(
    requestedMetrics,
    `requested_metrics: z.array(AvailableMetricSchema).min(1).refine(
        values => new Set(values).size === values.length,
        { message: "requested_metrics must contain unique metrics" }
    ).optional(),`
  );

  const delivery = findSchemaExportExpressions(result).find(entry => entry.name === 'DeliveryMetricsSchema');
  if (!delivery) throw new Error('postProcessBeta6ReportingConstraints: DeliveryMetricsSchema not found.');
  const deliveryExpression = result.slice(delivery.expressionStart, delivery.expressionEnd);
  const threshold = 'threshold_seconds: z.number(),';
  if (!deliveryExpression.includes(threshold)) {
    throw new Error('postProcessBeta6ReportingConstraints: time-based view threshold not found.');
  }
  result =
    result.slice(0, delivery.expressionStart) +
    deliveryExpression.replace(threshold, 'threshold_seconds: z.number().gt(0),') +
    result.slice(delivery.expressionEnd);

  const qualifier = findSchemaExportExpressions(result).find(entry => entry.name === 'CanonicalMetricQualifierSchema');
  if (!qualifier) throw new Error('postProcessBeta6ReportingConstraints: CanonicalMetricQualifierSchema not found.');
  const qualifierExpression = result.slice(qualifier.expressionStart, qualifier.expressionEnd);
  if (!qualifierExpression.endsWith('.passthrough()')) {
    throw new Error('postProcessBeta6ReportingConstraints: qualifier is no longer a passthrough object.');
  }
  result =
    result.slice(0, qualifier.expressionStart) +
    qualifierExpression.replace(/\.passthrough\(\)$/, '.strict()') +
    result.slice(qualifier.expressionEnd);

  const canonicalQualifierBody = `z.object({
        viewability_standard: ViewabilityStandardSchema.optional(),
        completion_source: CompletionSourceSchema.optional(),
        attribution_methodology: AttributionMethodologySchema.optional(),
        attribution_window: DurationSchema.optional(),
        lift_dimension: LiftDimensionSchema.optional()
    }).passthrough()`;
  const qualifierEnd = findSchemaExportExpressions(result).find(
    entry => entry.name === 'CanonicalMetricQualifierSchema'
  )!.expressionEnd;
  const tail = result.slice(qualifierEnd).replaceAll(canonicalQualifierBody, 'CanonicalMetricQualifierSchema');
  result = result.slice(0, qualifierEnd) + tail;

  const vendorMetric = findSchemaExportExpressions(result).find(entry => entry.name === 'VendorMetricValueSchema');
  if (
    !vendorMetric ||
    !result
      .slice(vendorMetric.expressionStart, vendorMetric.expressionEnd)
      .includes('qualifier: CanonicalMetricQualifierSchema.optional()')
  ) {
    throw new Error('postProcessBeta6ReportingConstraints: VendorMetricValue qualifier was not canonicalized.');
  }

  const deliveryAggregate = findSchemaExportExpressions(result).find(
    entry => entry.name === 'DeliveryMetricAggregateSchema'
  );
  if (!deliveryAggregate) {
    throw new Error('postProcessBeta6ReportingConstraints: DeliveryMetricAggregateSchema not found.');
  }
  let aggregateExpression = result.slice(deliveryAggregate.expressionStart, deliveryAggregate.expressionEnd);
  const inlineQualifier = `z.object({
            viewability_standard: ViewabilityStandardSchema.optional(),
            completion_source: CompletionSourceSchema.optional(),
            attribution_methodology: AttributionMethodologySchema.optional(),
            attribution_window: DurationSchema.optional(),
            lift_dimension: LiftDimensionSchema.optional()
        }).passthrough()`;
  const inlineQualifierCount = aggregateExpression.split(inlineQualifier).length - 1;
  if (inlineQualifierCount !== 2) {
    throw new Error(
      `postProcessBeta6ReportingConstraints: expected two aggregate qualifier projections, found ${inlineQualifierCount}.`
    );
  }
  aggregateExpression = aggregateExpression.replaceAll(inlineQualifier, 'CanonicalMetricQualifierSchema');
  aggregateExpression += `.superRefine((row, ctx) => {
    if (row.scope !== "standard") return;
    const requiredComponents: Record<string, string[]> = {
        viewable_rate: ["measurable_impressions", "viewable_impressions"],
        completion_rate: ["impressions", "completed_views"],
        cost_per_acquisition: ["spend", "conversions"],
        roas: ["spend", "conversion_value"]
    };
    for (const field of requiredComponents[row.metric_id] ?? []) {
        if ((row as unknown as Record<string, unknown>)[field] === undefined) {
            ctx.addIssue({ code: "custom", path: [field], message: \`\${field} is required for \${row.metric_id}\` });
        }
    }
})`;
  result =
    result.slice(0, deliveryAggregate.expressionStart) +
    aggregateExpression +
    result.slice(deliveryAggregate.expressionEnd);

  return result;
}

/** Keep compact product format options aligned with the beta.6 canonical-kind vocabulary. */
function postProcessBeta6CanonicalFormatOptionKinds(content: string): string {
  const target = findSchemaExportExpressions(content).find(entry => entry.name === 'CanonicalFormatOptionSchema');
  if (!target) throw new Error('postProcessBeta6CanonicalFormatOptionKinds: schema export not found.');
  let expression = content.slice(target.expressionStart, target.expressionEnd);
  if (expression.includes('z.literal("seller_rendered_stateful_display")')) return content;

  const finalOldKind = 'z.literal("agent_placement"), z.literal("custom")';
  const occurrences = expression.split(finalOldKind).length - 1;
  if (occurrences < 1) {
    throw new Error('postProcessBeta6CanonicalFormatOptionKinds: canonical format-kind union not found.');
  }
  expression = expression.replaceAll(
    finalOldKind,
    'z.literal("agent_placement"), z.literal("seller_rendered_stateful_display"), z.literal("coordinated_placements"), z.literal("custom")'
  );
  return content.slice(0, target.expressionStart) + expression + content.slice(target.expressionEnd);
}

function postProcessObjectUnionIntersections(content: string): string {
  const schemaExpressions = extractSchemaExports(content);
  const shapeCache = new Map<string, ObjectShape | undefined>();
  let result = '';
  let lastIndex = 0;

  for (const { name, expressionStart, expressionEnd } of findSchemaExportExpressions(content)) {
    const expression = schemaExpressions.get(name);
    if (!expression) continue;

    const rewritten = name.endsWith('RequestSchema')
      ? rewriteObjectUnionIntersection(expression, schemaExpressions, shapeCache)
      : expression;

    result += content.slice(lastIndex, expressionStart) + rewritten;
    lastIndex = expressionEnd;
  }

  result += content.slice(lastIndex);
  return result;
}

function rewriteObjectUnionIntersection(
  expression: string,
  schemaExpressions: Map<string, string>,
  shapeCache: Map<string, ObjectShape | undefined>
): string {
  let depth = 0;

  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    const literalEnd = skipQuotedOrRegexLiteral(expression, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (depth === 0 && expression.startsWith('.and(', i)) {
      const base = expression.slice(0, i);
      const arg = scanBalanced(expression, i + '.and'.length);
      if (!arg) return expression;

      const trailing = expression.slice(arg.end).trim();
      if (trailing) return expression;

      const baseShape = schemaShapeForExpression(base, schemaExpressions, shapeCache);
      const arms = unionArmsForExpression(arg.body);
      if (!baseShape || !arms?.length) return expression;

      const mergedArms: string[] = [];
      for (const arm of arms) {
        const armShape = schemaShapeForExpression(arm, schemaExpressions, shapeCache);
        if (!armShape || !canSafelyMerge(baseShape, armShape)) return expression;
        mergedArms.push(`${base}.merge(${arm})`);
      }

      return `z.union([${mergedArms.join(', ')}])`;
    }
  }

  return expression;
}

function rewriteTopLevelObjectAnds(
  expression: string,
  schemaExpressions: Map<string, string>,
  shapeCache: Map<string, ObjectShape | undefined>
): string {
  let result = '';
  let depth = 0;
  let i = 0;
  let currentShape: ObjectShape | undefined;
  let baseStart = 0;

  while (i < expression.length) {
    const ch = expression[i];
    const literalEnd = skipQuotedOrRegexLiteral(expression, i);
    if (literalEnd !== undefined) {
      i = literalEnd - 1;
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
    } else if (depth === 0 && expression.startsWith('.and(', i)) {
      if (!result) {
        const base = expression.slice(baseStart, i);
        result = base;
        currentShape = schemaShapeForExpression(base, schemaExpressions, shapeCache);
      }

      const arg = scanBalanced(expression, i + '.and'.length);
      if (!arg) break;

      const argShape = schemaShapeForExpression(arg.body, schemaExpressions, shapeCache);
      if (currentShape && argShape && canSafelyMerge(currentShape, argShape)) {
        result += `.merge(${arg.body})`;
        currentShape = mergeShapes(currentShape, argShape);
      } else {
        result += `.and(${arg.body})`;
        currentShape = undefined;
      }
      i = arg.end;
      baseStart = i;
      continue;
    }
    i++;
  }

  if (!result) return expression;
  result += expression.slice(baseStart);
  return result;
}

function rewriteNamedObjectAnds(content: string): string {
  const schemaExpressions = extractSchemaExports(content);
  const shapeCache = new Map<string, ObjectShape | undefined>();
  const namedAndRegex = /\b(\w+Schema)\.and\(/g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = namedAndRegex.exec(content))) {
    const schemaName = match[1];
    const openIndex = match.index + `${schemaName}.and`.length;
    const arg = scanBalanced(content, openIndex);
    if (!arg) continue;

    const leftShape = schemaShapeForExpression(schemaName, schemaExpressions, shapeCache);
    const rightShape = schemaShapeForExpression(arg.body, schemaExpressions, shapeCache);

    result += content.slice(lastIndex, match.index);
    if (leftShape && rightShape && canSafelyMerge(leftShape, rightShape)) {
      result += `${schemaName}.merge(${arg.body})`;
    } else {
      result += content.slice(match.index, arg.end);
    }

    lastIndex = arg.end;
    namedAndRegex.lastIndex = arg.end;
  }

  result += content.slice(lastIndex);
  return result;
}

// Write file only if content differs (excluding timestamp)
function writeFileIfChanged(filePath: string, newContent: string): boolean {
  const contentWithoutTimestamp = (content: string) => {
    return content.replace(/\/\/ Generated at: .*?\n/, '// Generated at: [TIMESTAMP]\n');
  };

  let hasChanged = true;
  if (existsSync(filePath)) {
    const existingContent = readFileSync(filePath, 'utf8');
    const existingWithoutTimestamp = contentWithoutTimestamp(existingContent);
    const newWithoutTimestamp = contentWithoutTimestamp(newContent);

    if (existingWithoutTimestamp === newWithoutTimestamp) {
      hasChanged = false;
    }
  }

  if (hasChanged) {
    writeFileSync(filePath, newContent);
  }

  return hasChanged;
}

const BACKWARD_COMPAT_SCHEMA_ALIASES: Array<{
  oldName: string;
  newName: string;
  reason: string;
}> = [
  ...Array.from({ length: 12 }, (_, index) => ({
    oldName: `BrandReference${index + 1}`,
    newName: 'BrandReference',
    reason: 'SDK 14 beta exported this numbered codegen compatibility alias.',
  })),
  ...(
    [
      ['BusinessEntity1', 'BusinessEntity'],
      ['MeasurementTerms1', 'MeasurementTerms'],
      ['None1', 'None'],
      ['None2', 'None'],
      ['PlatformExtensionReference1', 'PlatformExtensionReference'],
      ['Product1', 'Product'],
      ['Property1', 'Property'],
    ] as const
  ).map(([oldName, newName]) => ({
    oldName,
    newName,
    reason: 'SDK 14 beta exported this numbered codegen compatibility alias.',
  })),
  {
    oldName: 'SignalCatalogType',
    newName: 'SignalAvailabilityType',
    reason: 'AdCP 3.1 renamed SignalCatalogType to SignalAvailabilityType.',
  },
  {
    oldName: 'IdentityMatchResponse',
    newName: 'IdentityMatchResponseRouterPublisher',
    reason: 'AdCP 3.1.10 renamed the publisher-facing response to distinguish it from the provider hop.',
  },
  {
    oldName: 'ContextMatchResponse',
    newName: 'ContextMatchResponseRouterPublisher',
    reason: 'AdCP 3.2 names the publisher-facing context-match response by hop.',
  },
  {
    oldName: 'OutcomeMeasurementDeprecated',
    newName: 'OutcomeMeasurement',
    reason: 'SDK 13 exported the 3.1 compatibility name.',
  },
  ...['CreateMediaBuy', 'UpdateMediaBuy', 'SyncCatalogs', 'BuildCreative', 'SyncCreatives'].map(baseName => ({
    oldName: `${baseName}AsyncSubmitted`,
    newName: `${baseName}Submitted`,
    reason: 'AdCP 3.2 shortened submitted response type names.',
  })),
];

function addBackwardCompatSchemaAliases(content: string): string {
  let output = content;
  for (const { oldName, newName, reason } of BACKWARD_COMPAT_SCHEMA_ALIASES) {
    const oldSchema = `${oldName}Schema`;
    const newSchema = `${newName}Schema`;
    if (new RegExp(`^export const ${oldSchema}\\b`, 'm').test(output)) continue;
    const declarationStart = output.search(new RegExp(`^export const ${newSchema} =`, 'm'));
    if (declarationStart === -1) continue;
    const declarationEnd = output.indexOf('\n\nexport const ', declarationStart);
    if (declarationEnd === -1) continue;
    const alias = `/** @deprecated ${reason} */\nexport const ${oldSchema} = ${newSchema};\n`;
    output = `${output.slice(0, declarationEnd)}\n\n${alias}${output.slice(declarationEnd + 2)}`;
  }
  return output;
}

function postProcessPostalAreaSupportCatchall(content: string): string {
  return content.replace(
    /(export const PostalAreaSupportSchema = z\.object\(\{[\s\S]*?\}\)\.passthrough\(\)\.catchall\()[\s\S]*?(\);\n\nexport const \w+Schema)/m,
    `$1z.array(z.union([z.literal("postal_code"), z.literal("custom")]))).superRefine((value, ctx) => {
    const legacyPostalSystems = new Set([
        "us_zip",
        "us_zip_plus_four",
        "gb_outward",
        "gb_full",
        "ca_fsa",
        "ca_full",
        "de_plz",
        "fr_code_postal",
        "au_postcode",
        "ch_plz",
        "at_plz"
    ]);
    for (const key of Object.keys(value)) {
        if (/^[A-Z]{2}$/.test(key) || legacyPostalSystems.has(key)) continue;
        ctx.addIssue({
            code: "custom",
            path: [key],
            message: "PostalAreaSupport keys must be ISO 3166-1 alpha-2 country codes or deprecated legacy postal-system aliases"
        });
    }
}$2`
  );
}

async function generateZodSchemas() {
  console.log('🔄 Generating Zod v4 schemas from TypeScript types...');
  console.log(`📥 Core source: ${CORE_SOURCE_FILE}`);
  console.log(`📥 Tools source: ${TOOLS_SOURCE_FILE}`);
  console.log(`📤 Output: ${OUTPUT_FILE}`);

  if (!existsSync(CORE_SOURCE_FILE)) {
    console.error(`❌ Core source file not found: ${CORE_SOURCE_FILE}`);
    console.error('   Please run "npm run generate-types" first.');
    process.exit(1);
  }

  if (!existsSync(TOOLS_SOURCE_FILE)) {
    console.error(`❌ Tools source file not found: ${TOOLS_SOURCE_FILE}`);
    console.error('   Please run "npm run generate-types" first.');
    process.exit(1);
  }

  try {
    // Read the TypeScript sources
    const coreContent = readFileSync(CORE_SOURCE_FILE, 'utf8');
    const toolsContent = readFileSync(TOOLS_SOURCE_FILE, 'utf8');

    // tools.generated.ts imports a handful of *AssetRequirements types from
    // core.generated.ts (injected by scripts/generate-types.ts so the standalone
    // file typechecks) and may re-export core-owned compatibility aliases. Since
    // we concatenate both sources for ts-to-zod, those cross-file statements are
    // redundant — worse, ts-to-zod treats imported names as external and emits
    // `z.any()` stubs even when the actual interfaces are present in the combined
    // source. Strip cross-file imports/re-exports before merging.
    const toolsWithoutCrossImports = toolsContent.replace(
      /^(?:import type|export type) \{[^}]*\} from ['"]\.\/core\.generated['"]; ?\n+/gm,
      ''
    );
    // Defensive: if the injector in scripts/generate-types.ts ever changes shape
    // (different specifier, single-line form, etc.), the strip would silently
    // no-op and we'd regress back to z.any() stubs. Fail loudly instead.
    if (toolsWithoutCrossImports.includes("from './core.generated'")) {
      throw new Error(
        "generate-zod-from-ts: cross-file `import type { ... } from './core.generated'` " +
          'survived the strip. Update the regex in this file or the injector in ' +
          'scripts/generate-types.ts — letting it through degrades the matching schemas to z.any().'
      );
    }

    // Merge both sources so cross-file type dependencies can be resolved
    const combinedSource = relaxArrayCardinalityTypes(
      `${coreContent}\n\n// ====== TOOL TYPES ======\n\n${toolsWithoutCrossImports}`
    );

    console.log('📦 Generating Zod schemas for all types...');

    // Generate schemas for ALL types - no filter needed
    // This ensures all dependencies are available and avoids missing schema bugs
    const result = generate({
      sourceText: combinedSource,
      skipParseJSDoc: false,
      getSchemaName: name => `${name}Schema`,
    });

    // Check for generation errors and log warnings
    // Note: Some complex discriminated unions may fail Zod generation but still have valid TypeScript types
    // This is acceptable - TypeScript provides compile-time validation, Zod provides runtime validation
    if (result.errors.length > 0) {
      console.warn('⚠️  Some schemas could not be generated (this is non-fatal):');
      result.errors.forEach(error => console.warn(`   ${error}`));
      console.warn('\n💡 These schemas use complex discriminated unions not supported by ts-to-zod.');
      console.warn('   TypeScript types are still enforced at compile-time.');
      console.warn('   Runtime validation will fall back to TypeScript type checking.\n');
    }

    // Get the generated Zod schemas
    let zodSchemas = result.getZodSchemasFile();

    // Post-process: Convert .optional() to .nullish() for PackageSchema fields
    // This is needed because real-world API responses (e.g., Yahoo webhook) send explicit
    // null values for optional fields, but ts-to-zod generates .optional() which only
    // accepts undefined, not null. Using .nullish() accepts both undefined and null.
    // Note: we intentionally keep .optional() (NOT .nullish()) so Zod schemas match
    // TypeScript types. Callers that need to accept null from external APIs should use
    // .nullish() at the call site, not globally in every schema.

    // Post-process: Fix broken imports from "undefined" (recursive types with z.lazy())
    zodSchemas = postProcessUndefinedImports(zodSchemas);

    // Some nested array constraints lose their JSDoc provenance in the
    // JSON-Schema-to-TypeScript projection. Normalize the remaining exact
    // homogeneous tuple/rest representation without touching fixed tuples.
    zodSchemas = postProcessTupleRestArrays(zodSchemas);

    // Post-process: Replace z.union([z.unknown(), z.undefined()]) with z.unknown().
    // ts-to-zod generates the union for Record<string, unknown> types, but z.undefined()
    // has no JSON Schema representation, breaking MCP SDK's toJSONSchema() conversion.
    zodSchemas = postProcessUndefinedUnions(zodSchemas);

    // Post-process: Drop unsupported `.max()`/`.min()`/`.length()` calls on
    // z.record() emitted from object property-count JSDoc.
    zodSchemas = postProcessRecordSizeConstraints(zodSchemas);

    // Post-process: Strip .and(z.record(z.string(), z.unknown())) from object schemas.
    // These intersections come from TypeScript index signatures and are redundant with
    // .passthrough(). They also create ZodIntersection types that lose .shape access.
    // Must run after postProcessUndefinedUnions (which normalizes the record value type).
    zodSchemas = postProcessRecordIntersections(zodSchemas);
    zodSchemas = postProcessPrimitiveIntersections(zodSchemas);

    // Post-process: Add .passthrough() to all z.object() schemas so unknown keys are preserved.
    // Agents may return extra/platform-specific fields not in the schema. Without passthrough,
    // Zod strips those fields, causing data loss for consumers who need them.
    zodSchemas = postProcessForPassthrough(zodSchemas);

    // Preserve arbitrary JSON transformer values after ts-to-zod narrows
    // nested `unknown` properties to open objects.
    zodSchemas = postProcessTransformerParamJsonValues(zodSchemas);

    // String-only JSON Schema constraints on object|string unions must stay
    // attached to the string arm; applying them to z.union() crashes Zod.
    // Run after passthrough normalization so the object arm has its final form.
    zodSchemas = postProcessUnionStringLengthConstraints(zodSchemas);
    zodSchemas = postProcessForecastRangeConstraint(zodSchemas);
    zodSchemas = postProcessPriceBreakdownConstraints(zodSchemas);
    zodSchemas = postProcessBeta4OfferAndOutcomeConstraints(zodSchemas);
    zodSchemas = postProcessCanonicalSharedConstraints(zodSchemas);
    zodSchemas = postProcessSignalTargetingExpressionConstraints(zodSchemas);
    zodSchemas = postProcessPreviewCreativeRequestConstraints(zodSchemas);

    // Placement presentation is a closed, non-executable document boundary.
    // Restore strictness, integer/cardinality rules, and canvas geometry lost
    // in the TypeScript projection, plus adjacent asset-size constraints.
    zodSchemas = postProcessPlacementPresentationRuntimeConstraints(zodSchemas);

    // Trusted Match request schemas are closed privacy-boundary contracts.
    // Unlike ordinary AdCP tool payloads, accepting unknown root/nested fields
    // can mix context and identity signals across separated paths.
    zodSchemas = postProcessTrustedMatchPrivacyBoundaryStrictness(zodSchemas);

    // Trusted Match 3.1.10 splits provider→router and router→publisher
    // responses. Preserve the source JSON Schema's hop exclusions, cardinality,
    // property-name constraints, and provider-registration conditionals.
    zodSchemas = postProcessTrustedMatchResponseSchemas(zodSchemas);

    // Post-process: Collapse marker-only union/object intersections.
    // ProductSchema currently intersects opaque V1/V2 marker records with its real object shape.
    // While those marker schemas are just z.record(z.string(), z.unknown()), the union adds no
    // validation beyond passthrough object semantics and only removes .extend/.omit/.pick helpers.
    // When the marker schemas gain real fields, this pass stops firing and preserves the richer
    // intersection for maintainers to handle deliberately.
    zodSchemas = postProcessMarkerUnionObjectIntersections(zodSchemas);
    zodSchemas = postProcessCanonicalFormatMarkerIntersections(zodSchemas);
    zodSchemas = postProcessCanonicalFormatSlots(zodSchemas);
    zodSchemas = postProcessCreativeBriefRequiredDisclosures(zodSchemas);
    zodSchemas = postProcessPostalAreaValues(zodSchemas);
    zodSchemas = postProcessCompatibilityPurchaseCoordinatorInput(zodSchemas);
    zodSchemas = postProcessLegacyPurchaseContinuationResponse(zodSchemas);
    const refineResponseSource = JSON.parse(
      readFileSync(
        path.join(__dirname, '../schemas/cache/latest/bundled/media-buy/refine-proposals-response.json'),
        'utf8'
      )
    );
    const dereferencedRefineResponse = (await $RefParser.dereference(refineResponseSource)) as any;
    const canonicalProposalSource = dereferencedRefineResponse?.properties?.results?.items?.properties?.proposal;
    if (!canonicalProposalSource) {
      throw new Error('Unable to locate the bundled canonical proposal used by refine_proposals.');
    }
    // `discriminator` is an optimization hint, not a validation constraint.
    // json-schema-to-zod otherwise emits z.discriminatedUnion for arms that
    // also contain allOf intersections, which Zod 4 correctly refuses to type
    // as discriminable. Plain unions retain identical acceptance semantics.
    const seenCanonicalNodes = new WeakSet<object>();
    const removeDiscriminatorHints = (value: unknown): void => {
      if (!value || typeof value !== 'object' || seenCanonicalNodes.has(value)) return;
      seenCanonicalNodes.add(value);
      Object.values(value).forEach(removeDiscriminatorHints);
      if (Array.isArray(value)) return;
      const node = value as Record<string, any>;
      delete node.discriminator;
      if (node.properties && node.type === undefined) node.type = 'object';
      // json-schema-to-zod does not project draft-07 if/then/else. Rewrite
      // the logically equivalent boolean schema using the supported
      // anyOf/allOf/not vocabulary before conversion:
      //   (if AND then) OR (NOT if AND else)
      if (node.if !== undefined && node.then !== undefined) {
        const conditional =
          node.else === undefined
            ? { anyOf: [{ not: node.if }, { allOf: [node.if, node.then] }] }
            : {
                anyOf: [{ allOf: [node.if, node.then] }, { allOf: [{ not: node.if }, node.else] }],
              };
        node.allOf = [...(Array.isArray(node.allOf) ? node.allOf : []), conditional];
        delete node.if;
        delete node.then;
        delete node.else;
      }
      if (node.dependencies && typeof node.dependencies === 'object') {
        const dependencyGuards = Object.entries(node.dependencies).map(([property, dependency]) => ({
          anyOf: [
            { not: { required: [property] } },
            Array.isArray(dependency)
              ? { required: [property, ...dependency] }
              : { allOf: [{ required: [property] }, dependency] },
          ],
        }));
        node.allOf = [...(Array.isArray(node.allOf) ? node.allOf : []), ...dependencyGuards];
        delete node.dependencies;
      }
      if (node.contains !== undefined) {
        if (node.minContains !== undefined || node.maxContains !== undefined) {
          throw new Error('Canonical proposal contains minContains/maxContains; extend the Zod normalization.');
        }
        // Draft-07 `contains` means at least one item matches. Its boolean
        // equivalent uses only vocabulary supported by json-schema-to-zod:
        // NOT(array whose every item does NOT match contains).
        node.allOf = [
          ...(Array.isArray(node.allOf) ? node.allOf : []),
          { not: { type: 'array', items: { not: node.contains } } },
        ];
        delete node.contains;
      }
    };
    removeDiscriminatorHints(canonicalProposalSource);
    const canonicalRootConstraints = canonicalProposalSource.allOf;
    delete canonicalProposalSource.allOf;
    const converterOptions: { parserOverride: (schema: any) => string | void } = {
      parserOverride: (schema: any): string | void => {
        if (schema.type === 'string' && schema.format === 'date-time') {
          return 'z.string().refine(adcpJsonSchemaDateTime, "Invalid date-time")';
        }
        if (Number.isInteger(schema.minProperties) && schema.minProperties >= 0) {
          const minimum = schema.minProperties;
          const schemaWithoutMinimum = { ...schema };
          delete schemaWithoutMinimum.minProperties;
          const underlying = jsonSchemaToZod(schemaWithoutMinimum, converterOptions);
          return `${underlying}.refine((value) => Object.keys(value).length >= ${minimum}, "Object must contain at least ${minimum} propert${minimum === 1 ? 'y' : 'ies'}")`;
        }
        if (!schema.properties && Array.isArray(schema.required) && schema.required.length > 0) {
          // Keep this presence-only guard constant-time with respect to the
          // supplied value. Recursive validators such as `z.json()` can
          // overflow on deeply nested untrusted payloads, while `z.unknown()`
          // alone treats a missing key as valid on the supported Zod floor.
          const fields = schema.required
            .map(field => `${JSON.stringify(field)}: z.any().refine((value) => value !== undefined, "Required")`)
            .join(', ');
          return `z.object({ ${fields} }).passthrough()`;
        }
      },
    };
    const canonicalProposalObject = jsonSchemaToZod(canonicalProposalSource, converterOptions);
    const canonicalProposalConstraints = jsonSchemaToZod(
      { allOf: Array.isArray(canonicalRootConstraints) ? canonicalRootConstraints : [] },
      converterOptions
    );
    const exactCanonicalProposal = `(() => {
      const objectSchema = ${canonicalProposalObject};
      const exactSchema = objectSchema.superRefine((value, ctx) => {
      const checked = ${canonicalProposalConstraints}.safeParse(value);
      if (!checked.success) {
        for (const issue of checked.error.issues) {
          ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
        }
      }
      });
      return Object.assign(exactSchema, {
        pick: objectSchema.pick.bind(objectSchema),
        omit: objectSchema.omit.bind(objectSchema),
        extend: objectSchema.extend.bind(objectSchema),
      });
    })()`;
    zodSchemas = postProcessCanonicalProposalRuntimeConstraints(zodSchemas, exactCanonicalProposal);

    // TypeScript cannot retain JSON Schema `format: uri` or root oneOf
    // exclusivity. Restore both for legacy/canonical creative identity. This
    // runs after replacing CanonicalProposalSchema because generated export
    // ordering can place CreativeManifestSchema immediately after it.
    zodSchemas = postProcessCreativeRuntimeConstraints(zodSchemas);

    // These promoted beta.6 canonical formats contain nested required-only
    // unions, conditionals, and `contains` constraints that TypeScript cannot
    // faithfully carry through ts-to-zod. Project their dereferenced wire
    // schemas directly so public Zod validation fails closed.
    for (const [schemaName, schemaFile] of [
      ['CanonicalFormatSellerRenderedStatefulDisplaySchema', 'seller_rendered_stateful_display.json'],
      ['CanonicalFormatCoordinatedPlacementsSchema', 'coordinated_placements.json'],
    ] as const) {
      const source = JSON.parse(
        readFileSync(path.join(__dirname, '../schemas/cache/latest/formats/canonical', schemaFile), 'utf8')
      );
      const dereferenced = (await $RefParser.dereference(source)) as any;
      removeDiscriminatorHints(dereferenced);
      // Both promoted formats extend exactly one plain object base. Flatten
      // that structural allOf before Zod projection so the public export stays
      // a real ZodObject (and therefore keeps shape/pick/omit/extend) while
      // local property overrides replace their base declarations cleanly.
      const baseSchemas = Array.isArray(dereferenced.allOf) ? dereferenced.allOf : [];
      if (
        baseSchemas.length !== 1 ||
        baseSchemas[0]?.type !== 'object' ||
        typeof baseSchemas[0]?.properties !== 'object'
      ) {
        throw new Error(`${schemaFile}: expected one dereferenced object base in allOf.`);
      }
      const baseSchema = baseSchemas[0] as Record<string, any>;
      const localProperties = dereferenced.properties as Record<string, unknown>;
      dereferenced.type = 'object';
      dereferenced.properties = { ...baseSchema.properties };
      for (const [propertyName, localProperty] of Object.entries(localProperties ?? {})) {
        const baseProperty = baseSchema.properties[propertyName];
        dereferenced.properties[propertyName] =
          baseProperty && typeof baseProperty === 'object' && localProperty && typeof localProperty === 'object'
            ? { ...baseProperty, ...(localProperty as Record<string, unknown>) }
            : localProperty;
      }
      dereferenced.required = [...new Set([...(baseSchema.required ?? []), ...(dereferenced.required ?? [])])];
      delete dereferenced.allOf;
      // Defaults in overlapping allOf branches can produce different parsed
      // values for the same key, which Zod intersections cannot merge. Wire
      // validation should not mutate caller input, so discard annotation-only
      // defaults before projecting the authoritative constraints.
      const seenDefaults = new WeakSet<object>();
      const removeDefaults = (value: unknown): void => {
        if (!value || typeof value !== 'object' || seenDefaults.has(value)) return;
        seenDefaults.add(value);
        if (!Array.isArray(value)) delete (value as Record<string, unknown>).default;
        Object.values(value).forEach(removeDefaults);
      };
      removeDefaults(dereferenced);
      let exact = jsonSchemaToZod(dereferenced, converterOptions).replaceAll('.strict()', '.passthrough()');
      if (schemaName === 'CanonicalFormatSellerRenderedStatefulDisplaySchema') {
        exact = refineGeneratedObjectProperty(
          exact,
          'breakpoints',
          `(breakpoints, ctx) => {
            breakpoints.forEach((breakpoint, index) => {
              const widthKeys = ["width", "width_range", "width_mode"].filter(key => breakpoint[key] !== undefined);
              const heightKeys = ["height", "height_range", "viewport_height_percent"].filter(key => breakpoint[key] !== undefined);
              if (widthKeys.length !== 1) ctx.addIssue({ code: "custom", path: [index], message: "breakpoint requires exactly one width mode" });
              if (heightKeys.length !== 1) ctx.addIssue({ code: "custom", path: [index], message: "breakpoint requires exactly one height mode" });
            });
          }`
        );
        exact = refineGeneratedObjectProperty(
          exact,
          'transitions',
          `(transitions, ctx) => {
            if (transitions === undefined) return;
            const rules: Record<string, { required: string[]; forbidden: string[]; modes: string[] }> = {
              timer: { required: ["delay_ms"], forbidden: ["input", "media_event", "scroll_reference", "scroll_threshold_percent", "scroll_start_percent", "scroll_end_percent"], modes: ["instant", "animated"] },
              in_view_timer: { required: ["delay_ms"], forbidden: ["input", "media_event", "scroll_reference", "scroll_threshold_percent", "scroll_start_percent", "scroll_end_percent"], modes: ["instant", "animated"] },
              scroll_threshold: { required: ["input", "scroll_reference", "scroll_threshold_percent"], forbidden: ["delay_ms", "media_event", "scroll_start_percent", "scroll_end_percent"], modes: ["instant", "animated"] },
              scroll_progress: { required: ["input", "scroll_reference", "scroll_start_percent", "scroll_end_percent"], forbidden: ["delay_ms", "media_event", "scroll_threshold_percent", "direction"], modes: ["scroll_linked"] },
              user_action: { required: ["input"], forbidden: ["delay_ms", "media_event", "scroll_reference", "scroll_threshold_percent", "scroll_start_percent", "scroll_end_percent", "direction"], modes: ["instant", "animated"] },
              media_event: { required: ["media_event"], forbidden: ["input", "delay_ms", "scroll_reference", "scroll_threshold_percent", "scroll_start_percent", "scroll_end_percent", "direction"], modes: ["instant", "animated"] }
            };
            transitions.forEach((transition, index) => {
              const rule = rules[transition.trigger];
              if (!rule) return;
              rule.required.forEach((key: string) => {
                if (transition[key] === undefined) ctx.addIssue({ code: "custom", path: [index, key], message: "transition field is required for this trigger" });
              });
              rule.forbidden.forEach((key: string) => {
                if (transition[key] !== undefined) ctx.addIssue({ code: "custom", path: [index, key], message: "transition field is forbidden for this trigger" });
              });
              if (!rule.modes.includes(transition.transition_mode)) ctx.addIssue({ code: "custom", path: [index, "transition_mode"], message: "invalid transition_mode for this trigger" });
              if ((transition.trigger === "scroll_threshold" || transition.trigger === "scroll_progress") && transition.input !== "scroll") {
                ctx.addIssue({ code: "custom", path: [index, "input"], message: "scroll transitions require input=scroll" });
              }
            });
          }`
        );
        exact = refineGeneratedObjectProperty(
          exact,
          'duration_ms_range',
          `(range, ctx) => {
            if (range !== undefined && !range.some(value => value !== null)) {
              ctx.addIssue({ code: "custom", path: [], message: "duration_ms_range requires at least one finite bound" });
            }
          }`
        );
      }
      if (schemaName === 'CanonicalFormatCoordinatedPlacementsSchema') {
        exact = refineGeneratedObjectProperty(
          exact,
          'components',
          `(components, ctx) => {
            if (!components.some(component => component.required === true)) {
              ctx.addIssue({ code: "custom", path: [], message: "At least one component must be required" });
            }
            components.forEach((component, index) => {
              const referenced = component.format_option_ref !== undefined;
              const hasKind = component.format_kind !== undefined;
              const hasParams = component.params !== undefined;
              if (referenced === (hasKind || hasParams) || (!referenced && (!hasKind || !hasParams))) {
                ctx.addIssue({ code: "custom", path: [index], message: "Each component must select exactly one referenced or inline format" });
                return;
              }
              if (!referenced) {
                const formatKind = component.format_kind;
                if (typeof formatKind !== "string") {
                  ctx.addIssue({ code: "custom", path: [index, "format_kind"], message: "Unsupported coordinated placement format_kind" });
                  return;
                }
                const paramsSchema = CoordinatedPlacementInlineParamsRuntimeSchemas[
                  formatKind as keyof typeof CoordinatedPlacementInlineParamsRuntimeSchemas
                ];
                if (!paramsSchema) {
                  ctx.addIssue({ code: "custom", path: [index, "format_kind"], message: "Unsupported coordinated placement format_kind" });
                } else if (!paramsSchema.safeParse(component.params).success) {
                  ctx.addIssue({ code: "custom", path: [index, "params"], message: "params do not match format_kind" });
                }
              }
            });
          }`
        );
      }
      zodSchemas = postProcessExactSchema(zodSchemas, schemaName, exact);
      if (schemaName === 'CanonicalFormatCoordinatedPlacementsSchema') {
        const exportMarker = `export const ${schemaName}`;
        const exportStart = zodSchemas.indexOf(exportMarker);
        if (exportStart < 0) throw new Error(`${schemaFile}: unable to locate coordinated schema export.`);
        const inlineParamsSchemas = `const CoordinatedPlacementInlineParamsRuntimeSchemas: Record<string, z.ZodType> = {
    image: CanonicalFormatImageSchema,
    html5: CanonicalFormatHTML5BannerSchema,
    display_tag: CanonicalFormatDisplayTagSchema,
    image_carousel: CanonicalFormatImageCarouselSchema,
    video_hosted: CanonicalFormatHostedVideoSchema,
    video_vast: CanonicalFormatVASTVideoSchema,
    audio_hosted: CanonicalFormatHostedAudioSchema,
    audio_daast: CanonicalFormatDAASTAudioSchema,
    sponsored_placement: CanonicalFormatSponsoredPlacementRetailMediaCatalogDrivenSchema,
    native_in_feed: CanonicalFormatNativeInFeedSchema,
    responsive_creative: CanonicalFormatResponsiveCreativeSchema,
    agent_placement: CanonicalFormatAgentPlacementAISurfaceSponsoredPlacementSchema,
    seller_rendered_stateful_display: CanonicalFormatSellerRenderedStatefulDisplaySchema
};

`;
        zodSchemas = zodSchemas.slice(0, exportStart) + inlineParamsSchemas + zodSchemas.slice(exportStart);
      }
    }
    zodSchemas = postProcessRefineProposalsRuntimeConstraints(zodSchemas);

    // Post-process: Distribute object-envelope intersections over union object arms.
    // A schema like `Envelope.and(z.union([VariantA, VariantB]))` is equivalent to
    // `z.union([Envelope.merge(VariantA), Envelope.merge(VariantB)])` when the
    // envelope and every arm are merge-safe ZodObjects. The distributed form
    // preserves discriminated-union inference for custom tool handlers.
    zodSchemas = postProcessObjectUnionIntersections(zodSchemas);

    // Post-process: Turn safe object/object intersections into ZodObject merges.
    // ts-to-zod emits `.and()` for TypeScript object intersections, but ZodIntersection
    // does not expose object helpers like .shape/.extend/.omit/.pick. This keeps the
    // intersected object validation when fields are disjoint or identical, and leaves
    // richer/conflicting intersections alone so future schema changes do not weaken checks.
    zodSchemas = postProcessObjectIntersections(zodSchemas);

    // Preserve the image format's beta.6 motion-level refinement without
    // regressing its public ZodObject composition surface.
    zodSchemas = postProcessCanonicalImageMotionNarrowing(zodSchemas);

    // Preserve the non-empty/unique requested metric set, positive view
    // threshold, and closed canonical qualifier from the beta.6 wire schema.
    zodSchemas = postProcessBeta6ReportingConstraints(zodSchemas);

    // The beta.6 compact option source missed the two promoted canonical
    // kinds even though the shared canonical-kind vocabulary includes them.
    zodSchemas = postProcessBeta6CanonicalFormatOptionKinds(zodSchemas);

    // Keep the create-media-buy request's public schema object-shaped while
    // enforcing its lifecycle-mode union as a refinement.
    zodSchemas = postProcessCreateMediaBuyRequestObject(zodSchemas);

    // Post-process: Replace z.union([z.unknown(), z.undefined()]) with z.unknown().
    // ts-to-zod generates this union for TypeScript's Record<string, unknown>, but
    // z.undefined() cannot be converted to JSON Schema (it has no representation).
    // z.unknown() already accepts undefined at runtime, so this is semantically identical.
    // Without this fix, 73+ schemas fail MCP SDK's tools/list JSON Schema conversion.
    zodSchemas = postProcessUndefinedUnions(zodSchemas);

    // Restore the schema's country-key catchall after ts-to-zod widens the
    // template-literal index signature during conversion.
    zodSchemas = postProcessPostalAreaSupportCatchall(zodSchemas);

    // Reconcile canonical primitive constraints last, after structural and
    // exact-schema rewrites that may replace earlier generated blocks.
    zodSchemas = postProcessCanonicalPrimitiveConstraints(zodSchemas);
    zodSchemas = postProcessJsonSchemaUriFormats(zodSchemas);

    // Compatibility aliases can make jsts emit repeated format/placement
    // intersections. Collapse them before annotation so adopter OpenAPI
    // generators see each validation block once.
    zodSchemas = postProcessRepeatedProductIntersections(zodSchemas);

    // Post-process: Add explicit z.ZodType annotations to schemas that trip TS7056.
    zodSchemas = postProcessTS7056Annotations(zodSchemas);

    // Defensive: ts-to-zod emits `const FooSchema = z.any();` stubs when it
    // can't resolve a referenced type — usually because a cross-file `import
    // type` declaration leaks past the upstream strip (see #1659). A `z.any()`
    // stub silently accepts any shape at runtime and erases the per-type Zod
    // contract downstream consumers rely on. Fail the build so the regression
    // surfaces here, not in a consumer's test suite.
    const anyStubs = [...zodSchemas.matchAll(/^const (\w+Schema) = z\.any\(\);$/gm)].map(m => m[1]);
    if (anyStubs.length > 0) {
      throw new Error(
        `generate-zod-from-ts: ${anyStubs.length} schema(s) degenerated to z.any() stubs:\n` +
          anyStubs.map(n => `  - ${n}`).join('\n') +
          '\nThis usually means a cross-file `import type` declaration leaked past the strip ' +
          'in this script. Check that the referenced TypeScript interfaces are inlined in ' +
          'the combined source, and update the strip regex if a new cross-file import was added.'
      );
    }

    // Create header with metadata
    const header = `// Generated Zod v4 schemas from TypeScript types\n// Generated at: ${new Date().toISOString()}\n// Sources:\n//   - ${path.basename(CORE_SOURCE_FILE)} (core types)\n//   - ${path.basename(TOOLS_SOURCE_FILE)} (tool types)\n//\n// These schemas provide runtime validation for AdCP data structures\n// Generated using ts-to-zod from TypeScript type definitions\n\n`;

    const finalContent = header + addBackwardCompatSchemaAliases(zodSchemas);

    // Write the output
    const changed = writeFileIfChanged(OUTPUT_FILE, finalContent);

    if (changed) {
      console.log(`✅ Generated Zod schemas: ${OUTPUT_FILE}`);
    } else {
      console.log(`✅ Zod schemas are up to date: ${OUTPUT_FILE}`);
    }

    // Count schemas from output (each 'export const' is a schema)
    const schemaCount = (zodSchemas.match(/export const/g) || []).length;
    console.log(`📊 Generated ${schemaCount} Zod v4 schemas`);
    console.log('✨ Done!');
  } catch (error) {
    console.error('❌ Failed to generate Zod schemas:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  generateZodSchemas().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

export const __test__ = {
  postProcessTupleRestArrays,
  relaxArrayCardinalityTypes,
  postProcessForNullish,
  postProcessRecordIntersections,
  postProcessMarkerUnionObjectIntersections,
  postProcessRepeatedProductIntersections,
  postProcessCanonicalFormatSlots,
  postProcessCreativeBriefRequiredDisclosures,
  postProcessObjectUnionIntersections,
  postProcessObjectIntersections,
  postProcessRecordSizeConstraints,
};

export { generateZodSchemas };
