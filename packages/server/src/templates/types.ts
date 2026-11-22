import type { SchemaOperation } from '../schema-engine/operations.js';

export const TEMPLATE_NAMES = [
  'sales',
  'services',
  'clinic',
  'real_estate',
  'recruiting',
  'starter',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/**
 * A template adds the objects and fields a kind of business needs (3.1). It
 * is copied once into an empty workspace through the schema engine.
 */
export type Template = {
  name: TemplateName;
  /** Bumped when a release changes the template; recorded on the workspace. */
  version: number;
  label: string;
  /** Who the template is for. */
  description: string;
  extends?: TemplateName;
  operations: SchemaOperation[];
};
