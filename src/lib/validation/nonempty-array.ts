import * as z from 'zod';

type ArrayBoundMethods = 'min' | 'max' | 'length' | 'nonempty';

/** A normal ZodArray whose checked minimum is reflected in its input/output. */
export interface NonemptyArraySchema<Element extends z.ZodType>
  extends
    Omit<z.ZodArray<Element>, keyof z.ZodType | ArrayBoundMethods>,
    z.ZodType<[z.output<Element>, ...z.output<Element>[]], [z.input<Element>, ...z.input<Element>[]]> {
  min(...args: Parameters<z.ZodArray<Element>['min']>): this;
  max(...args: Parameters<z.ZodArray<Element>['max']>): this;
  length(...args: Parameters<z.ZodArray<Element>['length']>): this;
  nonempty(...args: Parameters<z.ZodArray<Element>['nonempty']>): this;
}

/**
 * Zod 4's .min(1) retains an array type. Reflect the enforced bound without
 * turning homogeneous wire arrays into JSON Schema prefixItems tuples.
 */
export function nonemptyArray<Element extends z.ZodType>(element: Element): NonemptyArraySchema<Element> {
  return z.array(element).min(1) as unknown as NonemptyArraySchema<Element>;
}
