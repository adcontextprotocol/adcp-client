import * as z from 'zod';

/** `ZodArray` internals whose input and output carry the checked minimum. */
export interface NonemptyArrayInternals<Element extends z.ZodType> extends z.core.$ZodArrayInternals<Element> {
  output: [z.output<Element>, ...z.output<Element>[]];
  input: [z.input<Element>, ...z.input<Element>[]];
}

/**
 * A normal ZodArray whose checked minimum is reflected in its input/output.
 *
 * Only the internals are narrowed, so inferred types stay as shallow as a
 * plain `z.ZodArray`. Re-declaring the schema as a `z.ZodType` of the tuple
 * instantiated every ZodType member with the full element output and made
 * `z.infer` of large response schemas exceed TypeScript's instantiation depth
 * (TS2589, #3472).
 */
export interface NonemptyArraySchema<Element extends z.ZodType> extends z.ZodArray<Element> {
  _zod: NonemptyArrayInternals<Element>;
}

/**
 * Zod 4's .min(1) retains an array type. Reflect the enforced bound without
 * turning homogeneous wire arrays into JSON Schema prefixItems tuples.
 */
export function nonemptyArray<Element extends z.ZodType>(element: Element): NonemptyArraySchema<Element> {
  return z.array(element).min(1) as unknown as NonemptyArraySchema<Element>;
}
