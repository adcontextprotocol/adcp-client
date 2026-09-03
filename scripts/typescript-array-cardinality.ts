import ts from 'typescript';

const comparisonPrinter = ts.createPrinter({ removeComments: true });
const replacementPrinter = ts.createPrinter();

function canonicalTypeText(node: ts.TypeNode, sourceFile: ts.SourceFile): string {
  let semanticNode = node;
  while (ts.isParenthesizedTypeNode(semanticNode)) semanticNode = semanticNode.type;
  return comparisonPrinter.printNode(ts.EmitHint.Unspecified, semanticNode, sourceFile);
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
    const members = type.types.map(member => relaxCardinalityTypeNode(member, sourceFile, context, visit));
    return members.some((member, index) => member !== type.types[index])
      ? ts.factory.updateUnionTypeNode(type, ts.factory.createNodeArray(members))
      : type;
  }
  if (ts.isIntersectionTypeNode(type)) {
    const members = type.types.map(member => relaxCardinalityTypeNode(member, sourceFile, context, visit));
    return members.some((member, index) => member !== type.types[index])
      ? ts.factory.updateIntersectionTypeNode(type, ts.factory.createNodeArray(members))
      : type;
  }
  if (ts.isTypeReferenceNode(type)) {
    if (ts.isIdentifier(type.typeName) && ['Array', 'ReadonlyArray'].includes(type.typeName.text)) return type;
    const typeArguments = type.typeArguments?.map(argument =>
      relaxCardinalityTypeNode(argument, sourceFile, context, visit)
    );
    if (!typeArguments?.some((argument, index) => argument !== type.typeArguments![index])) return type;
    return ts.factory.updateTypeReferenceNode(type, type.typeName, ts.factory.createNodeArray(typeArguments));
  }
  return type;
}

/**
 * Replace non-exact JSON Schema array cardinality types with ordinary arrays.
 *
 * json-schema-to-typescript represents maxItems as a union containing every
 * permitted tuple length. That rejects dynamically assembled arrays and grows
 * declarations substantially. JSDoc provenance limits this rewrite to schema
 * cardinality artifacts; authored structural tuples and exact min=max tuples
 * remain intact. Runtime validators retain the original bounds.
 */
export function relaxArrayCardinalityTypes(source: string, options: { maxItemsOnly?: boolean } = {}): string {
  const sourceFile = ts.createSourceFile(
    'adcp-generated-types.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const relaxedTypeRoots: ts.TypeNode[] = [];

  const collect = (node: ts.Node): void => {
    const tags = ts.getJSDocTags(node);
    const minTag = tags.find(tag => tag.tagName.text === 'minItems');
    const maxTag = tags.find(tag => tag.tagName.text === 'maxItems');
    if (maxTag || (!options.maxItemsOnly && minTag)) {
      const min = minTag ? Number(String(minTag.comment ?? '').trim()) : undefined;
      const max = maxTag ? Number(String(maxTag.comment ?? '').trim()) : undefined;
      const exactTuple = min !== undefined && max !== undefined && min === max;
      const typedNode = node as ts.Node & { type?: ts.TypeNode };
      if (!exactTuple && typedNode.type) {
        relaxedTypeRoots.push(typedNode.type);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const candidates = relaxedTypeRoots
    .map(type => {
      const directElement = cardinalityArrayElementType(type, sourceFile);
      if (directElement) {
        const elementText = source.slice(directElement.getStart(sourceFile), directElement.end);
        const needsParentheses =
          ts.isUnionTypeNode(directElement) ||
          ts.isIntersectionTypeNode(directElement) ||
          ts.isFunctionTypeNode(directElement) ||
          ts.isConstructorTypeNode(directElement) ||
          ts.isConditionalTypeNode(directElement) ||
          ts.isTypeOperatorNode(directElement);
        return {
          start: type.getStart(sourceFile),
          end: type.end,
          text: `${needsParentheses ? `(${elementText})` : elementText}[]`,
        };
      }

      const transformed = ts.transform(type, [
        context => root => {
          const visit: ts.Visitor = node => {
            if (ts.isTypeNode(node)) {
              return relaxCardinalityTypeNode(node, sourceFile, context, visit);
            }
            return ts.visitEachChild(node, visit, context);
          };
          return relaxCardinalityTypeNode(root, sourceFile, context, visit);
        },
      ]);
      try {
        const transformedType = transformed.transformed[0]!;
        if (transformedType === type) return undefined;
        return {
          start: type.getStart(sourceFile),
          end: type.end,
          text: replacementPrinter.printNode(ts.EmitHint.Unspecified, transformedType, sourceFile),
        };
      } finally {
        transformed.dispose();
      }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    // If nested declarations both carry cardinality tags, keep the outermost
    // replacement so edits never overlap.
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const nonOverlapping: typeof candidates = [];
  for (const candidate of candidates) {
    if (nonOverlapping.some(other => candidate.start >= other.start && candidate.end <= other.end)) continue;
    nonOverlapping.push(candidate);
  }
  const replacements = nonOverlapping.sort((left, right) => right.start - left.start);

  return replacements.reduce(
    (result, replacement) => result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end),
    source
  );
}
