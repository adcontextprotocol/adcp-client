/**
 * Closed, side-effect-free grammar for storyboard phase `skip_if` guards.
 *
 * Supported forms are deliberately small: runtime references rooted at
 * `context` or `test_kit`, truthiness/negation, `==` / `!=`, boolean and
 * quoted string literals, and logical OR. Anything else is an authoring
 * error rather than an expression that silently falls through to "run".
 */

export type PhaseConditionScope = {
  context?: Record<string, unknown>;
  test_kit?: unknown;
};

type ReferenceNode = { kind: 'reference'; root: 'context' | 'test_kit'; path: string[] };
type LiteralNode = { kind: 'literal'; value: boolean | string };
type UnaryNode = { kind: 'not'; operand: PhaseConditionNode };
type EqualityNode = {
  kind: 'equality';
  operator: '==' | '!=';
  left: ValueNode | UnaryNode;
  right: ValueNode | UnaryNode;
};
type OrNode = { kind: 'or'; operands: PhaseConditionNode[] };
type ValueNode = ReferenceNode | LiteralNode;
export type PhaseConditionNode = ValueNode | UnaryNode | EqualityNode | OrNode;

type Token =
  | { kind: 'reference'; value: ReferenceNode; offset: number }
  | { kind: 'literal'; value: boolean | string; offset: number }
  | { kind: 'not' | 'equals' | 'not_equals' | 'or'; offset: number };

export function parsePhaseCondition(expression: string): PhaseConditionNode {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw syntaxError(expression, 0, 'expression must not be empty');

  let cursor = 0;
  const peek = (): Token | undefined => tokens[cursor];
  const take = (): Token => tokens[cursor++]!;

  const parseValue = (): ValueNode => {
    const token = peek();
    if (token?.kind === 'reference') {
      take();
      return token.value;
    }
    if (token?.kind === 'literal') {
      take();
      return { kind: 'literal', value: token.value };
    }
    throw syntaxError(expression, token?.offset ?? expression.length, 'expected a runtime reference or literal');
  };

  const parseUnary = (): ValueNode | UnaryNode => {
    const token = peek();
    if (token?.kind === 'not') {
      take();
      return { kind: 'not', operand: parseUnary() };
    }
    return parseValue();
  };

  const parseEquality = (): PhaseConditionNode => {
    const left = parseUnary();
    const operator = peek();
    if (operator?.kind !== 'equals' && operator?.kind !== 'not_equals') return left;
    take();
    const right = parseUnary();
    return {
      kind: 'equality',
      operator: operator.kind === 'equals' ? '==' : '!=',
      left,
      right,
    };
  };

  const operands = [parseEquality()];
  while (peek()?.kind === 'or') {
    take();
    operands.push(parseEquality());
  }
  const trailing = peek();
  if (trailing) {
    throw syntaxError(expression, trailing.offset, `unsupported token ${JSON.stringify(expression[trailing.offset])}`);
  }
  return operands.length === 1 ? operands[0]! : { kind: 'or', operands };
}

export function evaluatePhaseCondition(expression: string, scope: PhaseConditionScope): boolean {
  return Boolean(evaluateNode(parsePhaseCondition(expression), scope));
}

export function phaseConditionUsesContext(expression: string): boolean {
  return nodeUsesContext(parsePhaseCondition(expression));
}

function evaluateNode(node: PhaseConditionNode, scope: PhaseConditionScope): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'reference':
      return resolveReference(node, scope);
    case 'not':
      return !Boolean(evaluateNode(node.operand, scope));
    case 'equality': {
      const equal = evaluateNode(node.left, scope) === evaluateNode(node.right, scope);
      return node.operator === '==' ? equal : !equal;
    }
    case 'or':
      return node.operands.some(operand => Boolean(evaluateNode(operand, scope)));
  }
}

function resolveReference(reference: ReferenceNode, scope: PhaseConditionScope): unknown {
  let value: unknown = scope[reference.root];
  for (const segment of reference.path) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function nodeUsesContext(node: PhaseConditionNode): boolean {
  switch (node.kind) {
    case 'literal':
      return false;
    case 'reference':
      return node.root === 'context';
    case 'not':
      return nodeUsesContext(node.operand);
    case 'equality':
      return nodeUsesContext(node.left) || nodeUsesContext(node.right);
    case 'or':
      return node.operands.some(nodeUsesContext);
  }
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < expression.length) {
    const char = expression[offset]!;
    if (/\s/.test(char)) {
      offset++;
      continue;
    }
    if (expression.startsWith('||', offset)) {
      tokens.push({ kind: 'or', offset });
      offset += 2;
      continue;
    }
    if (expression.startsWith('==', offset)) {
      tokens.push({ kind: 'equals', offset });
      offset += 2;
      continue;
    }
    if (expression.startsWith('!=', offset)) {
      tokens.push({ kind: 'not_equals', offset });
      offset += 2;
      continue;
    }
    if (char === '!') {
      tokens.push({ kind: 'not', offset });
      offset++;
      continue;
    }
    if (char === "'" || char === '"') {
      const literal = readStringLiteral(expression, offset, char);
      tokens.push({ kind: 'literal', value: literal.value, offset });
      offset = literal.nextOffset;
      continue;
    }

    const rest = expression.slice(offset);
    // Preserve the original test-kit path compatibility: authored fixture
    // maps may use numeric-leading keys such as format dimensions (`300x250`).
    const reference = /^(context|test_kit)((?:\.[A-Za-z0-9_]+)+)/.exec(rest);
    if (reference) {
      const full = reference[0]!;
      const next = rest[full.length];
      if (next && /[A-Za-z0-9_.]/.test(next)) {
        throw syntaxError(expression, offset + full.length, 'invalid runtime reference');
      }
      tokens.push({
        kind: 'reference',
        value: {
          kind: 'reference',
          root: reference[1] as 'context' | 'test_kit',
          path: reference[2]!.slice(1).split('.'),
        },
        offset,
      });
      offset += full.length;
      continue;
    }

    const boolean = /^(true|false)\b/.exec(rest);
    if (boolean) {
      tokens.push({ kind: 'literal', value: boolean[1] === 'true', offset });
      offset += boolean[0].length;
      continue;
    }
    throw syntaxError(expression, offset, `unsupported token ${JSON.stringify(char)}`);
  }
  return tokens;
}

function readStringLiteral(expression: string, start: number, quote: "'" | '"'): { value: string; nextOffset: number } {
  let value = '';
  for (let offset = start + 1; offset < expression.length; offset++) {
    const char = expression[offset]!;
    if (char === quote) return { value, nextOffset: offset + 1 };
    if (char === '\\') {
      const escaped = expression[offset + 1];
      if (escaped !== quote && escaped !== '\\') {
        throw syntaxError(expression, offset, 'string literals only support escaped quotes and backslashes');
      }
      value += escaped;
      offset++;
      continue;
    }
    if (char === '\n' || char === '\r') throw syntaxError(expression, offset, 'string literals must stay on one line');
    value += char;
  }
  throw syntaxError(expression, start, 'unterminated string literal');
}

function syntaxError(expression: string, offset: number, detail: string): Error {
  return new Error(`invalid skip_if expression at offset ${offset}: ${detail} (${JSON.stringify(expression)})`);
}
